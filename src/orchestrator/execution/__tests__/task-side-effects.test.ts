import { describe, expect, it, vi } from "vitest";
import { persistTaskCycleSideEffects } from "../task/task-side-effects.js";
import type { Task, VerificationResult } from "../../../base/types/task.js";
import type { AgentResult, IAdapter } from "../adapter-layer.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "test task",
    rationale: "test rationale",
    approach: "test approach",
    success_criteria: [
      {
        description: "Tests pass",
        verification_method: "npx vitest run",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["module A"],
      out_of_scope: ["module B"],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 2, unit: "hours" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("persistTaskCycleSideEffects", () => {
  it("saves the final verdict action in the checkpoint snapshot", async () => {
    const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
    const sessionManager = { saveCheckpoint } as unknown as {
      saveCheckpoint: typeof saveCheckpoint;
    };
    const task = makeTask({ strategy_id: "strategy-1" });
    const verificationResult: VerificationResult = {
      verdict: "pass",
      confidence: 0.9,
      evidence: [],
      dimension_updates: [],
    };
    const executionResult: AgentResult = {
      success: true,
      output: "Task completed successfully",
      error: null,
      exit_code: 0,
      elapsed_ms: 100,
      stopped_reason: "completed",
    };
    const adapter = { adapterType: "mock" } as IAdapter;

    await persistTaskCycleSideEffects({
      goalId: "goal-1",
      targetDimension: "dim",
      task,
      action: "completed",
      verificationResult,
      executionResult,
      adapter,
      sessionManager: sessionManager as never,
      llmClient: {} as never,
      gapValue: 0.4,
    });

    expect(saveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionContextSnapshot: expect.stringContaining("action: completed"),
      })
    );
    expect(saveCheckpoint).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionContextSnapshot: expect.stringContaining("action: pass"),
      })
    );
  });
});
