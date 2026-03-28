import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventServer } from "../src/runtime/event-server.js";
import type { PulSeedEvent } from "../src/types/drive.js";
import { makeTempDir } from "./helpers/temp-dir.js";

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
  const s = new EventServer(driveSystem as never, { port: 0 });
  await s.start();
  return { server: s, port: s.getPort() };
}

function postEvent(
  port: number,
  body: unknown
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
  body?: unknown
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const headers: http.OutgoingHttpHeaders = {
      "Content-Type": "application/json",
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
  server = new EventServer(mockDriveSystem as never, { port: 0 });
  // port will be set after start() for tests that need it; for tests that
  // call start() themselves they must read server.getPort() afterward.
  port = 0;
});

afterEach(async () => {
  if (server.isRunning()) {
    await server.stop();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
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

    const server2 = new EventServer(mockDriveSystem as never, { port: 0 });
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
