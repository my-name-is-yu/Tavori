/**
 * R8 E2E verification: error resilience
 *
 * Tests that PulSeed's CoreLoop handles and recovers from various failures gracefully:
 *
 *   R8-1: Adapter execution failure + retry — Mock adapter fails on first call, succeeds
 *          on second. Loop continues after retry.
 *
 *   R8-2: LLM call failure with fallback — Mock LLM throws on first call. Verify the
 *          loop records the error in the iteration result and continues cleanly.
 *
 *   R8-3: Corrupt state recovery — Provide a goal with dimension values outside normal
 *          range. Verify the system handles it gracefully instead of crashing.
 *
 *   R8-4: Multiple consecutive errors don't crash — Run loop where runTaskCycle fails N
 *          times. Verify loop terminates cleanly with error status, not an unhandled exception.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";

import { CoreLoop, type CoreLoopDeps } from "../../src/core-loop.js";
import { StateManager } from "../../src/state-manager.js";
import type { IAdapter, AgentTask, AgentResult } from "../../src/execution/adapter-layer.js";
import type { Goal } from "../../src/types/goal.js";
import type { CompletionJudgment } from "../../src/types/satisficing.js";
import type { GapVector } from "../../src/types/gap.js";
import type { DriveScore } from "../../src/types/drive.js";
import type { TaskCycleResult } from "../../src/execution/task-lifecycle.js";
import { makeTempDir } from "../helpers/temp-dir.js";

// ─── Helpers ───

const BASE_NOW = new Date().toISOString();

function makeActiveGoal(id: string, currentValue = 0.2): Goal {
  return {
    id,
    parent_id: null,
    node_type: "goal",
    title: "R8 Error Resilience Goal",
    description: "Goal for error resilience testing",
    status: "active",
    dimensions: [
      {
        name: "quality",
        label: "Quality",
        current_value: currentValue,
        threshold: { type: "min", value: 0.8 },
        confidence: 0.9,
        observation_method: {
          type: "mechanical",
          source: "test",
          schedule: null,
          endpoint: null,
          confidence_tier: "mechanical",
        },
        last_updated: BASE_NOW,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
        state_integrity: "ok",
        dimension_mapping: null,
      },
    ],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: null,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: 0,
    specificity_score: null,
    loop_status: "idle",
    created_at: BASE_NOW,
    updated_at: BASE_NOW,
  };
}

function makeCompletionJudgment(overrides: Partial<CompletionJudgment> = {}): CompletionJudgment {
  return {
    is_complete: false,
    blocking_dimensions: ["quality"],
    low_confidence_dimensions: [],
    needs_verification_task: false,
    checked_at: BASE_NOW,
    ...overrides,
  };
}

function makeGapVector(goalId: string, gap = 0.6): GapVector {
  return {
    goal_id: goalId,
    gaps: [
      {
        dimension_name: "quality",
        raw_gap: gap,
        normalized_gap: gap,
        normalized_weighted_gap: gap,
        confidence: 0.9,
        uncertainty_weight: 1.0,
      },
    ],
    timestamp: BASE_NOW,
  };
}

function makeDriveScores(): DriveScore[] {
  return [
    {
      dimension_name: "quality",
      dissatisfaction: 0.6,
      deadline: 0,
      opportunity: 0,
      final_score: 0.6,
      dominant_drive: "dissatisfaction",
    },
  ];
}

function makeSuccessTaskCycleResult(goalId: string): TaskCycleResult {
  return {
    task: {
      id: "task-r8",
      goal_id: goalId,
      strategy_id: null,
      target_dimensions: ["quality"],
      primary_dimension: "quality",
      work_description: "Improve quality",
      rationale: "Quality is below threshold",
      approach: "Systematic improvement",
      success_criteria: [
        {
          description: "Quality above threshold",
          verification_method: "mechanical check",
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
      started_at: BASE_NOW,
      completed_at: BASE_NOW,
      timeout_at: null,
      heartbeat_at: null,
      created_at: BASE_NOW,
    },
    verificationResult: {
      task_id: "task-r8",
      verdict: "pass",
      confidence: 0.9,
      evidence: [{ layer: "mechanical", description: "Improved", confidence: 0.9 }],
      dimension_updates: [
        { dimension_name: "quality", previous_value: 0.2, new_value: 0.5, confidence: 0.9 },
      ],
      timestamp: BASE_NOW,
    },
    action: "completed",
  };
}

/**
 * Creates a minimal mock CoreLoopDeps with configurable task lifecycle mock.
 */
