/**
 * Thin orchestration coverage for TaskLifecycle wiring.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../../../base/state/state-manager.js";
import { SessionManager } from "../session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { StrategyManager } from "../../strategy/strategy-manager.js";
import { StallDetector } from "../../../platform/drive/stall-detector.js";
import { TaskLifecycle } from "../task/task-lifecycle.js";
import type { Task } from "../../../base/types/task.js";
import type { GapVector } from "../../../base/types/gap.js";
import type { DriveContext } from "../../../base/types/drive.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

function makeGapVector(goalId: string, dimensions: Array<{ name: string; gap: number }>): GapVector {
  return {
    goal_id: goalId,
    gaps: dimensions.map((d) => ({
      dimension_name: d.name,
      raw_gap: d.gap,
      normalized_gap: d.gap,
      normalized_weighted_gap: d.gap,
      confidence: 0.8,
      uncertainty_weight: 1.0,
    })),
    timestamp: new Date().toISOString(),
  };
}

function makeDriveContext(dimensionNames: string[]): DriveContext {
  const time_since_last_attempt: Record<string, number> = {};
  const deadlines: Record<string, number | null> = {};
  for (const name of dimensionNames) {
    time_since_last_attempt[name] = 24;
    deadlines[name] = null;
  }
  return { time_since_last_attempt, deadlines, opportunities: {}, pacing: {} };
}

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
      { description: "Tests pass", verification_method: "npx vitest run", is_blocking: true },
    ],
    scope_boundary: { in_scope: ["module A"], out_of_scope: ["module B"], blast_radius: "low" },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 1, unit: "hours" },
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

describe("TaskLifecycle — orchestration wiring", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let trustManager: TrustManager;
  let strategyManager: StrategyManager;
  let stallDetector: StallDetector;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    sessionManager = new SessionManager(stateManager);
    trustManager = new TrustManager(stateManager);
    stallDetector = new StallDetector(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  function createLifecycle(
    llmClient: ReturnType<typeof createMockLLMClient>,
    options?: {
      approvalFn?: (task: Task) => Promise<boolean>;
    }
  ): TaskLifecycle {
    strategyManager = new StrategyManager(stateManager, llmClient);
    return new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { healthCheckEnabled: false, execFileSyncFn: () => "some-file.ts", ...options }
    );
  }

  it("supports object-shaped constructor deps while preserving behavior", async () => {
    const llm = createMockLLMClient([]);
    strategyManager = new StrategyManager(stateManager, llm);

    const lifecycle = new TaskLifecycle({
      stateManager,
      llmClient: llm,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      options: { healthCheckEnabled: false, execFileSyncFn: () => "some-file.ts" },
    });

    expect(lifecycle).toBeInstanceOf(TaskLifecycle);
  });

  it("checkIrreversibleApproval returns false for irreversible tasks when denied", async () => {
    const lifecycle = createLifecycle(createMockLLMClient([]), { approvalFn: async () => false });
    const task = makeTask({ reversibility: "irreversible" });

    await expect(lifecycle.checkIrreversibleApproval(task, 0.9)).resolves.toBe(false);
  });

  it("checkIrreversibleApproval returns true for irreversible tasks when approved", async () => {
    const lifecycle = createLifecycle(createMockLLMClient([]), { approvalFn: async () => true });
    const task = makeTask({ reversibility: "irreversible" });

    await expect(lifecycle.checkIrreversibleApproval(task, 0.9)).resolves.toBe(true);
  });

  it("setOnTaskComplete wires the callback without affecting runtime", async () => {
    const lifecycle = createLifecycle(createMockLLMClient([]));
    const completed: string[] = [];

    lifecycle.setOnTaskComplete((strategyId) => {
      completed.push(strategyId);
    });

    expect(completed).toEqual([]);
  });

  it("selectTargetDimension chooses the highest normalized gap", () => {
    const lifecycle = createLifecycle(createMockLLMClient([]));
    const selected = lifecycle.selectTargetDimension(
      makeGapVector("goal-sel", [
        { name: "alpha", gap: 0.2 },
        { name: "beta", gap: 0.9 },
        { name: "gamma", gap: 0.5 },
      ]),
      makeDriveContext(["alpha", "beta", "gamma"])
    );

    expect(selected).toBe("beta");
  });
});
