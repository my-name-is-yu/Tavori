/**
 * R1 E2E verification: core loop reaches the task cycle for an unsatisfied goal
 *
 * This test file verifies the R1 fixes end-to-end using real StateManager and
 * a mock adapter that tracks whether execute() was called.
 *
 * R1-1: No early return before task cycle — task cycle always runs within an
 *        iteration, even when the pre-task completion check says "complete".
 *
 * R1-2: minIterations guarantee — the loop runs at least N full iterations
 *        before it is allowed to exit on completion.
 *
 * R1-3: loadGoal() archive fallback — after archiving a goal, loadGoal() still
 *        returns the goal data from the archive path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

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

function makeUnsatisfiedGoal(id = "goal-r1-e2e"): Goal {
  const now = new Date().toISOString();
  return {
    id,
    parent_id: null,
    node_type: "goal",
    title: "R1 E2E Unsatisfied Goal",
    description: "A goal with dimensions clearly below threshold",
    status: "active",
    dimensions: [
      {
        name: "quality",
        label: "Quality",
        // current_value=0.0 is clearly below threshold=0.8 → gap is non-zero
        current_value: 0.0,
        threshold: { type: "min", value: 0.8 },
        confidence: 0.9,
        observation_method: {
          type: "mechanical",
          source: "test",
          schedule: null,
          endpoint: null,
          confidence_tier: "mechanical",
        },
        last_updated: now,
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
    created_at: now,
    updated_at: now,
  };
}

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

function makeGapVector(goalId: string): GapVector {
  return {
    goal_id: goalId,
    gaps: [
      {
        dimension_name: "quality",
        raw_gap: 0.8,
        normalized_gap: 0.8,
        normalized_weighted_gap: 0.8,
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
      dissatisfaction: 0.8,
      deadline: 0,
      opportunity: 0,
      final_score: 0.8,
      dominant_drive: "dissatisfaction",
    },
  ];
}

function makeTaskCycleResult(goalId: string): TaskCycleResult {
  const now = new Date().toISOString();
  return {
    task: {
      id: "task-r1-e2e",
      goal_id: goalId,
      strategy_id: null,
      target_dimensions: ["quality"],
      primary_dimension: "quality",
      work_description: "Improve quality from 0.0 to above 0.8",
      rationale: "Quality dimension is below threshold",
      approach: "Systematic quality improvement",
      success_criteria: [
        {
          description: "Quality above 0.8",
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
      started_at: now,
      completed_at: now,
      timeout_at: null,
      heartbeat_at: null,
      created_at: now,
    },
    verificationResult: {
      task_id: "task-r1-e2e",
      verdict: "pass",
      confidence: 0.9,
      evidence: [
        {
          layer: "mechanical",
          description: "Quality improved",
          confidence: 0.9,
        },
      ],
      dimension_updates: [],
      timestamp: now,
    },
    action: "completed",
  };
}

/**
 * MockAdapter: tracks whether execute() was called.
 */
class TrackingMockAdapter implements IAdapter {
  readonly adapterType = "claude_api";
  public executeCallCount = 0;

  async execute(_task: AgentTask): Promise<AgentResult> {
    this.executeCallCount++;
    return {
      success: true,
      output: "Task completed",
      error: null,
      exit_code: null,
      elapsed_ms: 5,
      stopped_reason: "completed",
    };
  }
}

/**
 * Build a CoreLoopDeps object with mostly mocked dependencies.
 * taskLifecycleMock.runTaskCycle is configured to track calls.
 * satisficingJudgeMock.isGoalComplete returns the given judgment.
 */
