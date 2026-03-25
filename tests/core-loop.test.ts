import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const goal = {
    id: "goal-1",
    title: "Ship core coverage",
    status: "active",
    dimensions: [
      { name: "coverage", current_value: 0.9, confidence: 0.8 },
    ],
    children_ids: [],
  };

  const multiGoal = {
    ...goal,
    dimensions: [
      { name: "coverage", current_value: 0.6, confidence: 0.8 },
      { name: "reliability", current_value: 0.4, confidence: 0.7 },
    ],
  };

  const completedIteration = {
    loopIndex: 0,
    goalId: "goal-1",
    gapAggregate: 0,
    driveScores: [],
    taskResult: {
      task: { id: "task-1", primary_dimension: "coverage" },
      verificationResult: { verdict: "pass" },
      action: "completed",
    },
    stallDetected: false,
    stallReport: null,
    pivotOccurred: false,
    completionJudgment: {
      is_complete: true,
      blocking_dimensions: [],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: "2026-03-23T00:00:00.000Z",
    },
    elapsedMs: 1,
    error: null,
  };

  const taskGroup = {
    subtasks: [
      { id: "task-1", primary_dimension: "coverage" },
    ],
  };

  return {
    goal,
    completedIteration,
    taskGroup,
    stateManager: {
      loadGoal: vi.fn().mockResolvedValue(goal),
      saveGapHistory: vi.fn().mockResolvedValue(undefined),
      readRaw: vi.fn().mockResolvedValue(null),
      writeRaw: vi.fn().mockResolvedValue(undefined),
      saveGoal: vi.fn().mockResolvedValue(undefined),
      archiveGoal: vi.fn().mockResolvedValue(undefined),
      restoreFromCheckpoint: vi.fn().mockResolvedValue(undefined),
    },
    stallDetector: {
      resetEscalation: vi.fn().mockResolvedValue(undefined),
    },
    learning: {
      checkPeriodicReview: vi.fn().mockResolvedValue(undefined),
      onGoalCompleted: vi.fn().mockResolvedValue(undefined),
      getCapabilityFailures: vi.fn().mockReturnValue([]),
      incrementTransferCounter: vi.fn(),
    },
    strategyManager: {
      getActiveStrategy: vi.fn().mockResolvedValue({ id: "strategy-1" }),
    },
    reportingEngine: {
      generateExecutionSummary: vi.fn().mockReturnValue({ summary: true }),
      saveReport: vi.fn().mockResolvedValue(undefined),
    },
    parallelExecutor: {
      execute: vi.fn().mockResolvedValue({
        overall_verdict: "pass",
        results: [{ task_id: "task-1", verdict: "pass", output: "done" }],
      }),
    },
    generateTaskGroupFn: vi.fn().mockResolvedValue(taskGroup),
    multiGoal,
  };
});

vi.mock("../src/utils/sleep.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/loop/core-loop-phases.js", () => ({
  loadGoalWithAggregation: vi.fn(async (_ctx: unknown, _goalId: string, result: any) => {
    result.gapAggregate = 1;
    return mocks.goal;
  }),
  observeAndReload: vi.fn(async (_ctx: unknown, _goalId: string, goal: any) => goal),
  calculateGapOrComplete: vi.fn(),
  scoreDrivesAndCheckKnowledge: vi.fn(async () => ({ driveScores: [], highDissatisfactionDimensions: [] })),
}));

vi.mock("../src/loop/core-loop-phases-b.js", () => ({
  checkCompletionAndMilestones: vi.fn().mockResolvedValue(undefined),
  detectStallsAndRebalance: vi.fn().mockResolvedValue(undefined),
  checkDependencyBlock: vi.fn().mockReturnValue(false),
  runTaskCycleWithContext: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/loop/tree-loop-runner.js", () => ({
  runTreeIteration: vi.fn(),
  runMultiGoalIteration: vi.fn(),
}));

vi.mock("../src/execution/task-generation.js", () => ({
  evaluateTaskComplexity: vi.fn(),
  generateTaskGroup: vi.fn(),
}));

vi.mock("../src/loop/core-loop-learning.js", () => ({
  CoreLoopLearning: vi.fn().mockImplementation(() => ({
    checkPeriodicReview: vi.fn().mockResolvedValue(undefined),
    onGoalCompleted: vi.fn().mockResolvedValue(undefined),
    getCapabilityFailures: vi.fn().mockReturnValue([]),
    incrementTransferCounter: vi.fn(),
  })),
}));

