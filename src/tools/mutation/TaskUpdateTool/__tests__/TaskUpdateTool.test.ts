import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskUpdateTool } from "../TaskUpdateTool.js";
import type { ToolCallContext } from "../../../types.js";
import type { StateManager } from "../../../../base/state/state-manager.js";

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
    goalId: "goal-1",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

function makeTaskJson(id: string, goalId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    goal_id: goalId,
    strategy_id: null,
    target_dimensions: ["coverage"],
    primary_dimension: "coverage",
    work_description: `Improve coverage for ${id}`,
    rationale: "Need better confidence",
    approach: "Run tests and add missing cases",
    success_criteria: [],
    scope_boundary: {
      in_scope: ["src"],
      out_of_scope: ["infra"],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("TaskUpdateTool", () => {
  let stateManager: StateManager;
  let tool: TaskUpdateTool;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-update-tool-"));
    stateManager = {
      readRaw: vi.fn().mockImplementation((rel: string) => fakeReadRaw(tmpDir, rel)),
      writeRaw: vi.fn().mockImplementation(async (rel: string, data: unknown) => {
        const resolved = path.resolve(tmpDir, rel);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, JSON.stringify(data), "utf-8");
      }),
    } as unknown as StateManager;
    tool = new TaskUpdateTool(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updates task status and sets started_at when entering running", async () => {
    const tasksDir = path.join(tmpDir, "tasks", "goal-1");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "task-1.json"), JSON.stringify(makeTaskJson("task-1", "goal-1")));

    const result = await tool.call(
      { goalId: "goal-1", taskId: "task-1", status: "running", started_at: "2026-01-02T00:00:00.000Z" },
      makeContext()
    );
    expect(result.success).toBe(true);
    const persisted = await fakeReadRaw(tmpDir, "tasks/goal-1/task-1.json") as Record<string, unknown>;
    expect(persisted.status).toBe("running");
    expect(persisted.started_at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("appends execution output and keeps only the tail", async () => {
    const tasksDir = path.join(tmpDir, "tasks", "goal-1");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "task-1.json"), JSON.stringify(makeTaskJson("task-1", "goal-1")));

    const result = await tool.call(
      { goalId: "goal-1", taskId: "task-1", approach: "Use sub-agent synthesis" },
      makeContext()
    );

    expect(result.success).toBe(true);
    const persisted = await fakeReadRaw(tmpDir, "tasks/goal-1/task-1.json") as Record<string, unknown>;
    expect(persisted.approach).toBe("Use sub-agent synthesis");
  });

  it("writes verification fields", async () => {
    const tasksDir = path.join(tmpDir, "tasks", "goal-1");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "task-1.json"), JSON.stringify(makeTaskJson("task-1", "goal-1")));

    const result = await tool.call(
      {
        goalId: "goal-1",
        taskId: "task-1",
        verification_verdict: "pass",
        verification_evidence: ["tests passed"],
      },
      makeContext()
    );

    expect(result.success).toBe(true);
    const persisted = await fakeReadRaw(tmpDir, "tasks/goal-1/task-1.json") as Record<string, unknown>;
    expect(persisted.verification_verdict).toBe("pass");
    expect(persisted.verification_evidence).toEqual(["tests passed"]);
  });

  it("appends task history on first transition to terminal state", async () => {
    const tasksDir = path.join(tmpDir, "tasks", "goal-1");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, "task-1.json"),
      JSON.stringify(makeTaskJson("task-1", "goal-1", { status: "running", started_at: "2026-01-01T00:00:00.000Z" }))
    );

    const result = await tool.call(
      {
        goalId: "goal-1",
        taskId: "task-1",
        status: "completed",
        completed_at: "2026-01-01T00:05:00.000Z",
      },
      makeContext()
    );

    expect(result.success).toBe(true);
    const history = await fakeReadRaw(tmpDir, "tasks/goal-1/task-history.json") as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]?.task_id).toBe("task-1");
  });

  it("does not infer a succeeded ledger event for externally completed tasks without verification", async () => {
    const tasksDir = path.join(tmpDir, "tasks", "goal-1");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, "task-1.json"),
      JSON.stringify(makeTaskJson("task-1", "goal-1", { status: "running", started_at: "2026-01-01T00:00:00.000Z" }))
    );

    const result = await tool.call(
      {
        goalId: "goal-1",
        taskId: "task-1",
        status: "completed",
        completed_at: "2026-01-01T00:05:00.000Z",
      },
      makeContext()
    );

    expect(result.success).toBe(true);
    const ledger = await fakeReadRaw(tmpDir, "tasks/goal-1/ledger/task-1.json") as Record<string, unknown>;
    const events = ledger.events as Array<Record<string, unknown>>;
    const summary = ledger.summary as Record<string, unknown>;
    expect(events).toEqual([]);
    expect(summary.latest_event_type).toBeNull();
  });

  it("returns failure when task does not exist", async () => {
    const result = await tool.call({ goalId: "goal-1", taskId: "missing", status: "running" }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("missing");
  });
});
