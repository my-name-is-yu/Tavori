import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import {
  CoreLoop,
  type CoreLoopDeps,
  type GapCalculatorModule,
  type DriveScorerModule,
  type ReportingEngine,
} from "../src/core-loop.js";
import { StateManager } from "../src/state-manager.js";
import type { ObservationEngine } from "../src/observation/observation-engine.js";
import type { TaskLifecycle, TaskCycleResult } from "../src/execution/task-lifecycle.js";
import type { SatisficingJudge } from "../src/drive/satisficing-judge.js";
import type { StallDetector } from "../src/drive/stall-detector.js";
import type { StrategyManager } from "../src/strategy/strategy-manager.js";
import type { DriveSystem } from "../src/drive/drive-system.js";
import type { AdapterRegistry, IAdapter } from "../src/execution/adapter-layer.js";
import type { GapVector } from "../src/types/gap.js";
import type { CompletionJudgment } from "../src/types/satisficing.js";
import type { DriveScore } from "../src/types/drive.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";

function makeGapVector(goalId = "goal-1"): GapVector {
  return {
    goal_id: goalId,
    gaps: [
      {
        dimension_name: "dim1",
        raw_gap: 5,
        normalized_gap: 0.5,
        normalized_weighted_gap: 0.5,
        confidence: 0.8,
        uncertainty_weight: 1.0,
      },
      {
        dimension_name: "dim2",
        raw_gap: 5,
        normalized_gap: 0.625,
        normalized_weighted_gap: 0.625,
        confidence: 0.7,
        uncertainty_weight: 1.0,
      },
    ],
    timestamp: new Date().toISOString(),
  };
}

function makeDriveScores(): DriveScore[] {
  return [
    {
      dimension_name: "dim1",
      dissatisfaction: 0.5,
      deadline: 0,
      opportunity: 0,
      final_score: 0.5,
      dominant_drive: "dissatisfaction",
    },
    {
      dimension_name: "dim2",
      dissatisfaction: 0.625,
      deadline: 0,
      opportunity: 0,
      final_score: 0.625,
      dominant_drive: "dissatisfaction",
    },
  ];
}