function createDeps(
  stateManager: StateManager,
  goalId: string,
  taskLifecycleMock: { runTaskCycle: ReturnType<typeof vi.fn> },
  completionOverrides: Partial<CompletionJudgment> = {}
): CoreLoopDeps {
  return {
    stateManager,
    observationEngine: {
      observe: vi.fn().mockResolvedValue(undefined),
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
      calculateGapVector: vi.fn().mockReturnValue(makeGapVector(goalId)),
      aggregateGaps: vi.fn().mockReturnValue(0.6),
    } as unknown as CoreLoopDeps["gapCalculator"],
    driveScorer: {
      scoreAllDimensions: vi.fn().mockReturnValue(makeDriveScores()),
      rankDimensions: vi.fn().mockImplementation((s: DriveScore[]) => [...s]),
    } as unknown as CoreLoopDeps["driveScorer"],
    taskLifecycle: taskLifecycleMock as unknown as CoreLoopDeps["taskLifecycle"],
    satisficingJudge: {
      isGoalComplete: vi.fn().mockReturnValue(makeCompletionJudgment(completionOverrides)),
      isDimensionSatisfied: vi.fn(),
      applyProgressCeiling: vi.fn(),
      selectDimensionsForIteration: vi.fn(),
      detectThresholdAdjustmentNeeded: vi.fn(),
      propagateSubgoalCompletion: vi.fn(),
      judgeTreeCompletion: vi.fn(),
    } as unknown as CoreLoopDeps["satisficingJudge"],
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
      getAdapter: vi.fn().mockReturnValue({
        adapterType: "claude_api",
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "ok",
          error: null,
          exit_code: null,
          elapsed_ms: 5,
          stopped_reason: "completed",
        } as AgentResult),
      } as IAdapter),
    } as unknown as CoreLoopDeps["adapterRegistry"],
  };
}

// ─── Test Setup ───

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── R8-1: Adapter execution failure + retry ───

describe("R8-1: Adapter execution failure + retry", () => {
  it("loop continues after adapter fails on first call and succeeds on second", async () => {
    const stateManager = new StateManager(tmpDir);
    const goalId = "goal-r8-1";
    const goal = makeActiveGoal(goalId);
    await stateManager.saveGoal(goal);

    let callCount = 0;
    // First runTaskCycle simulates adapter failure (throws), second succeeds
    const taskLifecycleMock = {
      runTaskCycle: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Adapter connection refused");
        }
        return makeSuccessTaskCycleResult(goalId);
      }),
      selectTargetDimension: vi.fn(),
      generateTask: vi.fn(),
      checkIrreversibleApproval: vi.fn(),
      executeTask: vi.fn(),
      verifyTask: vi.fn(),
      handleVerdict: vi.fn(),
      handleFailure: vi.fn(),
      setOnTaskComplete: vi.fn(),
    };

    const deps = createDeps(stateManager, goalId, taskLifecycleMock);
    const loop = new CoreLoop(deps, { maxIterations: 3, delayBetweenLoopsMs: 0 });
    const result = await loop.run(goalId);

    // Loop should not have thrown — it must return a LoopResult
    expect(result).toBeDefined();
    expect(result.goalId).toBe(goalId);

    // Loop ran at least 2 iterations (first error, then success)
    expect(result.totalIterations).toBeGreaterThanOrEqual(2);

    // First iteration should record an error
    const firstIter = result.iterations[0]!;
    expect(firstIter.error).not.toBeNull();

    // Second iteration (after retry) should succeed
    const secondIter = result.iterations[1]!;
    expect(secondIter.error).toBeNull();
    expect(secondIter.taskResult).not.toBeNull();
  });
});

