import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResult, IAdapter } from "../adapter-layer.js";
import { executeTask, type TaskExecutorDeps } from "../task/task-executor.js";
import type { Task } from "../../../base/types/task.js";
import type { SessionManager } from "../session-manager.js";

vi.mock("../../../base/llm/provider-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../base/llm/provider-config.js")>();
  return {
    ...actual,
    loadProviderConfig: vi.fn().mockResolvedValue({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "openai_codex_cli",
      agent_loop: {
        security: {
          protected_paths: ["build"],
        },
      },
    }),
  };
});

function makeTask(): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["quality"],
    primary_dimension: "quality",
    work_description: "work",
    rationale: "why",
    approach: "how",
    success_criteria: [{ description: "done", verification_method: "review", is_blocking: true }],
    scope_boundary: { in_scope: ["src"], out_of_scope: [], blast_radius: "low" },
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
    created_at: new Date().toISOString(),
  };
}

describe("executeTask protected paths", () => {
  let stateManager: TaskExecutorDeps["stateManager"];
  let sessionManager: SessionManager;
  let adapter: IAdapter;
  let execFileSyncFn: TaskExecutorDeps["execFileSyncFn"];

  beforeEach(() => {
    stateManager = {
      loadGoal: vi.fn().mockResolvedValue({ constraints: ["workspace_path:/repo"] }),
      readRaw: vi.fn().mockResolvedValue(null),
      writeRaw: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskExecutorDeps["stateManager"];
    sessionManager = {
      createSession: vi.fn().mockResolvedValue({ id: "session-1" }),
      buildTaskExecutionContext: vi.fn().mockReturnValue([]),
      endSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionManager;
    adapter = {
      adapterType: "mock",
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "done",
        error: null,
        exit_code: 0,
        elapsed_ms: 1,
        stopped_reason: "completed",
      } as AgentResult),
    } as unknown as IAdapter;
    execFileSyncFn = vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "diff") return "build/output.txt";
      if (args[0] === "ls-files") return "";
      return "";
    });
  });

  it("fails successful task results when configured protected paths are modified", async () => {
    const result = await executeTask(
      {
        stateManager,
        sessionManager,
        execFileSyncFn,
      },
      makeTask(),
      adapter,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("build/output.txt");
  });
});