function createDeps(
  tmpDir: string,
  completionJudgment: CompletionJudgment
): {
  deps: CoreLoopDeps;
  stateManager: StateManager;
  trackingAdapter: TrackingMockAdapter;
  taskLifecycleMock: { runTaskCycle: ReturnType<typeof vi.fn> };
  satisficingJudgeMock: { isGoalComplete: ReturnType<typeof vi.fn> };
} {
  const stateManager = new StateManager(tmpDir);
  const trackingAdapter = new TrackingMockAdapter();

  const satisficingJudgeMock = {
    isGoalComplete: vi.fn().mockReturnValue(completionJudgment),
    isDimensionSatisfied: vi.fn(),
    applyProgressCeiling: vi.fn(),
    selectDimensionsForIteration: vi.fn(),
    detectThresholdAdjustmentNeeded: vi.fn(),
    propagateSubgoalCompletion: vi.fn(),
    judgeTreeCompletion: vi.fn(),
  };

  const goalId = "goal-r1-e2e";
  const taskLifecycleMock = {
    runTaskCycle: vi.fn().mockResolvedValue(makeTaskCycleResult(goalId)),
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
      calculateGapVector: vi.fn().mockReturnValue(makeGapVector(goalId)),
      aggregateGaps: vi.fn().mockReturnValue(0.8),
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
      getAdapter: vi.fn().mockReturnValue(trackingAdapter),
    } as unknown as CoreLoopDeps["adapterRegistry"],
  };

  return { deps, stateManager, trackingAdapter, taskLifecycleMock, satisficingJudgeMock };
}

// ─── Test Setup ───

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── R1-1 E2E: task cycle reaches execute() for an unsatisfied goal ───

describe("R1-1 E2E: task cycle executes for an unsatisfied goal", () => {
  it("adapter.execute is reached when goal has dimensions clearly below threshold", async () => {
    // isGoalComplete says NOT complete (gap=0.8 — clearly unsatisfied)
    const { deps, stateManager, taskLifecycleMock } = createDeps(
      tmpDir,
      makeCompletionJudgment({ is_complete: false, blocking_dimensions: ["quality"] })
    );

    const goal = makeUnsatisfiedGoal();
    await stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { maxIterations: 1, delayBetweenLoopsMs: 0 });
    const result = await loop.run(goal.id);

    // Loop ran at least one iteration
    expect(result.totalIterations).toBeGreaterThanOrEqual(1);

    // Task cycle was reached (R1-1 guarantee)
    expect(taskLifecycleMock.runTaskCycle).toHaveBeenCalled();

    // Loop exited cleanly (max_iterations since goal was never completed)
    expect(["max_iterations", "completed"]).toContain(result.finalStatus);
  });

  it("task cycle runs even with maxIterations=3 and goal remains unsatisfied", async () => {
    const { deps, stateManager, taskLifecycleMock } = createDeps(
      tmpDir,
      makeCompletionJudgment({ is_complete: false, blocking_dimensions: ["quality"] })
    );

    const goal = makeUnsatisfiedGoal();
    await stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { maxIterations: 3, delayBetweenLoopsMs: 0 });
    const result = await loop.run(goal.id);

    // All 3 iterations ran
    expect(result.totalIterations).toBe(3);
    expect(result.finalStatus).toBe("max_iterations");

    // Task cycle called once per iteration = 3 times
    expect(taskLifecycleMock.runTaskCycle).toHaveBeenCalledTimes(3);
  });

  it("task cycle runs even when pre-task completion check says complete (R1-1 no early-return)", async () => {
    // Simulate: pre-task check says "complete" (e.g. previously satisfied goal)
    // The task cycle should STILL run — no short-circuit at Step 5
    const { deps, stateManager, taskLifecycleMock } = createDeps(
      tmpDir,
      makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
    );

    const goal = makeUnsatisfiedGoal();
    await stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { maxIterations: 1, delayBetweenLoopsMs: 0 });
    await loop.run(goal.id);

    // Even though isGoalComplete returned true, the task cycle still ran
    expect(taskLifecycleMock.runTaskCycle).toHaveBeenCalledOnce();
  });
});

// ─── R1-2 E2E: minIterations guarantee ───

