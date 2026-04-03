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
import type { TreeLoopOrchestrator } from "../src/goal/tree-loop-orchestrator.js";
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
  ];
}

function makeCompletionJudgment(
  overrides: Partial<CompletionJudgment> = {}
): CompletionJudgment {
  return {
    is_complete: false,
    blocking_dimensions: ["dim1"],
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

function createTreeLoopOrchestratorMock() {
  return {
    ensureGoalRefined: vi.fn().mockResolvedValue(undefined),
    selectNextNode: vi.fn().mockReturnValue(null),
    pauseNodeLoop: vi.fn(),
    resumeNodeLoop: vi.fn(),
    onNodeCompleted: vi.fn(),
    startTreeExecution: vi.fn(),
  };
}

function createMockDeps(tmpDir: string, orchestratorMock?: ReturnType<typeof createTreeLoopOrchestratorMock>): {
  deps: CoreLoopDeps;
  mocks: {
    stateManager: StateManager;
    observationEngine: Record<string, ReturnType<typeof vi.fn>>;
    taskLifecycle: Record<string, ReturnType<typeof vi.fn>>;
    satisficingJudge: Record<string, ReturnType<typeof vi.fn>>;
    stallDetector: Record<string, ReturnType<typeof vi.fn>>;
    strategyManager: Record<string, ReturnType<typeof vi.fn>>;
    treeLoopOrchestrator?: ReturnType<typeof createTreeLoopOrchestratorMock>;
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
    getDataSources: vi.fn().mockReturnValue([]),
  };

  const gapCalculator = {
    calculateGapVector: vi.fn().mockReturnValue(makeGapVector()),
    aggregateGaps: vi.fn().mockReturnValue(0.5),
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
    ...(orchestratorMock ? { treeLoopOrchestrator: orchestratorMock as unknown as TreeLoopOrchestrator } : {}),
  };

  return {
    deps,
    mocks: {
      stateManager,
      observationEngine,
      taskLifecycle,
      satisficingJudge,
      stallDetector,
      strategyManager,
      treeLoopOrchestrator: orchestratorMock,
    },
  };
}

// ─── Auto-decompose tests ───

describe("CoreLoop auto-decompose (issue #295)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips decomposition when autoDecompose is false", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock();
    const { deps, mocks } = createMockDeps(tmpDir, orchestratorMock);

    const goal = makeGoal({ id: "goal-1", specificity_score: null, children_ids: [], node_type: "goal" });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { autoDecompose: false, maxIterations: 1, delayBetweenLoopsMs: 0 });
    await loop.runOneIteration("goal-1", 0);

    expect(orchestratorMock.ensureGoalRefined).not.toHaveBeenCalled();
  });

  it("skips decomposition when goal already has children", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock();
    const { deps, mocks } = createMockDeps(tmpDir, orchestratorMock);

    const childGoal = makeGoal({ id: "child-1" });
    await mocks.stateManager.saveGoal(childGoal);
    const goal = makeGoal({ id: "goal-1", children_ids: ["child-1"], specificity_score: null });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { maxIterations: 1, delayBetweenLoopsMs: 0 });
    await loop.runOneIteration("goal-1", 0);

    expect(orchestratorMock.ensureGoalRefined).not.toHaveBeenCalled();
  });

  it("skips decomposition when goal is leaf", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock();
    const { deps, mocks } = createMockDeps(tmpDir, orchestratorMock);

    const goal = makeGoal({ id: "goal-1", node_type: "leaf", children_ids: [], specificity_score: null });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { maxIterations: 1, delayBetweenLoopsMs: 0 });
    await loop.runOneIteration("goal-1", 0);

    expect(orchestratorMock.ensureGoalRefined).not.toHaveBeenCalled();
  });

  it("delegates specificity check to ensureGoalRefined (high specificity still calls it)", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock();
    const { deps, mocks } = createMockDeps(tmpDir, orchestratorMock);

    const goal = makeGoal({ id: "goal-1", specificity_score: 0.8, children_ids: [], node_type: "goal" });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { maxIterations: 1, delayBetweenLoopsMs: 0 });
    await loop.runOneIteration("goal-1", 0);

    // Specificity check is internal to ensureGoalRefined, so it is still called
    expect(orchestratorMock.ensureGoalRefined).toHaveBeenCalledWith("goal-1", { force: false });
  });

  it("calls ensureGoalRefined when goal is abstract", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock();
    const { deps, mocks } = createMockDeps(tmpDir, orchestratorMock);

    const goal = makeGoal({ id: "goal-1", specificity_score: null, children_ids: [], node_type: "goal" });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { maxIterations: 1, delayBetweenLoopsMs: 0 });
    await loop.runOneIteration("goal-1", 0);

    expect(orchestratorMock.ensureGoalRefined).toHaveBeenCalledWith("goal-1", { force: false });
  });

  it("only decomposes on first iteration", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock();
    const { deps, mocks } = createMockDeps(tmpDir, orchestratorMock);

    const goal = makeGoal({ id: "goal-1", specificity_score: null, children_ids: [], node_type: "goal" });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { maxIterations: 3, delayBetweenLoopsMs: 0 });
    await loop.run("goal-1");

    // ensureGoalRefined should be called exactly once across all iterations
    expect(orchestratorMock.ensureGoalRefined).toHaveBeenCalledTimes(1);
    expect(orchestratorMock.ensureGoalRefined).toHaveBeenCalledWith("goal-1", { force: true });
  });

  it("skips decomposition for non-root goals (decomposition_depth > 0)", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock();
    const { deps, mocks } = createMockDeps(tmpDir, orchestratorMock);

    // Child goal at depth 1 — should NOT be decomposed
    const childGoal = makeGoal({ id: "goal-child", children_ids: [], node_type: "goal", decomposition_depth: 1 });
    await mocks.stateManager.saveGoal(childGoal);

    const loop = new CoreLoop(deps, { maxIterations: 1, delayBetweenLoopsMs: 0 });
    await loop.runOneIteration("goal-child", 0);

    expect(orchestratorMock.ensureGoalRefined).not.toHaveBeenCalled();
  });

  it("loop continues without crashing when ensureGoalRefined throws", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock();
    orchestratorMock.ensureGoalRefined.mockRejectedValue(new Error("decomposition service unavailable"));
    const { deps, mocks } = createMockDeps(tmpDir, orchestratorMock);

    const goal = makeGoal({ id: "goal-1", specificity_score: null, children_ids: [], node_type: "goal" });
    await mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { maxIterations: 1, delayBetweenLoopsMs: 0 });
    // Should not throw — error is non-fatal
    const result = await loop.runOneIteration("goal-1", 0);

    expect(result.error).toBeNull();
    expect(orchestratorMock.ensureGoalRefined).toHaveBeenCalledWith("goal-1", { force: false });
  });
});
