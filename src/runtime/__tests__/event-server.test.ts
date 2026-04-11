import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventServer } from "../event-server.js";
import type { PulSeedEvent } from "../../base/types/drive.js";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";
import { OutboxStore } from "../store/outbox-store.js";

// ─── Helpers ───

const createMockDriveSystem = (tmpDir: string) => ({
  writeEvent: vi.fn().mockImplementation(async (event: PulSeedEvent) => {
    const eventsDir = path.join(tmpDir, "events");
    fs.mkdirSync(eventsDir, { recursive: true });
    const file = path.join(eventsDir, `test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(event), "utf-8");
  }),
});

/** Start an EventServer on an OS-assigned port (no TOCTOU race). */
async function startWithRetry(
  driveSystem: ReturnType<typeof createMockDriveSystem>
): Promise<{ server: EventServer; port: number }> {
  const s = new EventServer(driveSystem as never, { port: 0, eventsDir: path.join(tmpDir, "events") });
  await s.start();
  return { server: s, port: s.getPort() };
}

function postEvent(
  port: number,
  body: unknown,
  authToken: string | null | undefined = server?.getAuthToken()
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/events",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...authHeaders(authToken),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function makeRequest(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
  authToken: string | null | undefined = server?.getAuthToken(),
  extraHeaders: http.OutgoingHttpHeaders = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const headers: http.OutgoingHttpHeaders = {
      "Content-Type": "application/json",
      ...authHeaders(authToken),
      ...extraHeaders,
    };
    if (data.length > 0) {
      headers["Content-Length"] = Buffer.byteLength(data);
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      }
    );
    req.on("error", reject);
    if (data.length > 0) req.write(data);
    req.end();
  });
}

function collectSseEvents(
  port: number,
  urlPath: string,
  eventType: string,
  expectedCount: number,
  authToken: string | null | undefined = server?.getAuthToken()
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const received: unknown[] = [];
    let settled = false;
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        headers: { Accept: "text/event-stream", ...authHeaders(authToken) },
      },
      (res) => {
        let buffer = "";
        const timeout = setTimeout(() => {
          settled = true;
          req.destroy();
          reject(new Error(`Timed out waiting for ${expectedCount} SSE events: ${eventType}`));
        }, 2000);

        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          const messages = buffer.split("\n\n");
          buffer = messages.pop() ?? "";

          for (const message of messages) {
            let currentEvent = "message";
            let data = "";
            for (const line of message.split("\n")) {
              if (line.startsWith("event: ")) {
                currentEvent = line.slice(7);
              } else if (line.startsWith("data: ")) {
                data += line.slice(6);
              }
            }

            if (currentEvent !== eventType) continue;

            try {
              received.push(JSON.parse(data));
            } catch {
              received.push(data);
            }

            if (received.length >= expectedCount) {
              clearTimeout(timeout);
              settled = true;
              req.destroy();
              resolve(received);
              return;
            }
          }
        });
      }
    );
    req.on("error", (err) => {
      if (!settled) {
        reject(err);
      }
    });
  });
}

function authHeaders(authToken: string | null | undefined): http.OutgoingHttpHeaders {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

const validEvent: PulSeedEvent = {
  type: "external",
  source: "test-source",
  timestamp: new Date().toISOString(),
  data: { key: "value" },
};

// ─── Test setup ───

let tmpDir: string;
let mockDriveSystem: ReturnType<typeof createMockDriveSystem>;
let server: EventServer;
let port: number;

beforeEach(async () => {
  tmpDir = makeTempDir();
  mockDriveSystem = createMockDriveSystem(tmpDir);
  server = new EventServer(mockDriveSystem as never, { port: 0, eventsDir: path.join(tmpDir, "events") });
  // port will be set after start() for tests that need it; for tests that
  // call start() themselves they must read server.getPort() afterward.
  port = 0;
});

afterEach(async () => {
  if (server.isRunning()) {
    await server.stop();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
});

// ─── start / stop ───

describe("start / stop", () => {
  it("isRunning() returns false before start", () => {
    expect(server.isRunning()).toBe(false);
  });

  it("isRunning() returns true after start", async () => {
    await server.start();
    expect(server.isRunning()).toBe(true);
  });

  it("isRunning() returns false after stop", async () => {
    await server.start();
    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it("stop() is idempotent when server is not started", async () => {
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it("getPort() returns the configured port", () => {
    expect(server.getPort()).toBe(port);
  });

  it("getHost() returns the configured host", () => {
    expect(server.getHost()).toBe("127.0.0.1");
  });

  it("can start and stop multiple times sequentially", async () => {
    await server.start();
    await server.stop();

    const server2 = new EventServer(mockDriveSystem as never, { port: 0, eventsDir: path.join(tmpDir, "events") });
    await server2.start();
    expect(server2.isRunning()).toBe(true);
    await server2.stop();
    expect(server2.isRunning()).toBe(false);
  });
});

// ─── POST /events — valid event ───

describe("POST /events — valid event", () => {
  beforeEach(async () => {
    await server.start();
    port = server.getPort();
  });

  it("returns 200 for a valid event", async () => {
    const result = await postEvent(port, validEvent);
    expect(result.status).toBe(200);
  });

  it("response body contains status=accepted", async () => {
    const result = await postEvent(port, validEvent);
    const parsed = JSON.parse(result.body);
    expect(parsed.status).toBe("accepted");
  });

  it("response body contains event_type", async () => {
    const result = await postEvent(port, validEvent);
    const parsed = JSON.parse(result.body);
    expect(parsed.event_type).toBe("external");
  });

  it("calls driveSystem.writeEvent with the parsed event", async () => {
    await postEvent(port, validEvent);
    expect(mockDriveSystem.writeEvent).toHaveBeenCalledOnce();
    const called = mockDriveSystem.writeEvent.mock.calls[0][0] as PulSeedEvent;
    expect(called.type).toBe("external");
    expect(called.source).toBe("test-source");
  });

  it("writes event file to temp events dir", async () => {
    await postEvent(port, validEvent);
    // writeEvent is fire-and-forget in the HTTP handler, so wait briefly
    await new Promise((r) => setTimeout(r, 50));
    const eventsDir = path.join(tmpDir, "events");
    expect(fs.existsSync(eventsDir)).toBe(true);
    const files = fs.readdirSync(eventsDir);
    expect(files.length).toBeGreaterThan(0);
    const content = JSON.parse(
      fs.readFileSync(path.join(eventsDir, files[0]), "utf-8")
    );
    expect(content.type).toBe("external");
  });

  it("accepts internal event type", async () => {
    const internalEvent: PulSeedEvent = {
      type: "internal",
      source: "core-loop",
      timestamp: new Date().toISOString(),
      data: { reason: "stall" },
    };
    const result = await postEvent(port, internalEvent);
    expect(result.status).toBe(200);
    expect(mockDriveSystem.writeEvent).toHaveBeenCalledOnce();
  });

  it("handles multiple events in sequence", async () => {
    for (let i = 0; i < 3; i++) {
      const result = await postEvent(port, {
        ...validEvent,
        data: { index: i },
      });
      expect(result.status).toBe(200);
    }
    expect(mockDriveSystem.writeEvent).toHaveBeenCalledTimes(3);
  });

  it("waits for an async envelopeHook before sending the accepted response", async () => {
    let releaseHook: (() => void) | null = null;
    const hookStarted = vi.fn();
    server.setEnvelopeHook(
      () =>
        new Promise<void>((resolve) => {
          hookStarted();
          releaseHook = resolve;
        })
    );

    let settled = false;
    const request = postEvent(port, validEvent).then((result) => {
      settled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hookStarted).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    expect(releaseHook).not.toBeNull();
    releaseHook!();
    const result = await request;

    expect(result.status).toBe(200);
    expect(settled).toBe(true);
    expect(mockDriveSystem.writeEvent).not.toHaveBeenCalled();
  });
});

// ─── POST /events — invalid data ───

describe("POST /events — invalid data", () => {
  beforeEach(async () => {
    await server.start();
    port = server.getPort();
  });

  it("returns 400 for invalid JSON body", async () => {
    const result = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const data = "not-valid-json{{{";
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/events",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(data),
              Authorization: `Bearer ${server.getAuthToken()}`,
            },
          },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode!, body }));
          }
        );
        req.on("error", reject);
        req.write(data);
        req.end();
      }
    );
    expect(result.status).toBe(400);
  });

  it("returns 400 when event type is missing", async () => {
    const result = await postEvent(port, {
      source: "test",
      timestamp: new Date().toISOString(),
      data: {},
      // type is missing
    });
    expect(result.status).toBe(400);
  });

  it("returns 400 when event type is invalid", async () => {
    const result = await postEvent(port, {
      type: "invalid-type",
      source: "test",
      timestamp: new Date().toISOString(),
      data: {},
    });
    expect(result.status).toBe(400);
  });

  it("returns 400 for empty body", async () => {
    const result = await postEvent(port, {});
    expect(result.status).toBe(400);
  });

  it("error response body contains error field", async () => {
    const result = await postEvent(port, { type: "bad" });
    const parsed = JSON.parse(result.body);
    expect(parsed).toHaveProperty("error");
  });

  it("does not call writeEvent on invalid event", async () => {
    await postEvent(port, { type: "invalid" });
    expect(mockDriveSystem.writeEvent).not.toHaveBeenCalled();
  });
});

// ─── Routing — wrong method or path ───

describe("routing — wrong method or path", () => {
  beforeEach(async () => {
    // Re-acquire port to avoid EADDRINUSE from prior test teardown race
    ({ server, port } = await startWithRetry(mockDriveSystem));
  });

  it("GET /events returns 404", async () => {
    const result = await makeRequest(port, "GET", "/events");
    expect(result.status).toBe(404);
  });

  it("POST /other-path returns 404", async () => {
    const result = await makeRequest(port, "POST", "/other-path", validEvent);
    expect(result.status).toBe(404);
  });

  it("PUT /events returns 404", async () => {
    const result = await makeRequest(port, "PUT", "/events", validEvent);
    expect(result.status).toBe(404);
  });

  it("DELETE /events returns 404", async () => {
    const result = await makeRequest(port, "DELETE", "/events");
    expect(result.status).toBe(404);
  });

  it("404 response body contains error field", async () => {
    const result = await makeRequest(port, "GET", "/events");
    const parsed = JSON.parse(result.body);
    expect(parsed).toHaveProperty("error");
  });

  it("404 responses do not call writeEvent", async () => {
    await makeRequest(port, "GET", "/events");
    await makeRequest(port, "POST", "/wrong", validEvent);
    expect(mockDriveSystem.writeEvent).not.toHaveBeenCalled();
  });
});

describe("daemon HTTP auth guard", () => {
  beforeEach(async () => {
    await server.start();
    port = server.getPort();
  });

  it("writes a per-daemon token file next to the events directory", () => {
    const tokenPath = path.join(tmpDir, "daemon-token.json");
    const tokenFile = JSON.parse(fs.readFileSync(tokenPath, "utf-8")) as {
      token?: string;
      port?: number;
    };

    expect(tokenFile.token).toBe(server.getAuthToken());
    expect(tokenFile.port).toBe(port);
  });

  it("keeps /health available without auth", async () => {
    const result = await makeRequest(port, "GET", "/health", undefined, null);
    expect(result.status).toBe(200);
  });

  it("rejects state-changing POST requests without a bearer token", async () => {
    const result = await postEvent(port, validEvent, null);
    expect(result.status).toBe(401);
    expect(mockDriveSystem.writeEvent).not.toHaveBeenCalled();
  });

  it("rejects browser cross-site requests even with a valid bearer token", async () => {
    const result = await makeRequest(
      port,
      "POST",
      "/goals/g-1/start",
      {},
      server.getAuthToken(),
      {
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site",
      }
    );

    expect(result.status).toBe(403);
  });

  it("rejects non-JSON POST requests", async () => {
    const result = await makeRequest(
      port,
      "POST",
      "/goals/g-1/start",
      {},
      server.getAuthToken(),
      { "Content-Type": "text/plain" }
    );

    expect(result.status).toBe(415);
  });

  it("rejects unauthenticated SSE and does not emit wildcard CORS", async () => {
    const result = await new Promise<{ status: number; cors: string | undefined }>((resolve, reject) => {
      const req = http.get(
        {
          hostname: "127.0.0.1",
          port,
          path: "/stream",
          headers: { Accept: "text/event-stream" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({
            status: res.statusCode ?? 0,
            cors: res.headers["access-control-allow-origin"] as string | undefined,
          }));
        }
      );
      req.on("error", reject);
    });

    expect(result.status).toBe(401);
    expect(result.cors).toBeUndefined();
  });
});

describe("goal action commands", () => {
  beforeEach(async () => {
    await server.start();
    port = server.getPort();
  });

  it("waits for command hook accept before returning startGoal success", async () => {
    let releaseHook: (() => void) | null = null;
    const hookStarted = vi.fn();
    server.setCommandEnvelopeHook(
      () =>
        new Promise<void>((resolve) => {
          hookStarted();
          releaseHook = resolve;
        })
    );

    let settled = false;
    const request = makeRequest(port, "POST", "/goals/g-1/start", {}).then((result) => {
      settled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hookStarted).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    expect(releaseHook).not.toBeNull();
    releaseHook!();
    const result = await request;

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true, goalId: "g-1" });
  });

  it("sends chat messages through the command hook as command envelopes", async () => {
    const seen: Array<Record<string, unknown>> = [];
    server.setCommandEnvelopeHook((envelope) => {
      seen.push(envelope as unknown as Record<string, unknown>);
    });

    const result = await makeRequest(port, "POST", "/goals/g-1/chat", {
      message: "hello runtime",
    });

    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(
      expect.objectContaining({
        type: "command",
        name: "chat_message",
        source: "http",
        goal_id: "g-1",
        payload: { goalId: "g-1", message: "hello runtime" },
      })
    );
  });

  it("rejects approval responses for unknown requests before command accept", async () => {
    const hook = vi.fn();
    server.setCommandEnvelopeHook(hook);

    const result = await makeRequest(port, "POST", "/goals/g-1/approve", {
      requestId: "missing-request",
      approved: true,
    });

    expect(result.status).toBe(404);
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("snapshot and outbox replay", () => {
  it("returns snapshot metadata with the latest outbox sequence", async () => {
    const outboxStore = new OutboxStore(tmpDir);
    server = new EventServer(mockDriveSystem as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
      outboxStore,
    });

    await server.start();
    await server.broadcast("goal_start_requested", { goalId: "goal-1" });
    await server.broadcast("chat_message_received", { goalId: "goal-1", message: "hello" });

    const result = await makeRequest(server.getPort(), "GET", "/snapshot");
    expect(result.status).toBe(200);

    const snapshot = JSON.parse(result.body) as {
      daemon: unknown;
      goals: unknown[];
      approvals: unknown[];
      active_workers: unknown[];
      last_outbox_seq: number;
    };
    expect(snapshot.daemon).toBeNull();
    expect(snapshot.goals).toEqual([]);
    expect(snapshot.approvals).toEqual([]);
    expect(snapshot.active_workers).toEqual([]);
    expect(snapshot.last_outbox_seq).toBe(2);
  });

  it("includes active worker summaries in snapshot when a provider is registered", async () => {
    server = new EventServer(mockDriveSystem as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
    });
    server.setActiveWorkersProvider(() => [
      {
        worker_id: "worker-1",
        goal_id: "goal-1",
        started_at: 123,
        iterations: 0,
      },
    ]);

    await server.start();

    const result = await makeRequest(server.getPort(), "GET", "/snapshot");
    expect(result.status).toBe(200);

    const snapshot = JSON.parse(result.body) as { active_workers: unknown[] };
    expect(snapshot.active_workers).toEqual([
      {
        worker_id: "worker-1",
        goal_id: "goal-1",
        started_at: 123,
        iterations: 0,
      },
    ]);
  });

  it("replays outbox events after the requested sequence", async () => {
    const outboxStore = new OutboxStore(tmpDir);
    server = new EventServer(mockDriveSystem as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
      outboxStore,
    });

    await server.start();
    await server.broadcast("goal_start_requested", { goalId: "goal-1" });
    await server.broadcast("chat_message_received", { goalId: "goal-1", message: "hello" });

    const events = await collectSseEvents(
      server.getPort(),
      "/stream?after=1",
      "chat_message_received",
      1
    );

    expect(events).toEqual([{ goalId: "goal-1", message: "hello" }]);
  });
});