describe("CoreLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks the goal completed when an iteration reports completion", async () => {
    const { CoreLoop } = await import("../src/core-loop.js");

    const loop = new CoreLoop({
      stateManager: mocks.stateManager as any,
      observationEngine: {} as any,
      gapCalculator: {} as any,
      driveScorer: {} as any,
      taskLifecycle: {} as any,
      satisficingJudge: {} as any,
      stallDetector: mocks.stallDetector as any,
      strategyManager: mocks.strategyManager as any,
      reportingEngine: mocks.reportingEngine as any,
      driveSystem: {} as any,
      adapterRegistry: { listAdapters: () => ["mock"] } as any,
      learningPipeline: {} as any,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    }, { maxIterations: 1 });

    vi.spyOn(loop, "runOneIteration").mockResolvedValueOnce(mocks.completedIteration as any);

    const result = await loop.run("goal-1");

    expect(result.finalStatus).toBe("completed");
    expect(mocks.stateManager.saveGoal).toHaveBeenCalledTimes(1);
    expect(mocks.stateManager.saveGoal).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("returns early from runOneIteration when the goal is already satisfied (gap=0 + SatisficingJudge)", async () => {
    const { CoreLoop } = await import("../src/core-loop.js");
    const calculateGapOrComplete = (await import("../src/loop/core-loop-phases.js")).calculateGapOrComplete as unknown as ReturnType<typeof vi.fn>;
    const checkCompletionAndMilestones = (await import("../src/loop/core-loop-phases-b.js")).checkCompletionAndMilestones as unknown as ReturnType<typeof vi.fn>;

    // gap=0 path: return skipTaskGeneration=true (no early completion — SatisficingJudge decides)
    calculateGapOrComplete.mockImplementationOnce(async (_ctx: unknown, _goalId: string, _goal: any, _loopIndex: number, result: any) => {
      result.gapAggregate = 0;
      return { gapVector: { goal_id: "goal-1", gaps: [], timestamp: "" }, gapAggregate: 0, skipTaskGeneration: true };
    });

    // SatisficingJudge (Phase 5) confirms completion
    checkCompletionAndMilestones.mockImplementationOnce(async (_ctx: unknown, _goalId: string, _goal: any, result: any) => {
      result.completionJudgment = {
        is_complete: true,
        blocking_dimensions: [],
        low_confidence_dimensions: [],
        needs_verification_task: false,
        checked_at: new Date().toISOString(),
      };
    });

    const loop = new CoreLoop({
      stateManager: mocks.stateManager as any,
      observationEngine: {} as any,
      gapCalculator: {} as any,
      driveScorer: {} as any,
      taskLifecycle: {} as any,
      satisficingJudge: {} as any,
      stallDetector: mocks.stallDetector as any,
      strategyManager: mocks.strategyManager as any,
      reportingEngine: mocks.reportingEngine as any,
      driveSystem: {} as any,
      adapterRegistry: { listAdapters: () => ["mock"] } as any,
      learningPipeline: {} as any,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    });

    const result = await loop.runOneIteration("goal-1", 0);

    expect(result.completionJudgment.is_complete).toBe(true);
    expect(result.taskResult).toBeNull();
    expect(mocks.reportingEngine.saveReport).toHaveBeenCalledTimes(1);
  });

  it("routes large goals through task-group generation and synthesizes a verification result", async () => {
    const { CoreLoop } = await import("../src/core-loop.js");

    const loop = new CoreLoop({
      stateManager: mocks.stateManager as any,
      observationEngine: {} as any,
      gapCalculator: {} as any,
      driveScorer: {} as any,
      taskLifecycle: {} as any,
      satisficingJudge: {} as any,
      stallDetector: mocks.stallDetector as any,
      strategyManager: mocks.strategyManager as any,
      reportingEngine: mocks.reportingEngine as any,
      driveSystem: {} as any,
      adapterRegistry: { listAdapters: () => ["mock"] } as any,
      parallelExecutor: mocks.parallelExecutor as any,
      generateTaskGroupFn: mocks.generateTaskGroupFn as any,
      learningPipeline: {} as any,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    });

    const runTaskCycle = (await import("../src/loop/core-loop-phases-b.js")).runTaskCycleWithContext as unknown as ReturnType<typeof vi.fn>;
    runTaskCycle.mockResolvedValue(true);
    const loadGoalWithAggregation = (await import("../src/loop/core-loop-phases.js")).loadGoalWithAggregation as unknown as ReturnType<typeof vi.fn>;
    loadGoalWithAggregation.mockResolvedValueOnce(mocks.multiGoal);
    const calculateGapOrComplete = (await import("../src/loop/core-loop-phases.js")).calculateGapOrComplete as unknown as ReturnType<typeof vi.fn>;
    calculateGapOrComplete.mockImplementationOnce(async (_ctx: unknown, _goalId: string, _goal: any, _loopIndex: number, result: any) => {
      result.gapAggregate = 2;
      return { gapVector: {}, gapAggregate: 2 };
    });

    const result = await loop.runOneIteration("goal-1", 0);

    expect(mocks.generateTaskGroupFn).toHaveBeenCalledTimes(1);
    expect(mocks.parallelExecutor.execute).toHaveBeenCalledTimes(1);
    expect(result.taskResult?.action).toBe("completed");
    expect(result.taskResult?.verificationResult.verdict).toBe("pass");
  });
});
