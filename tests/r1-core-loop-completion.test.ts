/**
 * R1-1 and R1-2 verification tests
 *
 * R1-1: The pre-task completion check (Step 5) no longer causes an early-return.
 *       The task cycle always runs within an iteration.
 *
 * R1-2: minIterations forces at least N full iterations before the loop can exit
 *       on completion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CoreLoop,
  type CoreLoopDeps,
} from "../src/loop/core-loop.js";
import { StateManager } from "../src/state/state-manager.js";
import type { IAdapter } from "../src/execution/adapter-layer.js";
import type { Goal } from "../src/types/goal.js";
import type { CompletionJudgment } from "../src/types/satisficing.js";
import type { GapVector } from "../src/types/gap.js";
import type { DriveScore } from "../src/types/drive.js";
import type { TaskCycleResult } from "../src/execution/task/task-lifecycle.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";

// ─── Helpers ───

function makeCompletionJudgment(
  overrides: Partial<CompletionJudgment> = {}
): CompletionJudgment {
  return {
    is_complete: false,
    blocking_dimensions: ["quality"],
    low_confidence_dimensions: [],
    needs_verification_task: false,
    checked_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeGapVector(): GapVector {
  return {
    goal_id: "goal-1",
    gaps: [
      {
        dimension_name: "quality",
        raw_gap: 0,
        normalized_gap: 0,
        normalized_weighted_gap: 0,
        confidence: 0.9,
        uncertainty_weight: 1.0,
      },
    ],
    timestamp: new Date().toISOString(),
  };
}

function makeDriveScores(): DriveScore[] {
  return [
    {
      dimension_name: "quality",
      dissatisfaction: 0,
      deadline: 0,
      opportunity: 0,
      final_score: 0,
      dominant_drive: "dissatisfaction",
    },
  ];
}

function makeTaskCycleResult(): TaskCycleResult {
  const now = new Date().toISOString();
  return {
    task: {
      id: "task-1",
      goal_id: "goal-1",
      strategy_id: null,
      target_dimensions: ["quality"],
      primary_dimension: "quality",
      work_description: "Improve quality",
      rationale: "Quality needs work",
      approach: "Review and polish",
      success_criteria: [
        {
          description: "Quality above threshold",
          verification_method: "manual check",
          is_blocking: true,
        },
      ],
      scope_boundary: {
        in_scope: ["quality"],
        out_of_scope: [],
        blast_radius: "none",
      },
      constraints: [],
      plateau_until: null,
      estimated_duration: null,
      consecutive_failure_count: 0,
      reversibility: "reversible",
      task_category: "normal",
      status: "completed",
      started_at: now,
      completed_at: now,
      timeout_at: null,
      heartbeat_at: null,
      created_at: now,
    },
    verificationResult: {
      task_id: "task-1",
      verdict: "pass",
      confidence: 0.9,
      evidence: [{ layer: "mechanical", description: "Pass", confidence: 0.9 }],
      dimension_updates: [],
      timestamp: now,
    },
    action: "completed",
  };
}

function createDeps(tmpDir: string): {
  deps: CoreLoopDeps;
  stateManager: StateManager;
  satisficingJudgeMock: { isGoalComplete: ReturnType<typeof vi.fn> };
  taskLifecycleMock: { runTaskCycle: ReturnType<typeof vi.fn> };
} {
  const stateManager = new StateManager(tmpDir);

  const adapter: IAdapter = {
    adapterType: "claude_api",
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: "done",
      error: null,
      exit_code: null,
      elapsed_ms: 100,
      stopped_reason: "completed",
    }),
  };

  const satisficingJudgeMock = {
    isGoalComplete: vi.fn().mockReturnValue(makeCompletionJudgment()),
    isDimensionSatisfied: vi.fn(),
    applyProgressCeiling: vi.fn(),
    selectDimensionsForIteration: vi.fn(),
    detectThresholdAdjustmentNeeded: vi.fn(),
    propagateSubgoalCompletion: vi.fn(),
    judgeTreeCompletion: vi.fn(),
  };

  const taskLifecycleMock = {
    runTaskCycle: vi.fn().mockResolvedValue(makeTaskCycleResult()),
    selectTargetDimension: vi.fn(),
    generateTask: vi.fn(),
    checkIrreversibleApproval: vi.fn(),
    executeTask: vi.fn(),
    verifyTask: vi.fn(),
    handleVerdict: vi.fn(),
    handleFailure: vi.fn(),
  };

  const deps: CoreLoopDeps = {
    stateManager,
    observationEngine: {
      observe: vi.fn(),
      applyObservation: vi.fn(),
      createObservationEntry: vi.fn(),
      getObservationLog: vi.fn(),
      saveObservationLog: vi.fn(),
      applyProgressCeiling: vi.fn(),
      getConfidenceTier: vi.fn(),
      resolveContradiction: vi.fn(),
      needsVerificationTask: vi.fn(),
    } as unknown as CoreLoopDeps["observationEngine"],
    gapCalculator: {
      calculateGapVector: vi.fn().mockReturnValue(makeGapVector()),
      // Use a non-zero gap so the gap=0 early-exit path (Step 3b, commit a927850) is NOT
      // triggered. R1-1/R1-2 tests target the Step 5 pre-task completion check, which
      // only runs when gap > 0.
      aggregateGaps: vi.fn().mockReturnValue(0.1),
    } as unknown as CoreLoopDeps["gapCalculator"],
    driveScorer: {
      scoreAllDimensions: vi.fn().mockReturnValue(makeDriveScores()),
      rankDimensions: vi.fn().mockImplementation((s: DriveScore[]) => [...s]),
    } as unknown as CoreLoopDeps["driveScorer"],
    taskLifecycle: taskLifecycleMock as unknown as CoreLoopDeps["taskLifecycle"],
    satisficingJudge: satisficingJudgeMock as unknown as CoreLoopDeps["satisficingJudge"],
    stallDetector: {
      checkDimensionStall: vi.fn().mockReturnValue(null),
      checkGlobalStall: vi.fn().mockReturnValue(null),
      checkTimeExceeded: vi.fn().mockReturnValue(null),
      checkConsecutiveFailures: vi.fn().mockReturnValue(null),
      getEscalationLevel: vi.fn().mockReturnValue(0),
      incrementEscalation: vi.fn().mockReturnValue(1),
      resetEscalation: vi.fn(),
      getStallState: vi.fn(),
      saveStallState: vi.fn(),
      classifyStallCause: vi.fn(),
      computeDecayFactor: vi.fn(),
      isSuppressed: vi.fn(),
    } as unknown as CoreLoopDeps["stallDetector"],
    strategyManager: {
      onStallDetected: vi.fn().mockResolvedValue(null),
      getActiveStrategy: vi.fn().mockReturnValue(null),
      getPortfolio: vi.fn(),
      generateCandidates: vi.fn(),
      activateBestCandidate: vi.fn(),
      updateState: vi.fn(),
      getStrategyHistory: vi.fn(),
    } as unknown as CoreLoopDeps["strategyManager"],
    reportingEngine: {
      generateExecutionSummary: vi.fn().mockReturnValue({ type: "execution_summary" }),
      saveReport: vi.fn(),
    } as unknown as CoreLoopDeps["reportingEngine"],
    driveSystem: {
      shouldActivate: vi.fn().mockReturnValue(true),
    } as unknown as CoreLoopDeps["driveSystem"],
    adapterRegistry: {
      getAdapter: vi.fn().mockReturnValue(adapter),
    } as unknown as CoreLoopDeps["adapterRegistry"],
  };

  return { deps, stateManager, satisficingJudgeMock, taskLifecycleMock };
}

// ─── Tests ───

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("R1-1: task cycle always runs within an iteration", () => {
  it("runs the task cycle even when goal dimensions are already above threshold", async () => {
    // This is the core bug fix: a goal that is already complete at the start of an
    // iteration (all dimensions at threshold+0.01) must still run a task cycle.
    // Previously the Step 5 early-return would skip the task cycle entirely.
    const { deps, stateManager, satisficingJudgeMock, taskLifecycleMock } = createDeps(tmpDir);

    // Save a goal whose quality dimension is already above the min threshold (9.5 >= 9.0)
    await stateManager.saveGoal(makeGoal());

    // Make isGoalComplete return true (pre-task) — simulates a goal already at threshold+0.01
    satisficingJudgeMock.isGoalComplete.mockReturnValue(
      makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
    );

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    const result = await loop.runOneIteration("goal-1", 0);

    // Completion should be true (from the post-task re-check which inherits the mock)
    expect(result.completionJudgment.is_complete).toBe(true);

    // R1-1: task cycle MUST have been called — no more short-circuit
    expect(taskLifecycleMock.runTaskCycle).toHaveBeenCalledOnce();
  });

  it("completionJudgment is set from the post-task re-check (not the pre-task check)", async () => {
    // The post-task re-check at Step 7 sets result.completionJudgment.
    // Here we simulate: pre-task says complete, post-task says not complete
    // (because the task might have changed the state). The final judgment should reflect
    // the post-task value.
    const { deps, stateManager, satisficingJudgeMock } = createDeps(tmpDir);
    await stateManager.saveGoal(makeGoal());

    let callCount = 0;
    satisficingJudgeMock.isGoalComplete.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Pre-task check: says complete
        return makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] });
      }
      // Post-task check: says not complete (e.g., observation was updated and gap reopened)
      return makeCompletionJudgment({ is_complete: false, blocking_dimensions: ["quality"] });
    });

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    const result = await loop.runOneIteration("goal-1", 0);

    // Post-task value wins
    expect(result.completionJudgment.is_complete).toBe(false);
    expect(result.completionJudgment.blocking_dimensions).toContain("quality");
  });
});

describe("R1-2: minIterations forces minimum number of full iterations", () => {
  it("default minIterations=1: loop exits after 1 iteration when goal is complete", async () => {
    const { deps, stateManager, satisficingJudgeMock } = createDeps(tmpDir);
    await stateManager.saveGoal(makeGoal());

    // Always complete
    satisficingJudgeMock.isGoalComplete.mockReturnValue(
      makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
    );

    const loop = new CoreLoop(deps, { maxIterations: 10, delayBetweenLoopsMs: 0 });
    const result = await loop.run("goal-1");

    expect(result.finalStatus).toBe("completed");
    // With default minIterations=1, loop exits after the first completed iteration (loopIndex=0)
    expect(result.totalIterations).toBe(1);
  });

  it("minIterations=2 forces at least 2 iterations even if goal is complete after iteration 1", async () => {
    const { deps, stateManager, satisficingJudgeMock } = createDeps(tmpDir);
    await stateManager.saveGoal(makeGoal());

    // Goal is complete on every check (including after iteration 0)
    satisficingJudgeMock.isGoalComplete.mockReturnValue(
      makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
    );

    const loop = new CoreLoop(deps, { maxIterations: 10, delayBetweenLoopsMs: 0, minIterations: 2 });
    const result = await loop.run("goal-1");

    expect(result.finalStatus).toBe("completed");
    // Must have run at least 2 iterations despite being complete after iteration 1
    expect(result.totalIterations).toBeGreaterThanOrEqual(2);
  });

  it("minIterations=3 forces exactly 3 iterations when goal is always complete", async () => {
    const { deps, stateManager, satisficingJudgeMock } = createDeps(tmpDir);
    await stateManager.saveGoal(makeGoal());

    satisficingJudgeMock.isGoalComplete.mockReturnValue(
      makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
    );

    const loop = new CoreLoop(deps, { maxIterations: 10, delayBetweenLoopsMs: 0, minIterations: 3 });
    const result = await loop.run("goal-1");

    expect(result.finalStatus).toBe("completed");
    // Should exit exactly at iteration 3 (loopIndex=2, which is minIterations-1)
    expect(result.totalIterations).toBe(3);
  });

  it("default minIterations=1 means at least one full task cycle always runs", async () => {
    const { deps, stateManager, satisficingJudgeMock, taskLifecycleMock } = createDeps(tmpDir);
    await stateManager.saveGoal(makeGoal());

    satisficingJudgeMock.isGoalComplete.mockReturnValue(
      makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
    );

    const loop = new CoreLoop(deps, { maxIterations: 10, delayBetweenLoopsMs: 0 });
    await loop.run("goal-1");

    // With default minIterations=1, at least one task cycle must run (R1-1 + R1-2 combined)
    expect(taskLifecycleMock.runTaskCycle).toHaveBeenCalledOnce();
  });

  it("minIterations=0 (explicit) allows immediate exit on completion in first iteration", async () => {
    // Setting minIterations=0 means loopIndex(0) >= 0-1 = -1, so condition is always met.
    // This restores the old immediate-exit behavior but at the loop level (task still runs per R1-1).
    const { deps, stateManager, satisficingJudgeMock } = createDeps(tmpDir);
    await stateManager.saveGoal(makeGoal());

    satisficingJudgeMock.isGoalComplete.mockReturnValue(
      makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
    );

    const loop = new CoreLoop(deps, { maxIterations: 10, delayBetweenLoopsMs: 0, minIterations: 0 });
    const result = await loop.run("goal-1");

    expect(result.finalStatus).toBe("completed");
    expect(result.totalIterations).toBe(1);
  });
});

describe("R1-1 + R1-2 combined: full flow guarantees", () => {
  it("a goal complete at start still executes task cycle AND loop still exits cleanly", async () => {
    const { deps, stateManager, satisficingJudgeMock, taskLifecycleMock } = createDeps(tmpDir);
    await stateManager.saveGoal(makeGoal());

    satisficingJudgeMock.isGoalComplete.mockReturnValue(
      makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
    );

    const loop = new CoreLoop(deps, { maxIterations: 10, delayBetweenLoopsMs: 0 });
    const result = await loop.run("goal-1");

    // Loop exits cleanly as "completed"
    expect(result.finalStatus).toBe("completed");
    // Task cycle ran (R1-1)
    expect(taskLifecycleMock.runTaskCycle).toHaveBeenCalledOnce();
    // Only 1 iteration (default minIterations=1)
    expect(result.totalIterations).toBe(1);
  });
});
