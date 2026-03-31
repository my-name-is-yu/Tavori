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
      restoreFromCheckpoint: vi.fn().mockResolvedValue(0),
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
  phaseAutoDecompose: vi.fn().mockResolvedValue(undefined),
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
  CoreLoopLearning: vi.fn().mockImplementation(function() { return {
    checkPeriodicReview: vi.fn().mockResolvedValue(undefined),
    onGoalCompleted: vi.fn().mockResolvedValue(undefined),
    getCapabilityFailures: vi.fn().mockReturnValue([]),
    incrementTransferCounter: vi.fn(),
  }; }),
}));

// Helper to build a minimal CoreLoop deps object
async function makeDeps(overrides: Record<string, any> = {}) {
  return {
    stateManager: mocks.stateManager,
    observationEngine: {},
    gapCalculator: {},
    driveScorer: {},
    taskLifecycle: {},
    satisficingJudge: {},
    stallDetector: mocks.stallDetector,
    strategyManager: mocks.strategyManager,
    reportingEngine: mocks.reportingEngine,
    driveSystem: {},
    adapterRegistry: { listAdapters: () => ["mock"] },
    learningPipeline: {},
    ...overrides,
  };
}

describe("CoreLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mutable shared objects to prevent state leakage between tests.
    // runPostLoopHooks mutates goalState.status = "completed" on the returned object,
    // so we must restore the original values before each test.
    mocks.goal.status = "active";
    mocks.goal.children_ids = [];
    // Re-apply default implementations cleared by clearAllMocks
    mocks.stateManager.loadGoal.mockResolvedValue(mocks.goal);
    mocks.stateManager.saveGapHistory.mockResolvedValue(undefined);
    mocks.stateManager.readRaw.mockResolvedValue(null);
    mocks.stateManager.writeRaw.mockResolvedValue(undefined);
    mocks.stateManager.saveGoal.mockResolvedValue(undefined);
    mocks.stateManager.archiveGoal.mockResolvedValue(undefined);
    mocks.stateManager.restoreFromCheckpoint.mockResolvedValue(0);
    mocks.stallDetector.resetEscalation.mockResolvedValue(undefined);
    mocks.strategyManager.getActiveStrategy.mockResolvedValue({ id: "strategy-1" });
    mocks.reportingEngine.generateExecutionSummary.mockReturnValue({ summary: true });
    mocks.reportingEngine.saveReport.mockResolvedValue(undefined);
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

  // ─── run() early-exit branches ───

  it("returns error result when goal is not found (null)", async () => {
    const { CoreLoop } = await import("../src/core-loop.js");
    mocks.stateManager.loadGoal.mockResolvedValueOnce(null);

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
    }, { maxIterations: 1 });

    const result = await loop.run("goal-missing");
    expect(result.finalStatus).toBe("error");
    expect(result.totalIterations).toBe(0);
  });

  it("returns error result when goal status is not active or waiting", async () => {
    const { CoreLoop } = await import("../src/core-loop.js");
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    mocks.stateManager.loadGoal.mockResolvedValueOnce({ ...mocks.goal, status: "completed" });

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
      logger: logger as any,
    }, { maxIterations: 1 });

    const result = await loop.run("goal-1");
    expect(result.finalStatus).toBe("error");
    expect(result.errorMessage).toContain("completed");
    expect(logger.error).toHaveBeenCalled();
  });


  it("dryRun=true skips saving checkpoints", async () => {
    const { CoreLoop } = await import("../src/core-loop.js");

    const iterationWithTask = {
      ...mocks.completedIteration,
      completionJudgment: { ...mocks.completedIteration.completionJudgment, is_complete: false },
      error: null,
      taskResult: { action: "completed", task: {}, verificationResult: { verdict: "pass" } },
      skipped: false,
    };
    const completingIteration = { ...mocks.completedIteration, skipped: false };

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
    }, { maxIterations: 2, dryRun: true });

    vi.spyOn(loop, "runOneIteration")
      .mockResolvedValueOnce(iterationWithTask as any)
      .mockResolvedValueOnce(completingIteration as any);

    await loop.run("goal-1");

    // In dryRun mode, writeRaw (used by saveLoopCheckpoint) should NOT be called
    expect(mocks.stateManager.writeRaw).not.toHaveBeenCalled();
  });


  it("strategyTemplateRegistry is wired into strategyManager when provided", async () => {
    const { CoreLoop } = await import("../src/core-loop.js");
    const setStrategyTemplateRegistry = vi.fn();
    const strategyManagerWithSetter = {
      ...mocks.strategyManager,
      setStrategyTemplateRegistry,
    };
    const fakeRegistry = { getTemplate: vi.fn() };

    new CoreLoop({
      stateManager: mocks.stateManager as any,
      observationEngine: {} as any,
      gapCalculator: {} as any,
      driveScorer: {} as any,
      taskLifecycle: {} as any,
      satisficingJudge: {} as any,
      stallDetector: mocks.stallDetector as any,
      strategyManager: strategyManagerWithSetter as any,
      reportingEngine: mocks.reportingEngine as any,
      driveSystem: {} as any,
      adapterRegistry: { listAdapters: () => ["mock"] } as any,
      learningPipeline: {} as any,
      strategyTemplateRegistry: fakeRegistry as any,
    });

    expect(setStrategyTemplateRegistry).toHaveBeenCalledWith(fakeRegistry);
  });


  it("runMultiGoalIteration delegates to runMultiGoalIterationImpl", async () => {
    const { CoreLoop } = await import("../src/core-loop.js");
    const { runMultiGoalIteration: mockMulti } = await import("../src/loop/tree-loop-runner.js") as any;
    mockMulti.mockResolvedValueOnce({ ...mocks.completedIteration, skipped: false });

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
    }, { maxIterations: 1, multiGoalMode: true, goalIds: ["goal-1", "goal-2"] });

    const result = await loop.runMultiGoalIteration(0);
    expect(mockMulti).toHaveBeenCalled();
    expect(result.completionJudgment.is_complete).toBe(true);
  });

  // ─── runOneIteration() internal branches ───

  it("runOneIteration returns early when loadGoalWithAggregation returns null", async () => {
    const { CoreLoop } = await import("../src/core-loop.js");
    const { loadGoalWithAggregation } = await import("../src/loop/core-loop-phases.js") as any;
    loadGoalWithAggregation.mockResolvedValueOnce(null);

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
    });

    const result = await loop.runOneIteration("goal-1", 0);
    // Early return: taskResult is null, error is null (just empty result)
    expect(result.taskResult).toBeNull();
  });

  it("runOneIteration returns early when calculateGapOrComplete returns null (hard error)", async () => {
    const { CoreLoop } = await import("../src/core-loop.js");
    const { calculateGapOrComplete } = await import("../src/loop/core-loop-phases.js") as any;
    calculateGapOrComplete.mockImplementationOnce(async (_ctx: unknown, _goalId: string, _goal: any, _loopIndex: number, result: any, _startTime: number) => {
      result.error = "gap calculation failed";
      return null; // null signals hard error
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
    });

    const result = await loop.runOneIteration("goal-1", 0);
    expect(result.error).toBe("gap calculation failed");
  });

  it("runOneIteration returns early when checkDependencyBlock returns true", async () => {
    const { CoreLoop } = await import("../src/core-loop.js");
    const { checkDependencyBlock } = await import("../src/loop/core-loop-phases-b.js") as any;
    const { calculateGapOrComplete } = await import("../src/loop/core-loop-phases.js") as any;

    calculateGapOrComplete.mockImplementationOnce(async (_ctx: unknown, _goalId: string, _goal: any, _loopIndex: number, result: any) => {
      result.gapAggregate = 0.5;
      return { gapVector: { goal_id: "goal-1", gaps: [], timestamp: "" }, gapAggregate: 0.5, skipTaskGeneration: false };
    });
    checkDependencyBlock.mockReturnValueOnce(true);

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
    });

    const result = await loop.runOneIteration("goal-1", 0);
    // dependency block exits before task cycle
    expect(result.taskResult).toBeNull();
  });

  it("runOneIteration falls through to normal task cycle when tryRunParallel returns null", async () => {
    const { CoreLoop } = await import("../src/core-loop.js");
    const { calculateGapOrComplete } = await import("../src/loop/core-loop-phases.js") as any;
    const { runTaskCycleWithContext } = await import("../src/loop/core-loop-phases-b.js") as any;

    calculateGapOrComplete.mockImplementationOnce(async (_ctx: unknown, _goalId: string, _goal: any, _loopIndex: number, result: any) => {
      result.gapAggregate = 0.5;
      return { gapVector: { goal_id: "goal-1", gaps: [], timestamp: "" }, gapAggregate: 0.5, skipTaskGeneration: false };
    });
    // generateTaskGroupFn returns null → tryRunParallel falls through
    const generateTaskGroupFnNull = vi.fn().mockResolvedValue(null);
    runTaskCycleWithContext.mockResolvedValueOnce(true);

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
      generateTaskGroupFn: generateTaskGroupFnNull as any,
      learningPipeline: {} as any,
    });

    const result = await loop.runOneIteration("goal-1", 0);
    // Normal task cycle was called
    expect(runTaskCycleWithContext).toHaveBeenCalled();
    expect(result.error).toBeNull();
  });


  it("runOneIteration with stateDiff: skips when no state change detected", async () => {
    const { CoreLoop } = await import("../src/core-loop.js");

    const mockStateDiff = {
      buildSnapshot: vi.fn().mockReturnValue({ dimensions: {}, iteration: 0 }),
      compare: vi.fn().mockReturnValue({ hasChange: false, changedDimensions: [], reason: "no change" }),
    };

    // Second loadGoal call (for goalState) should return a non-completed goal
    mocks.stateManager.loadGoal
      .mockResolvedValueOnce(mocks.goal) // initial load in run()
      .mockResolvedValueOnce(mocks.goal) // loadGoalWithAggregation (mocked separately)
      .mockResolvedValueOnce(mocks.goal); // loadGoal for completed status check in skip path

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
      onProgress: vi.fn(),
    }, { maxIterations: 1, maxConsecutiveSkips: 5 }, mockStateDiff as any);

    const result = await loop.runOneIteration("goal-1", 0);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("no_state_change");
  });

  it("runOneIteration with stateDiff: forces full iteration when maxConsecutiveSkips reached", async () => {
    const { CoreLoop } = await import("../src/core-loop.js");
    const { calculateGapOrComplete } = await import("../src/loop/core-loop-phases.js") as any;

    calculateGapOrComplete.mockImplementation(async (_ctx: unknown, _goalId: string, _goal: any, _loopIndex: number, result: any) => {
      result.gapAggregate = 0.5;
      return { gapVector: { goal_id: "goal-1", gaps: [], timestamp: "" }, gapAggregate: 0.5, skipTaskGeneration: true };
    });

    const mockStateDiff = {
      buildSnapshot: vi.fn().mockReturnValue({ dimensions: {}, iteration: 0 }),
      compare: vi.fn().mockReturnValue({ hasChange: false, changedDimensions: [], reason: "no change" }),
    };

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
    }, { maxIterations: 3, maxConsecutiveSkips: 0 }, mockStateDiff as any);

    // maxConsecutiveSkips=0 means even the first skip triggers forced full iteration
    const result = await loop.runOneIteration("goal-1", 0);
    // Full iteration ran (not skipped), since consecutiveSkips(0) >= maxConsecutiveSkips(0)
    expect(result.skipped).toBeFalsy();
  });

});