// ─── R8-2: LLM call failure with fallback ───

describe("R8-2: LLM call failure with fallback", () => {
  it("loop records error in iteration result when runTaskCycle throws an LLM error", async () => {
    const stateManager = new StateManager(tmpDir);
    const goalId = "goal-r8-2";
    const goal = makeActiveGoal(goalId);
    await stateManager.saveGoal(goal);

    // runTaskCycle throws to simulate LLM failure on first call, succeeds after
    let llmCallCount = 0;
    const taskLifecycleMock = {
      runTaskCycle: vi.fn().mockImplementation(async () => {
        llmCallCount++;
        if (llmCallCount === 1) {
          throw new Error("LLM API rate limit exceeded");
        }
        return makeSuccessTaskCycleResult(goalId);
      }),
      selectTargetDimension: vi.fn(),
      generateTask: vi.fn(),
      checkIrreversibleApproval: vi.fn(),
      executeTask: vi.fn(),
      verifyTask: vi.fn(),
      handleVerdict: vi.fn(),
      handleFailure: vi.fn(),
      setOnTaskComplete: vi.fn(),
    };

    const deps = createDeps(stateManager, goalId, taskLifecycleMock);
    const loop = new CoreLoop(deps, { maxIterations: 3, delayBetweenLoopsMs: 0 });

    // Must not throw an unhandled exception
    let loopError: unknown = null;
    let result;
    try {
      result = await loop.run(goalId);
    } catch (err) {
      loopError = err;
    }

    expect(loopError).toBeNull();
    expect(result).toBeDefined();

    // The first iteration should record the LLM error
    const errorIter = result!.iterations.find((i) => i.error !== null);
    expect(errorIter).toBeDefined();
    expect(errorIter!.error).toContain("LLM API rate limit exceeded");

    // After the error, subsequent iterations should continue (runTaskCycle called again)
    expect(llmCallCount).toBeGreaterThanOrEqual(2);
  });
});

// ─── R8-3: Corrupt state recovery ───

describe("R8-3: Corrupt state recovery", () => {
  it("loop handles goal with out-of-range dimension values gracefully", async () => {
    const stateManager = new StateManager(tmpDir);
    const goalId = "goal-r8-3";
    // Dimension current_value is intentionally outside [0,1] range to simulate corrupt state
    const goal = makeActiveGoal(goalId, -999);
    await stateManager.saveGoal(goal);

    const taskLifecycleMock = {
      runTaskCycle: vi.fn().mockResolvedValue(makeSuccessTaskCycleResult(goalId)),
      selectTargetDimension: vi.fn(),
      generateTask: vi.fn(),
      checkIrreversibleApproval: vi.fn(),
      executeTask: vi.fn(),
      verifyTask: vi.fn(),
      handleVerdict: vi.fn(),
      handleFailure: vi.fn(),
      setOnTaskComplete: vi.fn(),
    };

    const deps = createDeps(stateManager, goalId, taskLifecycleMock);
    const loop = new CoreLoop(deps, { maxIterations: 1, delayBetweenLoopsMs: 0 });

    // The system must not throw an unhandled exception even with corrupt dimension values
    let loopError: unknown = null;
    let result;
    try {
      result = await loop.run(goalId);
    } catch (err) {
      loopError = err;
    }

    expect(loopError).toBeNull();
    expect(result).toBeDefined();
    // Loop ran (did not crash)
    expect(result!.goalId).toBe(goalId);
  });

  it("loop returns error finalStatus for a non-existent goal instead of crashing", async () => {
    const stateManager = new StateManager(tmpDir);
    const goalId = "goal-r8-3-nonexistent";
    // Intentionally NOT saving the goal — it does not exist

    const taskLifecycleMock = {
      runTaskCycle: vi.fn().mockResolvedValue(makeSuccessTaskCycleResult(goalId)),
      selectTargetDimension: vi.fn(),
      generateTask: vi.fn(),
      checkIrreversibleApproval: vi.fn(),
      executeTask: vi.fn(),
      verifyTask: vi.fn(),
      handleVerdict: vi.fn(),
      handleFailure: vi.fn(),
      setOnTaskComplete: vi.fn(),
    };

    const deps = createDeps(stateManager, goalId, taskLifecycleMock);
    const loop = new CoreLoop(deps, { maxIterations: 1, delayBetweenLoopsMs: 0 });

    const result = await loop.run(goalId);

    // Should return error status cleanly, not throw
    expect(result).toBeDefined();
    expect(result.finalStatus).toBe("error");
    expect(result.totalIterations).toBe(0);
  });
});

