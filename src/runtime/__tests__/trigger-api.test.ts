import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventServer } from "../event-server.js";
import type { PulSeedEvent } from "../../base/types/drive.js";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";

// ─── Helpers ───

const createMockDriveSystem = (tmpDir: string) => ({
  writeEvent: vi.fn().mockImplementation(async (event: PulSeedEvent) => {
    const eventsDir = path.join(tmpDir, "events");
    fs.mkdirSync(eventsDir, { recursive: true });
    const file = path.join(
      eventsDir,
      `test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`
    );
    fs.writeFileSync(file, JSON.stringify(event), "utf-8");
  }),
});

function makeRequest(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
  authToken: string | null | undefined = server?.getAuthToken()
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const headers: http.OutgoingHttpHeaders = {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    };
    if (data.length > 0) headers["Content-Length"] = Buffer.byteLength(data);
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        let buf = "";
        res.on("data", (chunk) => (buf += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body: buf }));
      }
    );
    req.on("error", reject);
    if (data.length > 0) req.write(data);
    req.end();
  });
}

// ─── Setup ───

let tmpDir: string;
let mockDriveSystem: ReturnType<typeof createMockDriveSystem>;
let server: EventServer;
let port: number;

beforeEach(async () => {
  tmpDir = makeTempDir();
  // Create the events dir so EventServer can resolve trigger-mappings.json
  fs.mkdirSync(path.join(tmpDir, "events"), { recursive: true });
  mockDriveSystem = createMockDriveSystem(tmpDir);
  server = new EventServer(mockDriveSystem as never, {
    port: 0,
    eventsDir: path.join(tmpDir, "events"),
  });
  await server.start();
  port = server.getPort();
});

afterEach(async () => {
  if (server.isRunning()) await server.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
});

// ─── POST /triggers ───