function makeCompletionJudgment(
  overrides: Partial<CompletionJudgment> = {}
): CompletionJudgment {
  return {
    is_complete: false,
    blocking_dimensions: ["dim1", "dim2"],
    low_confidence_dimensions: [],
    needs_verification_task: false,
    checked_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeTaskCycleResult(
  overrides: Partial<TaskCycleResult> = {}
): TaskCycleResult {
  return {
    task: {
      id: "task-1",
      goal_id: "goal-1",
      strategy_id: null,
      target_dimensions: ["dim1"],
      primary_dimension: "dim1",
      work_description: "Test task",
      rationale: "Test rationale",
      approach: "Test approach",
      success_criteria: [
        {
          description: "Test criterion",
          verification_method: "manual check",
          is_blocking: true,
        },
      ],
      scope_boundary: {
        in_scope: ["test"],
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
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      timeout_at: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
    },
    verificationResult: {
      task_id: "task-1",
      verdict: "pass",
      confidence: 0.9,
      evidence: [
        {
          layer: "mechanical",
          description: "Pass",
          confidence: 0.9,
        },
      ],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
    },
    action: "completed",
    ...overrides,
  };
}

function createMockAdapter(): IAdapter {
  return {
    adapterType: "openai_codex_cli",
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: "Task completed",
      error: null,
      exit_code: null,
      elapsed_ms: 1000,
      stopped_reason: "completed",
    }),
  };
}

function createMockDeps(tmpDir: string): {
  deps: CoreLoopDeps;
  mocks: {
    stateManager: StateManager;
    observationEngine: Record<string, ReturnType<typeof vi.fn>>;
    gapCalculator: Record<string, ReturnType<typeof vi.fn>>;
    driveScorer: Record<string, ReturnType<typeof vi.fn>>;
    taskLifecycle: Record<string, ReturnType<typeof vi.fn>>;
    satisficingJudge: Record<string, ReturnType<typeof vi.fn>>;
    stallDetector: Record<string, ReturnType<typeof vi.fn>>;
    strategyManager: Record<string, ReturnType<typeof vi.fn>>;
    reportingEngine: Record<string, ReturnType<typeof vi.fn>>;
    driveSystem: Record<string, ReturnType<typeof vi.fn>>;
    adapterRegistry: Record<string, ReturnType<typeof vi.fn>>;
    adapter: IAdapter;
  };
} {
  const stateManager = new StateManager(tmpDir);

  const adapter = createMockAdapter();

  const observationEngine = {
    observe: vi.fn(),
    applyObservation: vi.fn(),
    createObservationEntry: vi.fn(),
    getObservationLog: vi.fn(),
    saveObservationLog: vi.fn(),
    applyProgressCeiling: vi.fn(),
    getConfidenceTier: vi.fn(),
    resolveContradiction: vi.fn(),
    needsVerificationTask: vi.fn(),
  };

  const gapCalculator = {
    calculateGapVector: vi.fn().mockReturnValue(makeGapVector()),
    aggregateGaps: vi.fn().mockReturnValue(0.625),
  };

  const driveScorer = {
    scoreAllDimensions: vi.fn().mockReturnValue(makeDriveScores()),
    rankDimensions: vi.fn().mockImplementation((scores: DriveScore[]) =>
      [...scores].sort((a, b) => b.final_score - a.final_score)
    ),
  };

  const taskLifecycle = {
    runTaskCycle: vi.fn().mockResolvedValue(makeTaskCycleResult()),
    selectTargetDimension: vi.fn(),
    generateTask: vi.fn(),
    checkIrreversibleApproval: vi.fn(),
    executeTask: vi.fn(),
    verifyTask: vi.fn(),
    handleVerdict: vi.fn(),
    handleFailure: vi.fn(),
  };

  const satisficingJudge = {
    isGoalComplete: vi.fn().mockReturnValue(makeCompletionJudgment()),
    isDimensionSatisfied: vi.fn(),
    applyProgressCeiling: vi.fn(),
    selectDimensionsForIteration: vi.fn(),
    detectThresholdAdjustmentNeeded: vi.fn(),
    propagateSubgoalCompletion: vi.fn(),
  };

  const stallDetector = {
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
  };

  const strategyManager = {
    onStallDetected: vi.fn().mockResolvedValue(null),
    getActiveStrategy: vi.fn().mockReturnValue(null),
    getPortfolio: vi.fn(),
    generateCandidates: vi.fn(),
    activateBestCandidate: vi.fn(),
    updateState: vi.fn(),
    getStrategyHistory: vi.fn(),
  };

  const reportingEngine = {
    generateExecutionSummary: vi.fn().mockReturnValue({ type: "execution_summary" }),
    saveReport: vi.fn(),
  };

  const driveSystem = {
    shouldActivate: vi.fn().mockReturnValue(true),
    processEvents: vi.fn().mockReturnValue([]),
    readEventQueue: vi.fn().mockReturnValue([]),
    archiveEvent: vi.fn(),
    getSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    isScheduleDue: vi.fn(),
    createDefaultSchedule: vi.fn(),
    prioritizeGoals: vi.fn(),
  };

  const adapterRegistry = {
    getAdapter: vi.fn().mockReturnValue(adapter),
    register: vi.fn(),
    listAdapters: vi.fn().mockReturnValue(["openai_codex_cli"]),
  };

  const deps: CoreLoopDeps = {
    stateManager,
    observationEngine: observationEngine as unknown as ObservationEngine,
    gapCalculator: gapCalculator as unknown as GapCalculatorModule,
    driveScorer: driveScorer as unknown as DriveScorerModule,
    taskLifecycle: taskLifecycle as unknown as TaskLifecycle,
    satisficingJudge: satisficingJudge as unknown as SatisficingJudge,
    stallDetector: stallDetector as unknown as StallDetector,
    strategyManager: strategyManager as unknown as StrategyManager,
    reportingEngine: reportingEngine as unknown as ReportingEngine,
    driveSystem: driveSystem as unknown as DriveSystem,
    adapterRegistry: adapterRegistry as unknown as AdapterRegistry,
  };

  return {
    deps,
    mocks: {
      stateManager,
      observationEngine,
      gapCalculator,
      driveScorer,
      taskLifecycle,
      satisficingJudge,
      stallDetector,
      strategyManager,
      reportingEngine,
      driveSystem,
      adapterRegistry,
      adapter,
    },
  };
}

// ─── Tests ───

describe("CoreLoop", async () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── runOneIteration ───

  describe("runOneIteration", async () => {
    it("calls each step in correct order", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      const goal = makeGoal();
      await mocks.stateManager.saveGoal(goal);

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      // Gap calculation was called
      expect(mocks.gapCalculator.calculateGapVector).toHaveBeenCalledWith(
        "goal-1",
        goal.dimensions,
        goal.uncertainty_weight
      );
      expect(mocks.gapCalculator.aggregateGaps).toHaveBeenCalled();

      // Drive scoring was called
      expect(mocks.driveScorer.scoreAllDimensions).toHaveBeenCalled();
      expect(mocks.driveScorer.rankDimensions).toHaveBeenCalled();

      // Completion check was called
      expect(mocks.satisficingJudge.isGoalComplete).toHaveBeenCalledWith(goal);

      // Task cycle was called
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalled();

      // Report was generated
      expect(mocks.reportingEngine.generateExecutionSummary).toHaveBeenCalled();
      expect(mocks.reportingEngine.saveReport).toHaveBeenCalled();

      expect(result.error).toBeNull();
    });

    it("returns error when goal not found", async () => {
      const { deps } = createMockDeps(tmpDir);
      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("nonexistent", 0);

      expect(result.error).toContain("not found");
      expect(result.goalId).toBe("nonexistent");
    });

    it("populates gapAggregate from gap calculator", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.gapCalculator.aggregateGaps.mockReturnValue(0.75);

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.gapAggregate).toBe(0.75);
    });

    it("populates driveScores", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.driveScores.length).toBe(2);
    });

    it("populates loopIndex", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 7);

      expect(result.loopIndex).toBe(7);
    });

    it("records elapsed time", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it("persists gap history entry", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      const history = await mocks.stateManager.loadGapHistory("goal-1");
      expect(history.length).toBe(1);
      expect(history[0]!.iteration).toBe(0);
    });

    it("skips task generation when gapAggregate is 0", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      // Make the gap calculator return aggregate gap=0 (goal already achieved)
      const zeroGapVector: GapVector = {
        goal_id: "goal-1",
        gaps: [
          {
            dimension_name: "dim1",
            raw_gap: 0,
            normalized_gap: 0,
            normalized_weighted_gap: 0,
            confidence: 1.0,
            uncertainty_weight: 1.0,
          },
        ],
      };
      mocks.gapCalculator.calculateGapVector.mockReturnValue(zeroGapVector);
      mocks.gapCalculator.aggregateGaps.mockReturnValue(0);

      // SatisficingJudge confirms completion (gap=0 with high confidence)
      mocks.satisficingJudge.isGoalComplete.mockReturnValueOnce(
        makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.gapAggregate).toBe(0);
      expect(result.taskResult).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
      // SatisficingJudge (not gap=0 alone) determines completion
      expect(result.completionJudgment.is_complete).toBe(true);
    });
  });

  // ─── Completion detection ───

  describe("completion detection", async () => {
    it("returns completed result when goal is complete", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      mocks.satisficingJudge.isGoalComplete.mockReturnValue(
        makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.completionJudgment.is_complete).toBe(true);
      // R1-1: Task cycle ALWAYS runs within an iteration — the pre-task completion check
      // no longer causes an early-return. The post-task re-check sets completionJudgment.
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("stops the loop when goal is complete", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      mocks.satisficingJudge.isGoalComplete.mockReturnValue(
        makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
      );

      const loop = new CoreLoop(deps, { maxIterations: 100, delayBetweenLoopsMs: 0 });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("completed");
      expect(result.totalIterations).toBe(1);
    });

    it("stops loop when post-task completion check passes", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      const goal = makeGoal();
      await mocks.stateManager.saveGoal(goal);

      // First call: not complete. Second call (post-task): complete.
      let callCount = 0;
      mocks.satisficingJudge.isGoalComplete.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return makeCompletionJudgment({ is_complete: false });
        }
        return makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] });
      });

      const loop = new CoreLoop(deps, { maxIterations: 100, delayBetweenLoopsMs: 0 });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("completed");
    });
  });

  // ─── Error handling ───

  describe("error handling", async () => {
    it("handles gap calculation failure gracefully", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.gapCalculator.calculateGapVector.mockImplementation(() => {
        throw new Error("Gap calculation error");
      });

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toContain("Gap calculation");
      // Task cycle should not be called
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
    });

    it("handles drive scoring failure gracefully", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.driveScorer.scoreAllDimensions.mockImplementation(() => {
        throw new Error("Drive scoring error");
      });

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toContain("Drive scoring");
    });

    it("handles completion check failure gracefully", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.satisficingJudge.isGoalComplete.mockImplementation(() => {
        throw new Error("Completion check error");
      });

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toContain("Completion check");
    });

    it("handles task cycle failure gracefully", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockRejectedValue(
        new Error("Task cycle error")
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toContain("Task cycle");
    });

    it("stall detection failure does not crash the iteration", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.stallDetector.checkDimensionStall.mockImplementation(() => {
        throw new Error("Stall detection error");
      });

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      // Task cycle should still run
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalled();
      expect(result.error).toBeNull();
    });

    it("report generation failure does not crash the iteration", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.reportingEngine.generateExecutionSummary.mockImplementation(() => {
        throw new Error("Report error");
      });

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      // Iteration should still complete successfully
      expect(result.taskResult).not.toBeNull();
    });

    it("handles unexpected throw from runOneIteration gracefully in standalone mode", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      // Make observationEngine.observe throw an unexpected error that bypasses
      // the internal phase try/catches (simulates a truly unexpected failure).
      // We use stateManager.loadGoal throwing so the error surfaces before any
      // phase-level handler can catch it, forcing the top-level for-loop catch.
      const originalLoad = mocks.stateManager.loadGoal.bind(mocks.stateManager);
      let callCount = 0;
      vi.spyOn(mocks.stateManager, "loadGoal").mockImplementation(async (id: string) => {
        callCount++;
        // First call in run() succeeds (goal validation); subsequent calls throw.
        if (callCount === 1) return originalLoad(id);
        throw new Error("Unexpected internal error");
      });

      // maxConsecutiveErrors=2 so the loop exits after 2 consecutive throws.
      const loop = new CoreLoop(deps, {
        maxIterations: 5,
        maxConsecutiveErrors: 2,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      // Loop must not propagate the throw — it should exit with finalStatus "error".
      expect(result.finalStatus).toBe("error");
      // The loop should have stopped, not run all 5 iterations.
      expect(result.totalIterations).toBeLessThan(5);
    });
  });
});