// ─── R8-4: Multiple consecutive errors don't crash ───

describe("R8-4: Multiple consecutive errors don't crash", () => {
  it("loop terminates cleanly with error finalStatus after maxConsecutiveErrors failures", async () => {
    const stateManager = new StateManager(tmpDir);
    const goalId = "goal-r8-4";
    const goal = makeActiveGoal(goalId);
    await stateManager.saveGoal(goal);

    // runTaskCycle always throws — simulates persistent adapter/LLM failure
    const taskLifecycleMock = {
      runTaskCycle: vi.fn().mockRejectedValue(new Error("Persistent failure")),
      selectTargetDimension: vi.fn(),
      generateTask: vi.fn(),
      checkIrreversibleApproval: vi.fn(),
      executeTask: vi.fn(),
      verifyTask: vi.fn(),
      handleVerdict: vi.fn(),
      handleFailure: vi.fn(),
      setOnTaskComplete: vi.fn(),
    };

    const deps = createDeps(stateManager, goalId, taskLifecycleMock);
    // maxConsecutiveErrors=3: loop should stop after 3 consecutive errors
    const loop = new CoreLoop(deps, {
      maxIterations: 10,
      maxConsecutiveErrors: 3,
      delayBetweenLoopsMs: 0,
    });

    let loopError: unknown = null;
    let result;
    try {
      result = await loop.run(goalId);
    } catch (err) {
      loopError = err;
    }

    // Must not propagate an unhandled exception
    expect(loopError).toBeNull();
    expect(result).toBeDefined();

    // Loop must exit cleanly with "error" status
    expect(result!.finalStatus).toBe("error");

    // Each failed iteration should record an error string
    for (const iter of result!.iterations) {
      expect(iter.error).not.toBeNull();
    }

    // Exactly maxConsecutiveErrors iterations before stopping
    expect(result!.totalIterations).toBe(3);
  });

  it("loop resets consecutive error count after a successful iteration", async () => {
    const stateManager = new StateManager(tmpDir);
    const goalId = "goal-r8-4b";
    const goal = makeActiveGoal(goalId);
    await stateManager.saveGoal(goal);

    // Pattern: fail, fail, succeed, fail, fail, succeed, ...
    // Loop should not stop after 2 consecutive failures when maxConsecutiveErrors=3
    let callIndex = 0;
    const taskLifecycleMock = {
      runTaskCycle: vi.fn().mockImplementation(async () => {
        callIndex++;
        if (callIndex % 3 !== 0) {
          throw new Error("Intermittent failure");
        }
        return makeSuccessTaskCycleResult(goalId);
      }),
      selectTargetDimension: vi.fn(),
      generateTask: vi.fn(),
      checkIrreversibleApproval: vi.fn(),
      executeTask: vi.fn(),
      verifyTask: vi.fn(),
      handleVerdict: vi.fn(),
      handleFailure: vi.fn(),
      setOnTaskComplete: vi.fn(),
    };

    const deps = createDeps(stateManager, goalId, taskLifecycleMock);
    const loop = new CoreLoop(deps, {
      maxIterations: 6,
      maxConsecutiveErrors: 3,
      delayBetweenLoopsMs: 0,
    });

    const result = await loop.run(goalId);

    // Loop should not have stopped early due to error — pattern resets count before reaching 3
    expect(result).toBeDefined();
    // Should run all 6 iterations (consecutive errors never reach 3 since every 3rd succeeds)
    expect(result.totalIterations).toBe(6);
    expect(result.finalStatus).toBe("max_iterations");
  });
});
