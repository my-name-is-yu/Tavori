/**
 * Phase B Integration E2E Tests
 *
 * Covers integration between:
 * - HookManager: pre/post observe hooks with execution order and error isolation
 * - Remote Trigger API: POST trigger → creates event → GET goals returns states
 * - MCP DataSource: MCPDataSourceAdapter querying a mock MCP connection
 * - Hook + EventServer integration: trigger fires → hook intercepts
 * - EventServer lifecycle: start → handle requests → graceful shutdown
 *
 * Real classes used where possible.
 * Only LLM calls and actual network I/O (MCP transport) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as fsp from "node:fs/promises";

import { HookManager } from "../../src/runtime/hook-manager.js";
import { EventServer } from "../../src/runtime/event-server.js";
import { MCPClientManager } from "../../src/adapters/mcp-client-manager.js";
import { MCPDataSourceAdapter } from "../../src/adapters/datasources/mcp-datasource.js";
import type { HookConfig } from "../../src/base/types/hook.js";
import type { IMCPConnection, MCPServerConfig } from "../../src/base/types/mcp.js";
import type { PulSeedEvent } from "../../src/base/types/drive.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp-dir.js";

// ─── Shared helpers ───

const eventServerAuthTokens = new Map<number, string>();

function writeHooksJson(dir: string, hooks: HookConfig[]): void {
  fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({ hooks }), "utf-8");
}

function makeMockDriveSystem(tmpDir: string) {
  return {
    writeEvent: vi.fn().mockImplementation(async (event: PulSeedEvent) => {
      const eventsDir = path.join(tmpDir, "events");
      fs.mkdirSync(eventsDir, { recursive: true });
      const file = path.join(
        eventsDir,
        `test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`
      );
      fs.writeFileSync(file, JSON.stringify(event), "utf-8");
    }),
  };
}

function makeHttpRequest(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
  authToken?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const resolvedAuthToken = authToken ?? eventServerAuthTokens.get(port);
    const headers: http.OutgoingHttpHeaders = {
      "Content-Type": "application/json",
      ...(resolvedAuthToken ? { Authorization: `Bearer ${resolvedAuthToken}` } : {}),
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

function rememberEventServerAuth(server: EventServer): void {
  eventServerAuthTokens.set(server.getPort(), server.getAuthToken());
}

function makeMockMCPConnection(overrides: Partial<IMCPConnection> = {}): IMCPConnection {
  let connected = false;
  return {
    async connect() { connected = true; },
    async close() { connected = false; },
    isConnected() { return connected; },
    async listTools() { return [{ name: "get_metric" }]; },
    async callTool(_name: string, _args: Record<string, unknown>) {
      return { content: [{ type: "text", text: "42" }] };
    },
    ...overrides,
  };
}

function makeServerConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id: "test-server",
    name: "Test MCP Server",
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    tool_mappings: [{ tool_name: "get_metric", dimension_pattern: "metric_*" }],
    enabled: true,
    ...overrides,
  };
}

// ─── Group 1: HookManager — pre/post observe hooks execution order ───

describe("Phase B — HookManager: pre/post observe hooks execution order", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("phase-b-hook-order-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("fires PreObserve hook before PostObserve hook in sequence", async () => {
    const firedOrder: string[] = [];
    const preOutputFile = path.join(tempDir, "pre-fired.txt");
    const postOutputFile = path.join(tempDir, "post-fired.txt");

    const hooks: HookConfig[] = [
      {
        event: "PreObserve",
        type: "shell",
        command: `echo pre >> ${preOutputFile}`,
        timeout_ms: 5000,
        enabled: true,
      },
      {
        event: "PostObserve",
        type: "shell",
        command: `echo post >> ${postOutputFile}`,
        timeout_ms: 5000,
        enabled: true,
      },
    ];
    writeHooksJson(tempDir, hooks);

    const manager = new HookManager(tempDir);
    await manager.loadHooks();

    // Emit PreObserve first, then PostObserve
    await manager.emit("PreObserve", { goal_id: "goal-1" });
    // Allow the fire-and-forget shell hooks to complete
    await new Promise((r) => setTimeout(r, 400));

    await manager.emit("PostObserve", { goal_id: "goal-1" });
    await new Promise((r) => setTimeout(r, 400));

    // Both files should have been written
    expect(fs.existsSync(preOutputFile)).toBe(true);
    expect(fs.existsSync(postOutputFile)).toBe(true);

    const preContent = fs.readFileSync(preOutputFile, "utf-8").trim();
    const postContent = fs.readFileSync(postOutputFile, "utf-8").trim();
    expect(preContent).toContain("pre");
    expect(postContent).toContain("post");
  });

  it("fires multiple hooks for the same event in parallel", async () => {
    const outputFile1 = path.join(tempDir, "hook1.txt");
    const outputFile2 = path.join(tempDir, "hook2.txt");

    const hooks: HookConfig[] = [
      {
        event: "PostObserve",
        type: "shell",
        command: `echo hook1 > ${outputFile1}`,
        timeout_ms: 5000,
        enabled: true,
      },
      {
        event: "PostObserve",
        type: "shell",
        command: `echo hook2 > ${outputFile2}`,
        timeout_ms: 5000,
        enabled: true,
      },
    ];
    writeHooksJson(tempDir, hooks);

    const manager = new HookManager(tempDir);
    await manager.loadHooks();

    await manager.emit("PostObserve", { goal_id: "goal-1", data: { coverage: 0.85 } });
    await new Promise((r) => setTimeout(r, 500));

    expect(fs.existsSync(outputFile1)).toBe(true);
    expect(fs.existsSync(outputFile2)).toBe(true);
  });

  it("delivers goal_id and data in hook payload", async () => {
    const outputFile = path.join(tempDir, "payload.json");

    const hooks: HookConfig[] = [
      {
        event: "PostTaskCreate",
        type: "shell",
        command: `cat > ${outputFile}`,
        timeout_ms: 5000,
        enabled: true,
      },
    ];
    writeHooksJson(tempDir, hooks);

    const manager = new HookManager(tempDir);
    await manager.loadHooks();

    await manager.emit("PostTaskCreate", {
      goal_id: "goal-42",
      data: { task_id: "task-99", action: "observe" },
    });
    await new Promise((r) => setTimeout(r, 400));

    expect(fs.existsSync(outputFile)).toBe(true);
    const payload = JSON.parse(fs.readFileSync(outputFile, "utf-8"));
    expect(payload.event).toBe("PostTaskCreate");
    expect(payload.goal_id).toBe("goal-42");
    expect(payload.data.task_id).toBe("task-99");
  });
});

// ─── Group 2: HookManager — error isolation ───

describe("Phase B — HookManager: hook failure does not break caller", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("phase-b-hook-error-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("shell hook that exits with non-zero does not throw", async () => {
    const hooks: HookConfig[] = [
      {
        event: "LoopCycleEnd",
        type: "shell",
        command: "exit 1",
        timeout_ms: 5000,
        enabled: true,
      },
    ];
    writeHooksJson(tempDir, hooks);

    const manager = new HookManager(tempDir);
    await manager.loadHooks();

    await expect(manager.emit("LoopCycleEnd", { goal_id: "g1" })).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    // If we reach here, error was isolated
  });

  it("failing hook does not prevent a second hook on the same event from running", async () => {
    const successOutputFile = path.join(tempDir, "success.txt");

    const hooks: HookConfig[] = [
      {
        event: "LoopCycleStart",
        type: "shell",
        command: "exit 1", // will fail
        timeout_ms: 5000,
        enabled: true,
      },
      {
        event: "LoopCycleStart",
        type: "shell",
        command: `echo ok > ${successOutputFile}`, // should still run
        timeout_ms: 5000,
        enabled: true,
      },
    ];
    writeHooksJson(tempDir, hooks);

    const manager = new HookManager(tempDir);
    await manager.loadHooks();

    await expect(manager.emit("LoopCycleStart", { goal_id: "g1" })).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 500));

    // Second hook still ran despite first failing
    expect(fs.existsSync(successOutputFile)).toBe(true);
    const content = fs.readFileSync(successOutputFile, "utf-8").trim();
    expect(content).toBe("ok");
  });

  it("shell hook that times out does not throw", async () => {
    const hooks: HookConfig[] = [
      {
        event: "ReflectionComplete",
        type: "shell",
        command: "sleep 10", // will timeout
        timeout_ms: 100, // very short timeout
        enabled: true,
      },
    ];
    writeHooksJson(tempDir, hooks);

    const manager = new HookManager(tempDir);
    await manager.loadHooks();

    await expect(
      manager.emit("ReflectionComplete", { goal_id: "g1" })
    ).resolves.toBeUndefined();

    // Wait for the timeout to fire
    await new Promise((r) => setTimeout(r, 300));
  });

  it("disabled hook is completely skipped — no process spawned", async () => {
    const outputFile = path.join(tempDir, "should-not-exist.txt");

    const hooks: HookConfig[] = [
      {
        event: "GoalStateChange",
        type: "shell",
        command: `echo ran > ${outputFile}`,
        timeout_ms: 5000,
        enabled: false,
      },
    ];
    writeHooksJson(tempDir, hooks);

    const manager = new HookManager(tempDir);
    await manager.loadHooks();

    await manager.emit("GoalStateChange", { goal_id: "g1" });
    await new Promise((r) => setTimeout(r, 200));

    // File should NOT exist because hook was disabled
    expect(fs.existsSync(outputFile)).toBe(false);
  });
});

// ─── Group 3: Remote Trigger API — POST trigger and GET goals ───

describe("Phase B — Remote Trigger API: POST trigger creates event", () => {
  let tmpDir: string;
  let mockDriveSystem: ReturnType<typeof makeMockDriveSystem>;
  let server: EventServer;
  let port: number;

  beforeEach(async () => {
    tmpDir = makeTempDir("phase-b-trigger-");
    fs.mkdirSync(path.join(tmpDir, "events"), { recursive: true });
    mockDriveSystem = makeMockDriveSystem(tmpDir);
    server = new EventServer(mockDriveSystem as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
    });
    await server.start();
    port = server.getPort();
    rememberEventServerAuth(server);
  });

  afterEach(async () => {
    if (server.isRunning()) await server.stop();
    cleanupTempDir(tmpDir);
  });

  it("POST /triggers with a mapped source dispatches observe event to driveSystem", async () => {
    // Write a trigger mapping
    const mappings = {
      mappings: [
        { source: "github", event_type: "push", action: "observe", goal_id: "goal-push" },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "trigger-mappings.json"),
      JSON.stringify(mappings),
      "utf-8"
    );
    server.invalidateTriggerMappingsCache();

    const res = await makeHttpRequest(port, "POST", "/triggers", {
      source: "github",
      event_type: "push",
      data: { ref: "refs/heads/main", sha: "abc123" },
    });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed["status"]).toBe("ok");
    expect(parsed["action"]).toBe("observe");
    expect(parsed["goal_id"]).toBe("goal-push");

    // writeEvent is fire-and-forget; give it a moment to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(mockDriveSystem.writeEvent).toHaveBeenCalledOnce();
  });

  it("POST /triggers with ci/build_failed and explicit goal_id defaults to observe", async () => {
    server.invalidateTriggerMappingsCache();

    const res = await makeHttpRequest(port, "POST", "/triggers", {
      source: "ci",
      event_type: "build_failed",
      data: { build_id: "build-007" },
      goal_id: "goal-ci-watch",
    });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed["status"]).toBe("ok");
    expect(parsed["action"]).toBe("observe");
    expect(parsed["goal_id"]).toBe("goal-ci-watch");
  });

  it("POST /triggers with create_task action writes a task event file", async () => {
    const mappings = {
      mappings: [
        { source: "cron", event_type: "daily", action: "create_task", goal_id: "goal-daily" },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "trigger-mappings.json"),
      JSON.stringify(mappings),
      "utf-8"
    );
    server.invalidateTriggerMappingsCache();

    const res = await makeHttpRequest(port, "POST", "/triggers", {
      source: "cron",
      event_type: "daily",
      data: {},
    });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed["status"]).toBe("ok");
    expect(parsed["action"]).toBe("create_task");

    // A task event file should have been written to the events directory
    await new Promise((r) => setTimeout(r, 100));
    const eventsDir = path.join(tmpDir, "events");
    const files = fs.readdirSync(eventsDir).filter((f) => f.startsWith("trigger_"));
    expect(files.length).toBeGreaterThan(0);
  });

  it("POST /triggers returns 400 for an invalid source value", async () => {
    const res = await makeHttpRequest(port, "POST", "/triggers", {
      source: "unknown_source",
      event_type: "push",
      data: {},
    });
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed).toHaveProperty("error");
  });

  it("POST /triggers returns no_mapping when source is unmapped and no goal_id", async () => {
    server.invalidateTriggerMappingsCache();

    const res = await makeHttpRequest(port, "POST", "/triggers", {
      source: "custom",
      event_type: "unknown_event",
      data: {},
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed["status"]).toBe("no_mapping");
  });
});

// ─── Group 4: GET /goals returns current goal states ───

describe("Phase B — Remote Trigger API: GET /goals returns goal states", () => {
  let tmpDir: string;
  let server: EventServer;
  let port: number;

  beforeEach(async () => {
    tmpDir = makeTempDir("phase-b-goals-");
    fs.mkdirSync(path.join(tmpDir, "events"), { recursive: true });
    const mockDrive = makeMockDriveSystem(tmpDir);
    server = new EventServer(mockDrive as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
    });
    await server.start();
    port = server.getPort();
    rememberEventServerAuth(server);
  });

  afterEach(async () => {
    if (server.isRunning()) await server.stop();
    cleanupTempDir(tmpDir);
  });

  it("GET /goals returns empty array when no goals exist", async () => {
    const res = await makeHttpRequest(port, "GET", "/goals");
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(0);
  });

  it("GET /goals returns all saved goals with status fields", async () => {
    const goalsDir = path.join(tmpDir, "goals");
    for (const id of ["goal-a", "goal-b"]) {
      const goalDir = path.join(goalsDir, id);
      fs.mkdirSync(goalDir, { recursive: true });
      fs.writeFileSync(
        path.join(goalDir, "goal.json"),
        JSON.stringify({ id, title: `Title ${id}`, status: "active", loop_status: "running" }),
        "utf-8"
      );
    }

    const res = await makeHttpRequest(port, "GET", "/goals");
    expect(res.status).toBe(200);
    const goals = JSON.parse(res.body) as Array<Record<string, unknown>>;
    expect(goals).toHaveLength(2);
    const ids = goals.map((g) => g["id"]).sort();
    expect(ids).toEqual(["goal-a", "goal-b"]);
    for (const g of goals) {
      expect(g["status"]).toBe("active");
      expect(g["loop_status"]).toBe("running");
    }
  });

  it("GET /goals/:id returns goal detail with current_gap from gap-history", async () => {
    const goalDir = path.join(tmpDir, "goals", "goal-detail");
    fs.mkdirSync(goalDir, { recursive: true });
    fs.writeFileSync(
      path.join(goalDir, "goal.json"),
      JSON.stringify({
        id: "goal-detail",
        title: "Detailed Goal",
        status: "active",
        loop_status: "idle",
      }),
      "utf-8"
    );
    const gapEntry = { gap: 0.75, timestamp: new Date().toISOString() };
    fs.writeFileSync(
      path.join(goalDir, "gap-history.json"),
      JSON.stringify([gapEntry]),
      "utf-8"
    );

    const res = await makeHttpRequest(port, "GET", "/goals/goal-detail");
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed["id"]).toBe("goal-detail");
    expect(parsed["title"]).toBe("Detailed Goal");
    const gap = parsed["current_gap"] as Record<string, unknown>;
    expect(gap["gap"]).toBe(0.75);
  });

  it("GET /goals/:id returns 404 for a nonexistent goal", async () => {
    const res = await makeHttpRequest(port, "GET", "/goals/does-not-exist");
    expect(res.status).toBe(404);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed).toHaveProperty("error");
  });
});

// ─── Group 5: MCP DataSource — configure server as data source ───

describe("Phase B — MCP DataSource: observation reads from MCP tool", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("phase-b-mcp-ds-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("adapter query returns numeric value from MCP tool response", async () => {
    const mockConn = makeMockMCPConnection({
      async callTool(_name: string, _args: Record<string, unknown>) {
        return { content: [{ type: "text", text: "87" }] };
      },
    });

    const config = makeServerConfig({
      tool_mappings: [{ tool_name: "get_coverage", dimension_pattern: "coverage" }],
    });
    const adapter = new MCPDataSourceAdapter(config, mockConn);
    await adapter.connect();

    const result = await adapter.query({
      dimension_name: "coverage",
      goal_id: "goal-1",
    });

    expect(result.value).toBe(87);
    expect(result.source_id).toBe("test-server");
    expect(result.raw).toBeDefined();
  });

  it("adapter query returns string value when tool response is non-numeric", async () => {
    const mockConn = makeMockMCPConnection({
      async callTool() {
        return { content: [{ type: "text", text: "passing" }] };
      },
    });
    const config = makeServerConfig({
      tool_mappings: [{ tool_name: "get_status", dimension_pattern: "ci_status" }],
    });
    const adapter = new MCPDataSourceAdapter(config, mockConn);
    await adapter.connect();

    const result = await adapter.query({ dimension_name: "ci_status", goal_id: "goal-1" });
    expect(result.value).toBe("passing");
  });

  it("adapter query returns null for a dimension with no tool mapping", async () => {
    const mockConn = makeMockMCPConnection();
    const config = makeServerConfig({
      tool_mappings: [{ tool_name: "get_coverage", dimension_pattern: "coverage" }],
    });
    const adapter = new MCPDataSourceAdapter(config, mockConn);
    await adapter.connect();

    const result = await adapter.query({ dimension_name: "unrelated_metric", goal_id: "goal-1" });
    expect(result.value).toBeNull();
    expect(result.metadata).toBeDefined();
  });

  it("adapter query uses glob pattern to match wildcard dimension names", async () => {
    let capturedToolName = "";
    const mockConn = makeMockMCPConnection({
      async callTool(name: string) {
        capturedToolName = name;
        return { content: [{ type: "text", text: "55" }] };
      },
    });
    const config = makeServerConfig({
      tool_mappings: [{ tool_name: "get_metric", dimension_pattern: "metric_*" }],
    });
    const adapter = new MCPDataSourceAdapter(config, mockConn);
    await adapter.connect();

    const result = await adapter.query({ dimension_name: "metric_foo", goal_id: "goal-1" });
    expect(result.value).toBe(55);
    expect(capturedToolName).toBe("get_metric");
  });

  it("adapter returns error metadata when MCP tool throws", async () => {
    const mockConn = makeMockMCPConnection({
      async callTool() {
        throw new Error("MCP tool unavailable");
      },
    });
    const config = makeServerConfig({
      tool_mappings: [{ tool_name: "get_coverage", dimension_pattern: "coverage" }],
    });
    const adapter = new MCPDataSourceAdapter(config, mockConn);
    await adapter.connect();

    const result = await adapter.query({ dimension_name: "coverage", goal_id: "goal-1" });
    expect(result.value).toBeNull();
    expect(result.metadata).toBeDefined();
    const meta = result.metadata as Record<string, unknown>;
    expect(String(meta["error"])).toContain("MCP tool unavailable");
  });

  it("MCPClientManager connects multiple servers from config", async () => {
    fs.writeFileSync(
      path.join(tempDir, "mcp-servers.json"),
      JSON.stringify({
        servers: [
          makeServerConfig({ id: "srv-alpha" }),
          makeServerConfig({ id: "srv-beta" }),
        ],
      }),
      "utf-8"
    );

    const connectionFactory = vi.fn().mockImplementation(makeMockMCPConnection);
    const manager = new MCPClientManager(tempDir, connectionFactory);
    const adapters = await manager.connectAll();

    expect(adapters).toHaveLength(2);
    expect(connectionFactory).toHaveBeenCalledTimes(2);

    const adapterAlpha = manager.getAdapter("srv-alpha");
    const adapterBeta = manager.getAdapter("srv-beta");
    expect(adapterAlpha).toBeDefined();
    expect(adapterBeta).toBeDefined();

    await manager.disconnectAll();
    expect(manager.getAdapter("srv-alpha")).toBeUndefined();
  });

  it("healthCheck returns true when connection is active", async () => {
    const mockConn = makeMockMCPConnection();
    const config = makeServerConfig();
    const adapter = new MCPDataSourceAdapter(config, mockConn);
    await adapter.connect();

    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(true);
  });

  it("healthCheck returns false before connecting", async () => {
    const mockConn = makeMockMCPConnection();
    const config = makeServerConfig();
    const adapter = new MCPDataSourceAdapter(config, mockConn);
    // Not connected yet

    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(false);
  });
});

// ─── Group 6: Hook + Trigger integration ───

describe("Phase B — Hook + Trigger integration: trigger fires → hook intercepts payload", () => {
  let tmpDir: string;
  let server: EventServer;
  let port: number;

  beforeEach(async () => {
    tmpDir = makeTempDir("phase-b-hook-trigger-");
    fs.mkdirSync(path.join(tmpDir, "events"), { recursive: true });
    const mockDrive = makeMockDriveSystem(tmpDir);
    server = new EventServer(mockDrive as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
    });
    await server.start();
    port = server.getPort();
    rememberEventServerAuth(server);
  });

  afterEach(async () => {
    if (server.isRunning()) await server.stop();
    cleanupTempDir(tmpDir);
  });

  it("trigger POST followed by hook emit: hook captures trigger-related payload", async () => {
    // Set up a trigger mapping so the POST /triggers call succeeds
    const mappings = {
      mappings: [
        { source: "slack", event_type: "mention", action: "observe", goal_id: "goal-slack" },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "trigger-mappings.json"),
      JSON.stringify(mappings),
      "utf-8"
    );
    server.invalidateTriggerMappingsCache();

    // POST a trigger to the EventServer
    const triggerRes = await makeHttpRequest(port, "POST", "/triggers", {
      source: "slack",
      event_type: "mention",
      data: { channel: "#general", user: "alice" },
    });
    expect(triggerRes.status).toBe(200);

    // Now simulate the downstream hook that would be fired by the orchestrator
    const hookOutputFile = path.join(tmpDir, "hook-payload.json");
    const hookDir = tmpDir;
    const hooks: HookConfig[] = [
      {
        event: "PostObserve",
        type: "shell",
        command: `cat > ${hookOutputFile}`,
        timeout_ms: 5000,
        enabled: true,
      },
    ];
    writeHooksJson(hookDir, hooks);

    const hookManager = new HookManager(hookDir);
    await hookManager.loadHooks();
    await hookManager.emit("PostObserve", {
      goal_id: "goal-slack",
      data: { channel: "#general", user: "alice", source: "slack" },
    });
    await new Promise((r) => setTimeout(r, 400));

    expect(fs.existsSync(hookOutputFile)).toBe(true);
    const hookPayload = JSON.parse(fs.readFileSync(hookOutputFile, "utf-8"));
    expect(hookPayload.event).toBe("PostObserve");
    expect(hookPayload.goal_id).toBe("goal-slack");
    expect(hookPayload.data.source).toBe("slack");
  });

  it("trigger with hook filter: hook only fires for matching goal_id", async () => {
    const firedFile = path.join(tmpDir, "filtered-hook.txt");
    const notFiredFile = path.join(tmpDir, "no-fire.txt");

    const hookDir = tmpDir;
    const hooks: HookConfig[] = [
      {
        event: "GoalStateChange",
        type: "shell",
        command: `echo fired > ${firedFile}`,
        timeout_ms: 5000,
        enabled: true,
        filter: { goal_id: "goal-target" },
      },
      {
        event: "GoalStateChange",
        type: "shell",
        command: `echo nope > ${notFiredFile}`,
        timeout_ms: 5000,
        enabled: true,
        filter: { goal_id: "goal-other" },
      },
    ];
    writeHooksJson(hookDir, hooks);

    const hookManager = new HookManager(hookDir);
    await hookManager.loadHooks();

    // Emit only for goal-target
    await hookManager.emit("GoalStateChange", { goal_id: "goal-target" });
    await new Promise((r) => setTimeout(r, 400));

    expect(fs.existsSync(firedFile)).toBe(true);
    expect(fs.existsSync(notFiredFile)).toBe(false);
  });
});

// ─── Group 7: EventServer lifecycle ───

describe("Phase B — EventServer lifecycle: start → requests → graceful shutdown", () => {
  let tmpDir: string;
  let server: EventServer | null = null;

  beforeEach(() => {
    tmpDir = makeTempDir("phase-b-lifecycle-");
    fs.mkdirSync(path.join(tmpDir, "events"), { recursive: true });
    server = null;
  });

  afterEach(async () => {
    if (server !== null) {
      await server.stop().catch(() => undefined);
      server = null;
    }
    cleanupTempDir(tmpDir);
  });

  it("server starts and responds to GET /health", async () => {
    const mockDrive = makeMockDriveSystem(tmpDir);
    server = new EventServer(mockDrive as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
    });
    await server.start();
    const port = server.getPort();
    rememberEventServerAuth(server);

    expect(server.isRunning()).toBe(true);

    const res = await makeHttpRequest(port, "GET", "/health");
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed["status"]).toBe("ok");
    expect(typeof parsed["uptime"]).toBe("number");

    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it("server assigns a random port when port 0 is given", async () => {
    const mockDrive = makeMockDriveSystem(tmpDir);
    server = new EventServer(mockDrive as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
    });
    await server.start();

    expect(server.getPort()).toBeGreaterThan(0);

    await server.stop();
  });

  it("server returns 404 for unknown routes", async () => {
    const mockDrive = makeMockDriveSystem(tmpDir);
    server = new EventServer(mockDrive as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
    });
    await server.start();
    const port = server.getPort();
    rememberEventServerAuth(server);

    const res = await makeHttpRequest(port, "GET", "/unknown/path");
    expect(res.status).toBe(404);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed).toHaveProperty("error");

    await server.stop();
  });

  it("server handles concurrent requests without error", async () => {
    const mockDrive = makeMockDriveSystem(tmpDir);
    server = new EventServer(mockDrive as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
    });
    await server.start();
    const port = server.getPort();
    rememberEventServerAuth(server);

    // Fire 5 concurrent health checks
    const requests = Array.from({ length: 5 }, () =>
      makeHttpRequest(port, "GET", "/health")
    );
    const results = await Promise.all(requests);

    for (const res of results) {
      expect(res.status).toBe(200);
    }

    await server.stop();
  });

  it("stop() is idempotent — second stop does not throw", async () => {
    const mockDrive = makeMockDriveSystem(tmpDir);
    server = new EventServer(mockDrive as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
    });
    await server.start();
    await server.stop();

    // Second stop should not throw
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it("POST /events dispatches a valid PulSeedEvent to driveSystem", async () => {
    const mockDrive = makeMockDriveSystem(tmpDir);
    server = new EventServer(mockDrive as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
    });
    await server.start();
    const port = server.getPort();
    rememberEventServerAuth(server);

    const res = await makeHttpRequest(port, "POST", "/events", {
      type: "external",
      source: "test-runner",
      timestamp: new Date().toISOString(),
      data: { test: true },
    });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed["status"]).toBe("accepted");
    expect(parsed["event_type"]).toBe("external");

    await new Promise((r) => setTimeout(r, 50));
    expect(mockDrive.writeEvent).toHaveBeenCalledOnce();

    await server.stop();
  });

  it("POST /events returns 400 for an invalid event body", async () => {
    const mockDrive = makeMockDriveSystem(tmpDir);
    server = new EventServer(mockDrive as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
    });
    await server.start();
    const port = server.getPort();
    rememberEventServerAuth(server);

    const res = await makeHttpRequest(port, "POST", "/events", {
      bad_field: "not a valid event",
    });
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed).toHaveProperty("error");

    await server.stop();
  });
});
