import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import {
  CoreLoop,
  type CoreLoopDeps,
  type GapCalculatorModule,
  type DriveScorerModule,
  type ReportingEngine,
} from "../src/loop/core-loop.js";
import { StateManager } from "../src/state/state-manager.js";
import type { ObservationEngine } from "../src/observation/observation-engine.js";
import type { TaskLifecycle, TaskCycleResult } from "../src/execution/task/task-lifecycle.js";
import type { SatisficingJudge } from "../src/drive/satisficing-judge.js";
import type { StallDetector } from "../src/drive/stall-detector.js";
import type { StrategyManager } from "../src/strategy/strategy-manager.js";
import type { DriveSystem } from "../src/drive/drive-system.js";
import type { AdapterRegistry, IAdapter } from "../src/execution/adapter-layer.js";
import type { GapVector } from "../src/types/gap.js";
import type { CompletionJudgment } from "../src/types/satisficing.js";
import type { StallReport } from "../src/types/stall.js";
import type { DriveScore } from "../src/types/drive.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal, makeDimension } from "./helpers/fixtures.js";

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

function makeStallReport(overrides: Partial<StallReport> = {}): StallReport {
  return {
    stall_type: "dimension_stall",
    goal_id: "goal-1",
    dimension_name: "dim1",
    task_id: null,
    detected_at: new Date().toISOString(),
    escalation_level: 0,
    suggested_cause: "approach_failure",
    decay_factor: 0.6,
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

  // ─── Report generation ───

  describe("report generation", async () => {
    it("calls reportingEngine.generateExecutionSummary", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal({
        dimensions: [
          makeDimension({ name: "dim1", label: "Dimension 1" }),
          makeDimension({ name: "dim2", label: "Dimension 2", current_value: 3, threshold: { type: "min", value: 8 }, confidence: 0.7, observation_method: { type: "mechanical", source: "test", schedule: null, endpoint: null, confidence_tier: "mechanical" } }),
        ],
      }));

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.reportingEngine.generateExecutionSummary).toHaveBeenCalledWith({
        goalId: "goal-1",
        loopIndex: 0,
        observation: expect.arrayContaining([
          expect.objectContaining({ dimensionName: "dim1" }),
          expect.objectContaining({ dimensionName: "dim2" }),
        ]),
        gapAggregate: expect.any(Number),
        taskResult: expect.objectContaining({ taskId: "task-1", action: "completed", dimension: "dim1" }),
        stallDetected: false,
        pivotOccurred: false,
        elapsedMs: expect.any(Number),
      });
    });

    it("calls reportingEngine.saveReport with generated report", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      const mockReport = { type: "test_report" };
      mocks.reportingEngine.generateExecutionSummary.mockReturnValue(mockReport);

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.reportingEngine.saveReport).toHaveBeenCalledWith(mockReport);
    });

    it("generates report on completion", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.satisficingJudge.isGoalComplete.mockReturnValue(
        makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.reportingEngine.generateExecutionSummary).toHaveBeenCalled();
    });

    it("generates report on task cycle error", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockRejectedValue(new Error("fail"));

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.reportingEngine.generateExecutionSummary).toHaveBeenCalled();
    });

    it("saves a final report after max_iterations exit", async () => {
      // Issue #188: max_iterations exit must produce at least one saved report.
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      // Never complete
      mocks.satisficingJudge.isGoalComplete.mockReturnValue(makeCompletionJudgment());

      const loop = new CoreLoop(deps, { maxIterations: 2, delayBetweenLoopsMs: 0 });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("max_iterations");
      // saveReport should have been called at least once (per-iteration + final)
      expect(mocks.reportingEngine.saveReport).toHaveBeenCalled();
    });

    it("saves a final report after stalled exit", async () => {
      // All exit paths must produce at least one saved report.
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.satisficingJudge.isGoalComplete.mockReturnValue(makeCompletionJudgment());
      // Always escalate to level 3 → stalled exit
      mocks.stallDetector.checkDimensionStall.mockReturnValue(
        makeStallReport({ escalation_level: 3 })
      );
      mocks.stallDetector.getEscalationLevel.mockReturnValue(3);

      const loop = new CoreLoop(deps, { maxIterations: 10, delayBetweenLoopsMs: 0 });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("stalled");
      expect(mocks.reportingEngine.saveReport).toHaveBeenCalled();
    });

    it("saves a final report after error exit", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockRejectedValue(new Error("persistent error"));

      const loop = new CoreLoop(deps, {
        maxIterations: 10,
        maxConsecutiveErrors: 1,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("error");
      expect(mocks.reportingEngine.saveReport).toHaveBeenCalled();
    });
  });

  // ─── Adapter resolution ───

  describe("adapter resolution", async () => {
    it("gets adapter from registry using configured adapterType", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, {
        delayBetweenLoopsMs: 0,
        adapterType: "test_adapter",
      });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.adapterRegistry.getAdapter).toHaveBeenCalledWith("test_adapter");
    });

    it("uses default adapter type (openai_codex_cli)", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.adapterRegistry.getAdapter).toHaveBeenCalledWith("openai_codex_cli");
    });

    it("passes adapter to taskLifecycle.runTaskCycle", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledWith(
        "goal-1",
        expect.any(Object), // gapVector
        expect.any(Object), // driveContext
        mocks.adapter,
        undefined, // knowledgeContext (no knowledge manager configured)
        undefined, // existingTasks (adapter has no listExistingTasks)
        undefined  // workspaceContext
      );
    });
  });

  // ─── Full integration-like tests ───

  describe("multi-iteration scenarios", async () => {
    it("runs multiple iterations before completion", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      let iterCount = 0;
      mocks.satisficingJudge.isGoalComplete.mockImplementation(() => {
        iterCount++;
        // Complete after 3rd iteration (called twice per iteration: pre and post task)
        if (iterCount >= 6) {
          return makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] });
        }
        return makeCompletionJudgment();
      });

      const loop = new CoreLoop(deps, {
        maxIterations: 100,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("completed");
      expect(result.totalIterations).toBe(3);
    });

    it("mixes errors and successes correctly", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      let callCount = 0;
      mocks.taskLifecycle.runTaskCycle.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error("Error on iteration 2");
        return makeTaskCycleResult();
      });

      const loop = new CoreLoop(deps, {
        maxIterations: 4,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.totalIterations).toBe(4);
      expect(result.iterations[0]!.error).toBeNull();
      expect(result.iterations[1]!.error).toContain("Task cycle");
      expect(result.iterations[2]!.error).toBeNull();
      expect(result.iterations[3]!.error).toBeNull();
    });

    it("handles stall then recovery", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      let callCount = 0;
      mocks.stallDetector.checkDimensionStall.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return makeStallReport({ escalation_level: 1 });
        }
        return null;
      });

      const loop = new CoreLoop(deps, {
        maxIterations: 4,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.totalIterations).toBe(4);
      expect(result.iterations[0]!.stallDetected).toBe(true);
      // Later iterations should not detect stalls (checkDimensionStall returns null)
    });
  });

  // ─── Gap history persistence ───

  describe("gap history", async () => {
    it("appends gap history across iterations", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, {
        maxIterations: 3,
        delayBetweenLoopsMs: 0,
      });
      await loop.run("goal-1");

      const history = await mocks.stateManager.loadGapHistory("goal-1");
      expect(history.length).toBe(3);
      expect(history[0]!.iteration).toBe(0);
      expect(history[1]!.iteration).toBe(1);
      expect(history[2]!.iteration).toBe(2);
    });

    it("gap history entries contain correct dimension data", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, {
        maxIterations: 1,
        delayBetweenLoopsMs: 0,
      });
      await loop.run("goal-1");

      const history = await mocks.stateManager.loadGapHistory("goal-1");
      expect(history[0]!.gap_vector).toHaveLength(2);
      expect(history[0]!.gap_vector[0]!.dimension_name).toBe("dim1");
      expect(history[0]!.gap_vector[1]!.dimension_name).toBe("dim2");
      expect(history[0]!.confidence_vector).toHaveLength(2);
    });
  });

  // ─── Edge cases ───

  describe("edge cases", async () => {
    it("handles goal with single dimension", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      const goal = makeGoal();
      goal.dimensions = [goal.dimensions[0]!];
      await mocks.stateManager.saveGoal(goal);

      mocks.gapCalculator.calculateGapVector.mockReturnValue({
        goal_id: "goal-1",
        gaps: [makeGapVector().gaps[0]!],
        timestamp: new Date().toISOString(),
      });
      mocks.driveScorer.scoreAllDimensions.mockReturnValue([makeDriveScores()[0]!]);

      const loop = new CoreLoop(deps, {
        maxIterations: 1,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.totalIterations).toBe(1);
    });

    it("handles goal with many dimensions", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      const goal = makeGoal();
      goal.dimensions = Array.from({ length: 10 }, (_, i) => ({
        ...goal.dimensions[0]!,
        name: `dim${i}`,
        label: `Dimension ${i}`,
      }));
      await mocks.stateManager.saveGoal(goal);

      const loop = new CoreLoop(deps, {
        maxIterations: 1,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.totalIterations).toBe(1);
    });

    it("handles cancelled goal status", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal({ status: "cancelled" }));

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("error");
      expect(result.totalIterations).toBe(0);
    });

    it("handles archived goal status", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal({ status: "archived" }));

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("error");
      expect(result.totalIterations).toBe(0);
    });

    it("re-checks completion after task cycle", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, {
        maxIterations: 1,
        delayBetweenLoopsMs: 0,
      });
      await loop.runOneIteration("goal-1", 0);

      // isGoalComplete should be called at least twice: once pre-task, once post-task
      expect(mocks.satisficingJudge.isGoalComplete.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── DriveContext passed to task cycle ───

  describe("DriveContext usage", async () => {
    it("passes correctly built DriveContext to task cycle", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      const deadline = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
      await mocks.stateManager.saveGoal(makeGoal({
        deadline,
        dimensions: [
          makeDimension({ name: "dim1", label: "Dimension 1" }),
          makeDimension({ name: "dim2", label: "Dimension 2", current_value: 3, threshold: { type: "min", value: 8 }, confidence: 0.7 }),
        ],
      }));

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      const callArgs = mocks.taskLifecycle.runTaskCycle.mock.calls[0];
      const driveContext = callArgs![2];

      expect(driveContext.time_since_last_attempt).toHaveProperty("dim1");
      expect(driveContext.time_since_last_attempt).toHaveProperty("dim2");
      expect(driveContext.deadlines.dim1).toBeGreaterThan(0);
    });
  });

  // ─── Concurrent stop() during run ───

  describe("concurrent stop()", async () => {
    it("stops between iterations", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, {
        maxIterations: 100,
        delayBetweenLoopsMs: 0,
      });

      let callCount = 0;
      mocks.taskLifecycle.runTaskCycle.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          loop.stop();
        }
        return makeTaskCycleResult();
      });

      const result = await loop.run("goal-1");
      expect(result.finalStatus).toBe("stopped");
      expect(result.totalIterations).toBeGreaterThanOrEqual(1);
    });
  });
});