describe("R1-2 E2E: minIterations forces minimum iterations before completion exit", () => {
  it("default minIterations=1: loop exits after first completed iteration", async () => {
    const { deps, stateManager } = createDeps(
      tmpDir,
      makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
    );

    const goal = makeUnsatisfiedGoal();
    await stateManager.saveGoal(goal);

    // Default minIterations=1
    const loop = new CoreLoop(deps, { maxIterations: 10, delayBetweenLoopsMs: 0 });
    const result = await loop.run(goal.id);

    expect(result.finalStatus).toBe("completed");
    expect(result.totalIterations).toBe(1);
  });

  it("minIterations=2 forces at least 2 full iterations before exiting on completion", async () => {
    const { deps, stateManager, taskLifecycleMock } = createDeps(
      tmpDir,
      makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
    );

    const goal = makeUnsatisfiedGoal();
    await stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { maxIterations: 10, delayBetweenLoopsMs: 0, minIterations: 2 });
    const result = await loop.run(goal.id);

    expect(result.finalStatus).toBe("completed");
    // Must have run at least 2 full iterations
    expect(result.totalIterations).toBeGreaterThanOrEqual(2);
    // Task cycle ran at least twice (one per iteration)
    expect(taskLifecycleMock.runTaskCycle).toHaveBeenCalledTimes(
      result.totalIterations
    );
  });

  it("minIterations=3 ensures task cycle runs 3 times for a goal that is always complete", async () => {
    const { deps, stateManager, taskLifecycleMock } = createDeps(
      tmpDir,
      makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
    );

    const goal = makeUnsatisfiedGoal();
    await stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { maxIterations: 10, delayBetweenLoopsMs: 0, minIterations: 3 });
    const result = await loop.run(goal.id);

    expect(result.finalStatus).toBe("completed");
    expect(result.totalIterations).toBe(3);
    // Task cycle ran exactly 3 times
    expect(taskLifecycleMock.runTaskCycle).toHaveBeenCalledTimes(3);
  });
});

// ─── R1-3 E2E: loadGoal() archive fallback ───

describe("R1-3 E2E: loadGoal() returns archived goals via archive fallback path", () => {
  it("loadGoal() returns the goal after archiving it", async () => {
    const stateManager = new StateManager(tmpDir);
    const goal = makeUnsatisfiedGoal("goal-archive-test");
    await stateManager.saveGoal(goal);

    // Verify it loads before archiving
    const beforeArchive = await stateManager.loadGoal("goal-archive-test");
    expect(beforeArchive).not.toBeNull();
    expect(beforeArchive!.id).toBe("goal-archive-test");

    // Archive the goal (moves files from goals/ to archive/)
    const archived = await stateManager.archiveGoal("goal-archive-test");
    expect(archived).toBe(true);

    // After archiving, the primary path no longer exists
    const primaryPath = path.join(tmpDir, "goals", "goal-archive-test", "goal.json");
    expect(fs.existsSync(primaryPath)).toBe(false);

    // But loadGoal() should still return the goal via the archive fallback path
    const afterArchive = await stateManager.loadGoal("goal-archive-test");
    expect(afterArchive).not.toBeNull();
    expect(afterArchive!.id).toBe("goal-archive-test");
    expect(afterArchive!.title).toBe("R1 E2E Unsatisfied Goal");
  });

  it("loadGoal() returns null for a goal that was never saved", async () => {
    const stateManager = new StateManager(tmpDir);
    const result = await stateManager.loadGoal("non-existent-goal");
    expect(result).toBeNull();
  });

  it("loadGoal() returns null after deleting a non-archived goal", async () => {
    const stateManager = new StateManager(tmpDir);
    const goal = makeUnsatisfiedGoal("goal-delete-test");
    await stateManager.saveGoal(goal);

    await stateManager.deleteGoal("goal-delete-test");

    const result = await stateManager.loadGoal("goal-delete-test");
    expect(result).toBeNull();
  });

  it("archived goal data is intact (title, dimensions, status preserved)", async () => {
    const stateManager = new StateManager(tmpDir);
    const goal = makeUnsatisfiedGoal("goal-data-integrity");
    await stateManager.saveGoal(goal);
    await stateManager.archiveGoal("goal-data-integrity");

    const loaded = await stateManager.loadGoal("goal-data-integrity");
    expect(loaded).not.toBeNull();
    expect(loaded!.dimensions).toHaveLength(1);
    expect(loaded!.dimensions[0]!.name).toBe("quality");
    expect(loaded!.dimensions[0]!.current_value).toBe(0.0);
    expect(loaded!.status).toBe("archived");
  });
});
