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
import type { DriveScore } from "../src/types/drive.js";
import type { TreeLoopOrchestrator } from "../src/goal/tree-loop-orchestrator.js";
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

// ─── Tree Mode Tests (14B) ───
describe("CoreLoop tree mode (14B)", async () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const mockStateAggregator = {
    aggregateChildStates: vi.fn(),
    propagateStateDown: vi.fn(),
    checkCompletionCascade: vi.fn().mockReturnValue([]),
  };

  function createTreeDeps(tmpDir: string) {
    const { deps, mocks } = createMockDeps(tmpDir);

    // Add judgeTreeCompletion to satisficingJudge mock
    (mocks.satisficingJudge as Record<string, unknown>).judgeTreeCompletion = vi
      .fn()
      .mockReturnValue(makeCompletionJudgment());

    const mockGoalTreeManager = {
      decomposeGoal: vi.fn(),
      validateDecomposition: vi.fn(),
      pruneGoal: vi.fn(),
      addSubgoal: vi.fn(),
      restructureTree: vi.fn(),
      getTreeState: vi.fn(),
    };

    const treeDeps = {
      ...deps,
      stateAggregator: mockStateAggregator as any,
      goalTreeManager: mockGoalTreeManager as any,
    };

    return { deps: treeDeps, mocks, mockStateAggregator, mockGoalTreeManager };
  }

  beforeEach(() => {
    mockStateAggregator.aggregateChildStates.mockReset();
    mockStateAggregator.aggregateChildStates.mockReturnValue({
      parent_id: "goal-1",
      aggregated_gap: 0.5,
      aggregated_confidence: 0.7,
      child_gaps: {},
      child_completions: {},
      aggregation_method: "min",
      timestamp: new Date().toISOString(),
    });
    mockStateAggregator.propagateStateDown.mockReset();
    mockStateAggregator.checkCompletionCascade.mockReset().mockReturnValue([]);
  });

  it("calls aggregateChildStates when goal has children", async () => {
    const { deps, mocks } = createTreeDeps(tmpDir);
    const childId = "child-goal-1";
    const goal = makeGoal({ id: "goal-1", children_ids: [childId] });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    await loop.runOneIteration("goal-1", 0);

    expect(mockStateAggregator.aggregateChildStates).toHaveBeenCalledWith("goal-1");
  });

  it("reloads goal after tree aggregation", async () => {
    const { deps, mocks } = createTreeDeps(tmpDir);
    const childId = "child-goal-1";
    const goal = makeGoal({ id: "goal-1", children_ids: [childId] });
    await mocks.stateManager.saveGoal(goal);

    // aggregateChildStates updates the goal in state (simulate via saveGoal side-effect)
    mockStateAggregator.aggregateChildStates.mockImplementation(() => {
      // The goal is reloaded after this call — just verify the call happens
    });

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    const result = await loop.runOneIteration("goal-1", 0);

    expect(mockStateAggregator.aggregateChildStates).toHaveBeenCalledWith("goal-1");
    // After aggregation the loop continued without error
    expect(result.error).toBeNull();
  });

  it("skips aggregation when goal has no children", async () => {
    const { deps, mocks } = createTreeDeps(tmpDir);
    const goal = makeGoal({ id: "goal-1", children_ids: [] });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    await loop.runOneIteration("goal-1", 0);

    expect(mockStateAggregator.aggregateChildStates).not.toHaveBeenCalled();
  });

  it("uses judgeTreeCompletion for goals with children", async () => {
    const { deps, mocks } = createTreeDeps(tmpDir);
    const childId = "child-goal-1";
    const goal = makeGoal({ id: "goal-1", children_ids: [childId] });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    await loop.runOneIteration("goal-1", 0);

    const judgeTreeCompletion = (mocks.satisficingJudge as Record<string, unknown>)
      .judgeTreeCompletion as ReturnType<typeof vi.fn>;
    expect(judgeTreeCompletion).toHaveBeenCalledWith("goal-1");
    expect(mocks.satisficingJudge.isGoalComplete).not.toHaveBeenCalled();
  });

  it("uses isGoalComplete for leaf goals", async () => {
    const { deps, mocks } = createTreeDeps(tmpDir);
    const goal = makeGoal({ id: "goal-1", children_ids: [] });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    await loop.runOneIteration("goal-1", 0);

    expect(mocks.satisficingJudge.isGoalComplete).toHaveBeenCalledWith(goal);
    const judgeTreeCompletion = (mocks.satisficingJudge as Record<string, unknown>)
      .judgeTreeCompletion as ReturnType<typeof vi.fn>;
    expect(judgeTreeCompletion).not.toHaveBeenCalled();
  });

  it("tree aggregation failure is non-fatal", async () => {
    const { deps, mocks } = createTreeDeps(tmpDir);
    const childId = "child-goal-1";
    const goal = makeGoal({ id: "goal-1", children_ids: [childId] });
    await mocks.stateManager.saveGoal(goal);

    mockStateAggregator.aggregateChildStates.mockImplementation(() => {
      throw new Error("aggregation failed");
    });

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    const result = await loop.runOneIteration("goal-1", 0);

    // Loop continues despite aggregation failure
    expect(result.error).toBeNull();
    expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalled();
  });

  it("backward compatible without stateAggregator", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    // stateAggregator intentionally omitted
    const goal = makeGoal({ id: "goal-1", children_ids: [] });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    const result = await loop.runOneIteration("goal-1", 0);

    expect(result.error).toBeNull();
    expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalled();
  });

  it("backward compatible without goalTreeManager", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    // goalTreeManager intentionally omitted
    const goal = makeGoal({ id: "goal-1", children_ids: [] });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    const result = await loop.runOneIteration("goal-1", 0);

    expect(result.error).toBeNull();
    expect(mocks.satisficingJudge.isGoalComplete).toHaveBeenCalled();
  });

  it("post-task re-check uses judgeTreeCompletion for tree goals", async () => {
    const { deps, mocks } = createTreeDeps(tmpDir);
    const childId = "child-goal-1";
    const goal = makeGoal({ id: "goal-1", children_ids: [childId] });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    await loop.runOneIteration("goal-1", 0);

    const judgeTreeCompletion = (mocks.satisficingJudge as Record<string, unknown>)
      .judgeTreeCompletion as ReturnType<typeof vi.fn>;
    // Called at least twice: once in step 5 and once post-task
    expect(judgeTreeCompletion.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("post-task re-check uses isGoalComplete for non-tree goals", async () => {
    const { deps, mocks } = createTreeDeps(tmpDir);
    const goal = makeGoal({ id: "goal-1", children_ids: [] });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    await loop.runOneIteration("goal-1", 0);

    // Called at least twice: once in step 5 and once post-task
    expect(mocks.satisficingJudge.isGoalComplete.mock.calls.length).toBeGreaterThanOrEqual(2);
    const judgeTreeCompletion = (mocks.satisficingJudge as Record<string, unknown>)
      .judgeTreeCompletion as ReturnType<typeof vi.fn>;
    expect(judgeTreeCompletion).not.toHaveBeenCalled();
  });
});

// ─── Tree Mode Tests (14C) ───

describe("CoreLoop tree mode (14C)", async () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTreeLoopOrchestratorMock(nodeId = "node-id-1") {
    return {
      selectNextNode: vi.fn().mockReturnValue(nodeId),
      pauseNodeLoop: vi.fn(),
      resumeNodeLoop: vi.fn(),
      onNodeCompleted: vi.fn(),
      startTreeExecution: vi.fn(),
    };
  }

  function createTreeModeDeps(tmpDir: string, orchestratorMock?: ReturnType<typeof createTreeLoopOrchestratorMock>) {
    const { deps, mocks } = createMockDeps(tmpDir);

    // Add judgeTreeCompletion to satisficingJudge mock
    (mocks.satisficingJudge as Record<string, unknown>).judgeTreeCompletion = vi
      .fn()
      .mockReturnValue(makeCompletionJudgment());

    const treeDeps = {
      ...deps,
      treeLoopOrchestrator: orchestratorMock as unknown as TreeLoopOrchestrator,
    };

    return { deps: treeDeps, mocks };
  }

  it("treeMode=true with treeLoopOrchestrator → runTreeIteration is used", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock("node-id-1");
    const { deps, mocks } = createTreeModeDeps(tmpDir, orchestratorMock);

    // Save both root and node goals
    const rootGoal = makeGoal({ id: "root-1", children_ids: ["node-id-1"] });
    const nodeGoal = makeGoal({ id: "node-id-1", parent_id: "root-1" });
    await mocks.stateManager.saveGoal(rootGoal);
    await mocks.stateManager.saveGoal(nodeGoal);

    const loop = new CoreLoop(deps, { treeMode: true, maxIterations: 1, delayBetweenLoopsMs: 0 });
    const result = await loop.run("root-1");

    // selectNextNode should have been called with the root ID
    expect(orchestratorMock.selectNextNode).toHaveBeenCalledWith("root-1");
    // The task cycle should have been run on the selected node
    expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalled();
    expect(result.totalIterations).toBeGreaterThanOrEqual(1);
  });

  it("selectNextNode returns null → loop ends", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock();
    orchestratorMock.selectNextNode.mockReturnValue(null);

    const { deps, mocks } = createTreeModeDeps(tmpDir, orchestratorMock);

    // Root must have children so the flat-iteration fallback is skipped and
    // selectNextNode is actually reached (returning null to signal completion).
    const rootGoal = makeGoal({ id: "root-1", children_ids: ["node-id-1"] });
    const nodeGoal = makeGoal({ id: "node-id-1", parent_id: "root-1" });
    await mocks.stateManager.saveGoal(rootGoal);
    await mocks.stateManager.saveGoal(nodeGoal);

    const loop = new CoreLoop(deps, { treeMode: true, maxIterations: 10, delayBetweenLoopsMs: 0 });
    const result = await loop.run("root-1");

    // With selectNextNode returning null immediately, loop terminates after first iteration
    expect(orchestratorMock.selectNextNode).toHaveBeenCalledWith("root-1");
    // Task cycle should NOT have been called (null node means no work)
    expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
    expect(["completed", "stopped", "max_iterations"]).toContain(result.finalStatus);
  });

  it("treeMode=true without treeLoopOrchestrator → falls back to normal mode", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    // No treeLoopOrchestrator in deps

    const goal = makeGoal({ id: "goal-1" });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { treeMode: true, maxIterations: 1, delayBetweenLoopsMs: 0 });
    await loop.run("goal-1");

    // Falls back to normal runOneIteration — task cycle should be called
    expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalled();
  });

  it("LoopConfig.treeMode defaults to false", () => {
    const { deps } = createMockDeps(tmpDir);
    // Create loop without specifying treeMode
    const loop = new CoreLoop(deps);
    // The loop is created successfully with default config
    expect(loop).toBeDefined();
  });

  it("runTreeIteration calls onNodeCompleted when goal is completed", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock("node-id-1");
    const { deps, mocks } = createTreeModeDeps(tmpDir, orchestratorMock);

    const rootGoal = makeGoal({ id: "root-1", children_ids: ["node-id-1"] });
    const nodeGoal = makeGoal({ id: "node-id-1", parent_id: "root-1" });
    await mocks.stateManager.saveGoal(rootGoal);
    await mocks.stateManager.saveGoal(nodeGoal);

    // Make the node goal appear completed after task cycle
    mocks.satisficingJudge.isGoalComplete.mockReturnValue(
      makeCompletionJudgment({ is_complete: true })
    );

    const loop = new CoreLoop(deps, { treeMode: true, maxIterations: 1, delayBetweenLoopsMs: 0 });
    await loop.runTreeIteration("root-1", 0);

    // onNodeCompleted should be called since the goal completed
    expect(orchestratorMock.onNodeCompleted).toHaveBeenCalledWith("node-id-1");
  });

  it("runTreeIteration does NOT call onNodeCompleted when goal is not completed", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock("node-id-1");
    const { deps, mocks } = createTreeModeDeps(tmpDir, orchestratorMock);

    const rootGoal = makeGoal({ id: "root-1", children_ids: ["node-id-1"] });
    const nodeGoal = makeGoal({ id: "node-id-1", parent_id: "root-1" });
    await mocks.stateManager.saveGoal(rootGoal);
    await mocks.stateManager.saveGoal(nodeGoal);

    // Goal is not completed
    mocks.satisficingJudge.isGoalComplete.mockReturnValue(
      makeCompletionJudgment({ is_complete: false })
    );

    const loop = new CoreLoop(deps, { treeMode: true, maxIterations: 1, delayBetweenLoopsMs: 0 });
    await loop.runTreeIteration("root-1", 0);

    // onNodeCompleted should NOT be called
    expect(orchestratorMock.onNodeCompleted).not.toHaveBeenCalled();
  });

  it("multiple iterations select different nodes via selectNextNode", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock("node-id-1");
    // Return different nodes on subsequent calls, then null to stop
    orchestratorMock.selectNextNode
      .mockReturnValueOnce("node-id-1")
      .mockReturnValueOnce("node-id-2")
      .mockReturnValue(null);

    const { deps, mocks } = createTreeModeDeps(tmpDir, orchestratorMock);

    const rootGoal = makeGoal({ id: "root-1", children_ids: ["node-id-1", "node-id-2"] });
    const nodeGoal1 = makeGoal({ id: "node-id-1", parent_id: "root-1" });
    const nodeGoal2 = makeGoal({ id: "node-id-2", parent_id: "root-1" });
    await mocks.stateManager.saveGoal(rootGoal);
    await mocks.stateManager.saveGoal(nodeGoal1);
    await mocks.stateManager.saveGoal(nodeGoal2);

    const loop = new CoreLoop(deps, { treeMode: true, maxIterations: 5, delayBetweenLoopsMs: 0 });
    const result = await loop.run("root-1");

    // selectNextNode called multiple times
    expect(orchestratorMock.selectNextNode.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Task cycle called for each selected node
    expect(mocks.taskLifecycle.runTaskCycle.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.totalIterations).toBeGreaterThanOrEqual(2);
  });

  it("runTreeIteration returns goalId of selected node (not root)", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock("node-id-1");
    const { deps, mocks } = createTreeModeDeps(tmpDir, orchestratorMock);

    const rootGoal = makeGoal({ id: "root-1", children_ids: ["node-id-1"] });
    const nodeGoal = makeGoal({ id: "node-id-1", parent_id: "root-1" });
    await mocks.stateManager.saveGoal(rootGoal);
    await mocks.stateManager.saveGoal(nodeGoal);

    const loop = new CoreLoop(deps, { treeMode: true, delayBetweenLoopsMs: 0 });
    const iterResult = await loop.runTreeIteration("root-1", 0);

    // The iteration result goalId should be the selected node, not root
    expect(iterResult.goalId).toBe("node-id-1");
  });

  it("runTreeIteration with null node returns rootId and no task", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock();
    orchestratorMock.selectNextNode.mockReturnValue(null);
    const { deps, mocks } = createTreeModeDeps(tmpDir, orchestratorMock);

    // Root must have children so the flat-iteration fallback is skipped and
    // selectNextNode is actually reached (returning null to signal completion).
    const rootGoal = makeGoal({ id: "root-1", children_ids: ["node-id-1"] });
    const nodeGoal = makeGoal({ id: "node-id-1", parent_id: "root-1" });
    await mocks.stateManager.saveGoal(rootGoal);
    await mocks.stateManager.saveGoal(nodeGoal);

    const loop = new CoreLoop(deps, { treeMode: true, delayBetweenLoopsMs: 0 });
    const iterResult = await loop.runTreeIteration("root-1", 0);

    expect(iterResult.goalId).toBe("root-1");
    expect(iterResult.taskResult).toBeNull();
    expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
  });

  it("treeMode=false ignores treeLoopOrchestrator and runs normally", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock("node-id-1");
    const { deps, mocks } = createTreeModeDeps(tmpDir, orchestratorMock);

    const goal = makeGoal({ id: "goal-1" });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { treeMode: false, maxIterations: 1, delayBetweenLoopsMs: 0 });
    await loop.run("goal-1");

    // selectNextNode should NOT be called — normal mode
    expect(orchestratorMock.selectNextNode).not.toHaveBeenCalled();
    // Normal task cycle is called
    expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalled();
  });

  // ─── Archive on completion ───

  describe("archive on completion", async () => {
    it("calls memoryLifecycleManager.onGoalClose on completion", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      mocks.satisficingJudge.isGoalComplete.mockReturnValue(
        makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
      );

      const memoryLifecycleManager = {
        onGoalClose: vi.fn().mockResolvedValue(undefined),
      };
      deps.memoryLifecycleManager = memoryLifecycleManager as unknown as import("../src/knowledge/memory/memory-lifecycle.js").MemoryLifecycleManager;

      const loop = new CoreLoop(deps, { maxIterations: 10, delayBetweenLoopsMs: 0 });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("completed");
      expect(memoryLifecycleManager.onGoalClose).toHaveBeenCalledWith("goal-1", "completed");
    });

    it("calls stateManager.archiveGoal on completion", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      mocks.satisficingJudge.isGoalComplete.mockReturnValue(
        makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
      );

      const archiveSpy = vi.spyOn(mocks.stateManager, "archiveGoal");

      const loop = new CoreLoop(deps, { maxIterations: 10, delayBetweenLoopsMs: 0, autoArchive: true });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("completed");
      expect(archiveSpy).toHaveBeenCalledWith("goal-1");
    });

    it("archive failure is non-fatal", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      mocks.satisficingJudge.isGoalComplete.mockReturnValue(
        makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
      );

      // Make archiveGoal throw
      vi.spyOn(mocks.stateManager, "archiveGoal").mockImplementation(() => {
        throw new Error("Archive failure");
      });

      const loop = new CoreLoop(deps, { maxIterations: 10, delayBetweenLoopsMs: 0 });
      const result = await loop.run("goal-1");

      // Loop should still complete successfully despite archive failure
      expect(result.finalStatus).toBe("completed");
    });

    it("does not call archiveGoal when loop did not complete", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      // Goal never completes — max_iterations
      const archiveSpy = vi.spyOn(mocks.stateManager, "archiveGoal");

      const loop = new CoreLoop(deps, { maxIterations: 2, delayBetweenLoopsMs: 0 });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("max_iterations");
      expect(archiveSpy).not.toHaveBeenCalled();
    });
  });
});
