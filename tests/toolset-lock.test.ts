import { describe, it, expect, vi } from "vitest";
import { ToolsetLock } from "../src/execution/toolset-lock.js";
import { executeTask } from "../src/execution/task-executor.js";
import type { AgentTask, AgentResult } from "../src/execution/adapter-layer.js";
import type { TaskExecutorDeps } from "../src/execution/task-executor.js";
import type { Strategy } from "../src/types/strategy.js";

// ─── ToolsetLock ───

describe("ToolsetLock", () => {
  it("constructor snapshots and sorts tools", () => {
    const lock = new ToolsetLock(["write_files", "execute_code", "read_files"]);
    expect(lock.tools).toEqual(["execute_code", "read_files", "write_files"]);
  });

  it("snapshot is frozen (immutable)", () => {
    const lock = new ToolsetLock(["tool_a"]);
    expect(Object.isFrozen(lock.tools)).toBe(true);
  });

  it("lock() sets locked to true", () => {
    const lock = new ToolsetLock(["tool_a"]);
    expect(lock.locked).toBe(false);
    lock.lock();
    expect(lock.locked).toBe(true);
  });

  it("validate() passes when unlocked regardless of changes", () => {
    const lock = new ToolsetLock(["tool_a", "tool_b"]);
    // Not locked yet — any set of current tools is valid
    const result = lock.validate(["tool_c", "tool_d"]);
    expect(result.valid).toBe(true);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("validate() passes when locked and tools are unchanged", () => {
    const lock = new ToolsetLock(["tool_a", "tool_b"]);
    lock.lock();
    const result = lock.validate(["tool_b", "tool_a"]); // order should not matter
    expect(result.valid).toBe(true);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("validate() detects added tools when locked", () => {
    const lock = new ToolsetLock(["tool_a"]);
    lock.lock();
    const result = lock.validate(["tool_a", "tool_b"]);
    expect(result.valid).toBe(false);
    expect(result.added).toEqual(["tool_b"]);
    expect(result.removed).toEqual([]);
  });

  it("validate() detects removed tools when locked", () => {
    const lock = new ToolsetLock(["tool_a", "tool_b"]);
    lock.lock();
    const result = lock.validate(["tool_a"]);
    expect(result.valid).toBe(false);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(["tool_b"]);
  });

  it("validate() detects both added and removed tools when locked", () => {
    const lock = new ToolsetLock(["tool_a", "tool_b"]);
    lock.lock();
    const result = lock.validate(["tool_a", "tool_c"]);
    expect(result.valid).toBe(false);
    expect(result.added).toEqual(["tool_c"]);
    expect(result.removed).toEqual(["tool_b"]);
  });

  it("toJSON returns snapshot and locked state", () => {
    const lock = new ToolsetLock(["b", "a"]);
    lock.lock();
    const json = lock.toJSON();
    expect(json).toEqual({ tools: ["a", "b"], locked: true });
  });

  it("toJSON returns unlocked state before lock()", () => {
    const lock = new ToolsetLock(["tool_x"]);
    const json = lock.toJSON();
    expect(json).toEqual({ tools: ["tool_x"], locked: false });
  });

  it("fromJSON round-trips a locked lock", () => {
    const original = new ToolsetLock(["z", "a", "m"]);
    original.lock();
    const restored = ToolsetLock.fromJSON(original.toJSON());
    expect(restored.locked).toBe(true);
    expect([...restored.tools]).toEqual([...original.tools]);
    const result = restored.validate(["a", "m", "z"]);
    expect(result.valid).toBe(true);
  });

  it("fromJSON round-trips an unlocked lock", () => {
    const original = new ToolsetLock(["tool_a"]);
    const restored = ToolsetLock.fromJSON(original.toJSON());
    expect(restored.locked).toBe(false);
    // Unlocked — validate always returns valid
    expect(restored.validate([]).valid).toBe(true);
  });
});

// ─── AgentTask.allowed_tools field ───

describe("AgentTask.allowed_tools field", () => {
  it("allowed_tools is optional and typed as readonly string[]", () => {
    // This test validates the TypeScript type contract at runtime.
    // A task without allowed_tools should work fine.
    const task: AgentTask = {
      prompt: "test prompt",
      timeout_ms: 5000,
      adapter_type: "test_adapter",
    };
    expect(task.allowed_tools).toBeUndefined();

    // A task with allowed_tools should accept a readonly array.
    const taskWithTools: AgentTask = {
      prompt: "test prompt",
      timeout_ms: 5000,
      adapter_type: "test_adapter",
      allowed_tools: ["read_files", "write_files"],
    };
    expect(taskWithTools.allowed_tools).toEqual(["read_files", "write_files"]);
  });

  it("allowed_tools is passed through from task to adapter", () => {
    // Simulate what task-executor does when building AgentTask from a strategy.
    const strategyTools = ["execute_code", "read_files"];
    const agentTask: AgentTask = {
      prompt: "do something",
      timeout_ms: 30_000,
      adapter_type: "claude_code_cli",
      allowed_tools: strategyTools,
    };
    expect(agentTask.allowed_tools).toBe(strategyTools);
    expect(agentTask.allowed_tools?.length).toBe(2);
  });
});

// ─── executeTask: toolset_locked warning ───

describe("executeTask toolset_locked warning", () => {
  it("logs a warning when toolset_locked=true but allowed_tools is empty", async () => {
    const warnFn = vi.fn();
    const mockResult: AgentResult = {
      success: true,
      output: "done",
      error: null,
      exit_code: 0,
      elapsed_ms: 10,
      stopped_reason: "completed",
    };

    const mockTask = {
      id: "task-1",
      goal_id: "goal-1",
      strategy_id: null,
      target_dimensions: ["d1"],
      primary_dimension: "d1",
      work_description: "do the work",
      rationale: "needed",
      approach: "direct",
      success_criteria: [{ description: "it works", verification_method: "check", is_blocking: true }],
      scope_boundary: { in_scope: [], out_of_scope: [], blast_radius: "low" },
      constraints: [],
      plateau_until: null,
      estimated_duration: null,
      consecutive_failure_count: 0,
      reversibility: "unknown" as const,
      task_category: "normal" as const,
      status: "pending" as const,
      started_at: null,
      completed_at: null,
      timeout_at: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
    };

    const mockAdapter = {
      adapterType: "mock",
      execute: vi.fn().mockResolvedValue(mockResult),
    };

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue({ id: "session-1" }),
      endSession: vi.fn().mockResolvedValue(undefined),
      buildTaskExecutionContext: vi.fn().mockReturnValue([]),
    };

    const deps: TaskExecutorDeps = {
      stateManager: {
        writeRaw: vi.fn().mockResolvedValue(undefined),
        readRaw: vi.fn().mockResolvedValue(null),
      } as unknown as TaskExecutorDeps["stateManager"],
      sessionManager: mockSessionManager as unknown as TaskExecutorDeps["sessionManager"],
      logger: { warn: warnFn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as TaskExecutorDeps["logger"],
      execFileSyncFn: vi.fn().mockReturnValue(""),
    };

    const activeStrategy: Strategy = {
      id: "strat-1",
      goal_id: "goal-1",
      target_dimensions: ["d1"],
      primary_dimension: "d1",
      hypothesis: "h",
      expected_effect: [],
      resource_estimate: { sessions: 1, duration: { value: 1, unit: "days" }, llm_calls: null },
      state: "active",
      allocation: 1,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      gap_snapshot_at_start: null,
      tasks_generated: [],
      effectiveness_score: null,
      consecutive_stall_count: 0,
      source_template_id: null,
      cross_goal_context: null,
      rollback_target_id: null,
      max_pivot_count: 2,
      pivot_count: 0,
      toolset_locked: true,
      allowed_tools: [], // empty — should trigger warning
    };

    await executeTask(deps, mockTask, mockAdapter as unknown as Parameters<typeof executeTask>[2], undefined, activeStrategy);

    expect(warnFn).toHaveBeenCalledWith(
      expect.stringContaining("toolset_locked=true but no allowed_tools defined"),
      expect.objectContaining({ taskId: "task-1" })
    );
  });
});