describe("POST /triggers — with matching mapping", () => {
  beforeEach(() => {
    const mappings = {
      mappings: [
        {
          source: "github",
          event_type: "push",
          action: "observe",
          goal_id: "goal-123",
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "trigger-mappings.json"),
      JSON.stringify(mappings),
      "utf-8"
    );
    server.invalidateTriggerMappingsCache();
  });

  it("returns 200 with status ok", async () => {
    const res = await makeRequest(port, "POST", "/triggers", {
      source: "github",
      event_type: "push",
      data: { ref: "refs/heads/main" },
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed["status"]).toBe("ok");
    expect(parsed["action"]).toBe("observe");
    expect(parsed["goal_id"]).toBe("goal-123");
  });

  it("dispatches observe action via driveSystem.writeEvent", async () => {
    await makeRequest(port, "POST", "/triggers", {
      source: "github",
      event_type: "push",
      data: {},
    });
    // writeEvent is fire-and-forget; wait briefly
    await new Promise((r) => setTimeout(r, 50));
    expect(mockDriveSystem.writeEvent).toHaveBeenCalled();
  });

  it("waits for observe ingress hook acceptance before returning success", async () => {
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
    const request = makeRequest(port, "POST", "/triggers", {
      source: "github",
      event_type: "push",
      data: {},
    }).then((result) => {
      settled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hookStarted).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    expect(releaseHook).not.toBeNull();
    releaseHook!();
    const res = await request;

    expect(res.status).toBe(200);
    expect(mockDriveSystem.writeEvent).not.toHaveBeenCalled();
  });
});

describe("POST /triggers — no matching mapping", () => {
  it("returns status no_mapping when no mapping and no goal_id", async () => {
    server.invalidateTriggerMappingsCache();
    const res = await makeRequest(port, "POST", "/triggers", {
      source: "ci",
      event_type: "build_failed",
      data: {},
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed["status"]).toBe("no_mapping");
  });

  it("defaults to observe action when no mapping but goal_id provided", async () => {
    server.invalidateTriggerMappingsCache();
    const res = await makeRequest(port, "POST", "/triggers", {
      source: "ci",
      event_type: "build_failed",
      data: {},
      goal_id: "goal-456",
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed["status"]).toBe("ok");
    expect(parsed["action"]).toBe("observe");
    expect(parsed["goal_id"]).toBe("goal-456");
  });
});

describe("POST /triggers — invalid body", () => {
  it("returns 400 for invalid trigger body (bad source)", async () => {
    const res = await makeRequest(port, "POST", "/triggers", {
      source: "unknown_source",
      event_type: "push",
      data: {},
    });
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed).toHaveProperty("error");
  });

  it("returns 400 for missing required fields", async () => {
    const res = await makeRequest(port, "POST", "/triggers", { data: {} });
    expect(res.status).toBe(400);
  });
});

// ─── GET /goals ───

describe("GET /goals", () => {
  it("returns empty array when no goals directory", async () => {
    const res = await makeRequest(port, "GET", "/goals");
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("returns goal list with basic status fields", async () => {
    const goalsDir = path.join(tmpDir, "goals", "goal-abc");
    fs.mkdirSync(goalsDir, { recursive: true });
    fs.writeFileSync(
      path.join(goalsDir, "goal.json"),
      JSON.stringify({
        id: "goal-abc",
        title: "Test Goal",
        status: "active",
        loop_status: "running",
      }),
      "utf-8"
    );

    const res = await makeRequest(port, "GET", "/goals");
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Array<Record<string, unknown>>;
    expect(parsed.length).toBeGreaterThan(0);
    const goal = parsed.find((g) => g["id"] === "goal-abc");
    expect(goal).toBeDefined();
    expect(goal!["title"]).toBe("Test Goal");
    expect(goal!["status"]).toBe("active");
    expect(goal!["loop_status"]).toBe("running");
  });
});

// ─── GET /goals/:id ───

describe("GET /goals/:id", () => {
  it("returns goal details for existing goal", async () => {
    const goalsDir = path.join(tmpDir, "goals", "goal-xyz");
    fs.mkdirSync(goalsDir, { recursive: true });
    const goalData = {
      id: "goal-xyz",
      title: "My Detailed Goal",
      status: "active",
      loop_status: "idle",
      dimensions: [],
    };
    fs.writeFileSync(path.join(goalsDir, "goal.json"), JSON.stringify(goalData), "utf-8");

    const res = await makeRequest(port, "GET", "/goals/goal-xyz");
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed["id"]).toBe("goal-xyz");
    expect(parsed["title"]).toBe("My Detailed Goal");
    expect(parsed).toHaveProperty("current_gap");
  });

  it("includes current_gap from gap-history when available", async () => {
    const goalsDir = path.join(tmpDir, "goals", "goal-gap");
    fs.mkdirSync(goalsDir, { recursive: true });
    fs.writeFileSync(
      path.join(goalsDir, "goal.json"),
      JSON.stringify({ id: "goal-gap", title: "Gap Goal", status: "active", loop_status: "idle" }),
      "utf-8"
    );
    const gapEntry = { gap: 0.42, timestamp: new Date().toISOString() };
    fs.writeFileSync(
      path.join(goalsDir, "gap-history.json"),
      JSON.stringify([gapEntry]),
      "utf-8"
    );

    const res = await makeRequest(port, "GET", "/goals/goal-gap");
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    const gap = parsed["current_gap"] as Record<string, unknown>;
    expect(gap["gap"]).toBe(0.42);
  });

  it("returns 404 for non-existent goal", async () => {
    const res = await makeRequest(port, "GET", "/goals/nonexistent-id");
    expect(res.status).toBe(404);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed).toHaveProperty("error");
  });
});

// ─── Trigger mapping file loading ───

describe("trigger mapping file loading", () => {
  it("loads valid mappings file", async () => {
    const mappings = {
      mappings: [
        { source: "slack", event_type: "mention", action: "notify" },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "trigger-mappings.json"),
      JSON.stringify(mappings),
      "utf-8"
    );
    server.invalidateTriggerMappingsCache();

    const res = await makeRequest(port, "POST", "/triggers", {
      source: "slack",
      event_type: "mention",
      data: {},
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed["action"]).toBe("notify");
  });

  it("returns no_mapping when mappings file is missing", async () => {
    server.invalidateTriggerMappingsCache();
    const res = await makeRequest(port, "POST", "/triggers", {
      source: "custom",
      event_type: "any_event",
      data: {},
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed["status"]).toBe("no_mapping");
  });

  it("returns no_mapping when mappings file is malformed JSON", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "trigger-mappings.json"),
      "{ not valid json ::::",
      "utf-8"
    );
    server.invalidateTriggerMappingsCache();

    const res = await makeRequest(port, "POST", "/triggers", {
      source: "custom",
      event_type: "any_event",
      data: {},
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed["status"]).toBe("no_mapping");
  });
});
