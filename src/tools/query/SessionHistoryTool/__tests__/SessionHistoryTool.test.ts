import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SessionHistoryTool } from "../SessionHistoryTool.js";
import type { ToolCallContext } from "../../../types.js";
import type { StateManager } from "../../../../base/state/state-manager.js";

/** Minimal readRaw that mimics StateManager path-traversal protection */
async function fakeReadRaw(baseDir: string, relativePath: string): Promise<unknown | null> {
  const resolved = path.resolve(baseDir, relativePath);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  if (!fs.existsSync(resolved)) return null;
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

function makeContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

function makeSessionJson(id: string, goalId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    goal_id: goalId,
    session_type: "task_execution",
    task_id: null,
    context_slots: [{ priority: 1, label: "goal", content: "test", token_estimate: 10 }],
    context_budget: 50000,
    started_at: "2024-01-01T00:00:00.000Z",
    ended_at: "2024-01-01T00:05:00.000Z",
    result_summary: "Task completed successfully",
    ...overrides,
  };
}

describe("SessionHistoryTool", () => {
  let stateManager: StateManager;
  let tool: SessionHistoryTool;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-history-test-"));
    stateManager = {
      getBaseDir: vi.fn().mockReturnValue(tmpDir),
      readRaw: vi.fn().mockImplementation((rel: string) => fakeReadRaw(tmpDir, rel)),
    } as unknown as StateManager;
    tool = new SessionHistoryTool(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns metadata with correct name and tags", () => {
    expect(tool.metadata.name).toBe("session_history");
    expect(tool.metadata.tags).toContain("self-grounding");
    expect(tool.metadata.isReadOnly).toBe(true);
  });

  it("description returns non-empty string", () => {
    expect(tool.description()).toContain("session");
  });

  it("checkPermissions returns allowed", async () => {
    const result = await tool.checkPermissions({ limit: 5, includeObservations: true }, makeContext());
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", () => {
    expect(tool.isConcurrencySafe({ limit: 5, includeObservations: true })).toBe(true);
  });

  it("returns empty array when sessions dir does not exist", async () => {
    const result = await tool.call({ limit: 5, includeObservations: true }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { sessions: unknown[] };
    expect(data.sessions).toHaveLength(0);
  });

  it("returns sessions sorted by recency (most recent first)", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "session-001.json"), JSON.stringify(makeSessionJson("s1", "g1", { started_at: "2024-01-01T00:00:00.000Z" })));
    fs.writeFileSync(path.join(sessionsDir, "session-002.json"), JSON.stringify(makeSessionJson("s2", "g1", { started_at: "2024-01-02T00:00:00.000Z" })));
    fs.writeFileSync(path.join(sessionsDir, "session-003.json"), JSON.stringify(makeSessionJson("s3", "g1", { started_at: "2024-01-03T00:00:00.000Z" })));

    const result = await tool.call({ limit: 5, includeObservations: false }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { sessions: Array<{ sessionId: string }> };
    expect(data.sessions).toHaveLength(3);
    // Most recent first
    expect(data.sessions[0].sessionId).toBe("s3");
    expect(data.sessions[1].sessionId).toBe("s2");
    expect(data.sessions[2].sessionId).toBe("s1");
  });

  it("respects limit parameter", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    for (let i = 1; i <= 10; i++) {
      fs.writeFileSync(
        path.join(sessionsDir, `session-${String(i).padStart(3, "0")}.json`),
        JSON.stringify(makeSessionJson(`s${i}`, "g1"))
      );
    }

    const result = await tool.call({ limit: 3, includeObservations: false }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { sessions: unknown[] };
    expect(data.sessions).toHaveLength(3);
  });

  it("filters by goalId when provided", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "session-001.json"), JSON.stringify(makeSessionJson("s1", "goal-A")));
    fs.writeFileSync(path.join(sessionsDir, "session-002.json"), JSON.stringify(makeSessionJson("s2", "goal-B")));
    fs.writeFileSync(path.join(sessionsDir, "session-003.json"), JSON.stringify(makeSessionJson("s3", "goal-A")));

    const result = await tool.call({ goalId: "goal-A", limit: 5, includeObservations: false }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { sessions: Array<{ goalId: string }> };
    expect(data.sessions).toHaveLength(2);
    expect(data.sessions.every((s) => s.goalId === "goal-A")).toBe(true);
  });

  it("includes observations when includeObservations is true", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "session-001.json"), JSON.stringify(makeSessionJson("s1", "g1")));

    const result = await tool.call({ limit: 5, includeObservations: true }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { sessions: Array<{ observations?: unknown }> };
    expect(data.sessions[0].observations).toBeDefined();
  });

  it("excludes observations when includeObservations is false", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "session-001.json"), JSON.stringify(makeSessionJson("s1", "g1")));

    const result = await tool.call({ limit: 5, includeObservations: false }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { sessions: Array<{ observations?: unknown }> };
    expect(data.sessions[0].observations).toBeUndefined();
  });

  it("skips malformed JSON files without throwing", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "session-001.json"), "not-json");
    fs.writeFileSync(path.join(sessionsDir, "session-002.json"), JSON.stringify(makeSessionJson("s2", "g1")));

    const result = await tool.call({ limit: 5, includeObservations: false }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { sessions: unknown[] };
    expect(data.sessions).toHaveLength(1);
  });
});
