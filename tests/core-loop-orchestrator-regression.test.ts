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
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";

function makeGapVector(goalId = "goal-1"): GapVector {
  return {
    goal_id: goalId,
    gaps: [
      { dimension_name: "dim1", raw_gap: 5, normalized_gap: 0.5, normalized_weighted_gap: 0.5, confidence: 0.8, uncertainty_weight: 1.0 },
      { dimension_name: "dim2", raw_gap: 3, normalized_gap: 0.3, normalized_weighted_gap: 0.3, confidence: 0.9, uncertainty_weight: 1.0 },
    ],
    timestamp: new Date().toISOString(),
  };
}

function makeDriveScores(): DriveScore[] {
  return [
    { dimension_name: "dim1", dissatisfaction: 0.5, deadline: 0, opportunity: 0, final_score: 0.5, dominant_drive: "dissatisfaction" },
    { dimension_name: "dim2", dissatisfaction: 0.8, deadline: 0.4, opportunity: 0, final_score: 0.9, dominant_drive: "deadline" },
  ];
}

function makeCompletionJudgment(overrides: Partial<CompletionJudgment> = {}): CompletionJudgment {
  return {
    is_complete: false,
    blocking_dimensions: ["dim1"],
    low_confidence_dimensions: [],
    needs_verification_task: false,
    checked_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeTaskCycleResult(overrides: Partial<TaskCycleResult> = {}): TaskCycleResult {
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
      success_criteria: [{ description: "Test criterion", verification_method: "manual check", is_blocking: true }],
      scope_boundary: { in_scope: ["test"], out_of_scope: [], blast_radius: "none" },
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
      evidence: [{ layer: "mechanical", description: "Pass", confidence: 0.9 }],
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
    aggregateGaps: vi.fn().mockReturnValue(0.5),
  };
  const driveScorer = {
    scoreAllDimensions: vi.fn().mockReturnValue(makeDriveScores()),
    rankDimensions: vi.fn().mockImplementation((scores: DriveScore[]) => [...scores].sort((a, b) => b.final_score - a.final_score)),
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
    judgeTreeCompletion: vi.fn(),
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
    mocks: { stateManager, observationEngine, gapCalculator, driveScorer, taskLifecycle, satisficingJudge, stallDetector, strategyManager, reportingEngine, driveSystem, adapterRegistry, adapter },
  };
}

function expectOneIteration(
  result: { finalStatus: string; totalIterations: number; iterations: Array<{ taskResult: TaskCycleResult | null; error: string | null }> },
  finalStatus: string
): void {
  expect(result.finalStatus).toBe(finalStatus);
  expect(result.totalIterations).toBe(1);
  expect(result.iterations).toHaveLength(1);
}

function expectTerminationReason(
  result: { finalStatus: string; totalIterations: number },
  finalStatus: "completed" | "stalled" | "max_iterations" | "error" | "stopped",
  totalIterations: number
): void {
  expect(result.finalStatus).toBe(finalStatus);
  expect(result.totalIterations).toBe(totalIterations);
}

describe("CoreLoop orchestrator regression", async () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles score override ordering in live execution and records the emitted task cycle", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    await mocks.stateManager.saveGoal(makeGoal());
    mocks.taskLifecycle.runTaskCycle.mockResolvedValue(makeTaskCycleResult({ action: "completed" }));

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0, maxIterations: 1, maxConsecutiveErrors: 1 });
    const result = await loop.run("goal-1");

    expectTerminationReason(result, "max_iterations", 1);
    expect(result.iterations[0]!.driveScores[0]!.dimension_name).toBe("dim2");
    expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    expect(mocks.taskLifecycle.runTaskCycle.mock.calls[0]?.[0]).toBe("goal-1");
    expect(mocks.reportingEngine.saveReport).toHaveBeenCalled();
  });

  it("delegates task execution to TaskLifecycle and records completion feedback", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    await mocks.stateManager.saveGoal(makeGoal());
    mocks.taskLifecycle.runTaskCycle.mockResolvedValue(
      makeTaskCycleResult({ action: "completed", task: { ...makeTaskCycleResult().task, strategy_id: "strategy-1" } })
    );
    const portfolioManager = {
      selectNextStrategyForTask: vi.fn().mockReturnValue({ strategy_id: "strategy-1", allocation: 1 }),
      recordTaskCompletion: vi.fn(),
      shouldRebalance: vi.fn().mockReturnValue(null),
      rebalance: vi.fn(),
      isWaitStrategy: vi.fn().mockReturnValue(false),
      handleWaitStrategyExpiry: vi.fn(),
      getRebalanceHistory: vi.fn().mockReturnValue([]),
    };

    const loop = new CoreLoop({ ...deps, portfolioManager: portfolioManager as any }, { delayBetweenLoopsMs: 0, maxIterations: 1 });
    const result = await loop.run("goal-1");

    expectTerminationReason(result, "max_iterations", 1);
    expect(portfolioManager.recordTaskCompletion).toHaveBeenCalledWith("strategy-1");
    expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    expect(result.iterations[0]!.taskResult?.action).toBe("completed");
    expect(mocks.reportingEngine.saveReport).toHaveBeenCalled();
  });

  it("verifies task output and stops with completed when the satisficing judge returns a complete result", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    await mocks.stateManager.saveGoal(makeGoal());
    mocks.satisficingJudge.isGoalComplete.mockReturnValue(makeCompletionJudgment({ is_complete: true }));
    mocks.taskLifecycle.runTaskCycle.mockResolvedValue(makeTaskCycleResult({
      action: "completed",
      verificationResult: {
        task_id: "task-1",
        verdict: "pass",
        confidence: 0.95,
        evidence: [{ layer: "mechanical", description: "Verified", confidence: 0.95 }],
        dimension_updates: [],
        timestamp: new Date().toISOString(),
      },
    }));

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0, maxIterations: 3 });
    const result = await loop.run("goal-1");

    expectTerminationReason(result, "completed", 1);
    expect(result.iterations[0]!.completionJudgment.is_complete).toBe(true);
    expect(result.iterations[0]!.taskResult?.action).toBe("completed");
    expect(result.iterations[0]!.taskResult?.verificationResult.verdict).toBe("pass");
    const savedGoal = await mocks.stateManager.loadGoal("goal-1");
    expect(savedGoal?.status).toBe("completed");
  });

  it("honors minIterations before returning a completed termination reason", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    await mocks.stateManager.saveGoal(makeGoal());
    mocks.satisficingJudge.isGoalComplete.mockReturnValue(makeCompletionJudgment({ is_complete: true }));

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0, maxIterations: 4, minIterations: 2 });
    const result = await loop.run("goal-1");

    expectTerminationReason(result, "completed", 2);
    expect(result.iterations.every((iteration) => iteration.taskResult?.action === "completed")).toBe(true);
    expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledTimes(2);
  });

  it("fails fast when the goal cannot be loaded", async () => {
    const { deps } = createMockDeps(tmpDir);
    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0, maxIterations: 1, maxConsecutiveErrors: 1 });
    const result = await loop.run("missing-goal");

    expectTerminationReason(result, "error", 0);
    expect(result.iterations).toHaveLength(0);
  });

  it("returns an error iteration when gap calculation throws", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    await mocks.stateManager.saveGoal(makeGoal());
    mocks.gapCalculator.calculateGapVector.mockImplementation(() => {
      throw new Error("gap boom");
    });

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0, maxIterations: 1, maxConsecutiveErrors: 1 });
    const result = await loop.run("goal-1");

    expectTerminationReason(result, "error", 1);
    expect(result.iterations[0]!.error).toContain("Gap calculation failed");
    expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
  });

  it("returns an error when completion checking fails before task execution", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    await mocks.stateManager.saveGoal(makeGoal());
    mocks.satisficingJudge.isGoalComplete.mockImplementation(() => {
      throw new Error("judge boom");
    });

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0, maxIterations: 1, maxConsecutiveErrors: 1 });
    const result = await loop.run("goal-1");

    expectTerminationReason(result, "error", 1);
    expect(result.iterations[0]!.error).toContain("Completion check failed");
    expect(result.iterations[0]!.taskResult).toBeNull();
    expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
  });

  it("returns an error when the task cycle itself throws", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    await mocks.stateManager.saveGoal(makeGoal());
    mocks.taskLifecycle.runTaskCycle.mockRejectedValue(new Error("task boom"));
    mocks.stateManager.writeRaw = vi.fn().mockResolvedValue(undefined);

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0, maxIterations: 1, maxConsecutiveErrors: 1 });
    const result = await loop.run("goal-1");

    expectTerminationReason(result, "error", 1);
    expect(result.iterations[0]!.error).toContain("Task cycle failed");
    expect(result.iterations[0]!.taskResult).toBeNull();
    expect(mocks.stateManager.writeRaw).not.toHaveBeenCalled();
    expect(fs.existsSync(`${tmpDir}/goals/goal-1/checkpoint.json`)).toBe(false);
  });

  it("stops after three consecutive approval_denied task results", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    await mocks.stateManager.saveGoal(makeGoal());
    mocks.taskLifecycle.runTaskCycle.mockResolvedValue(makeTaskCycleResult({ action: "approval_denied" }));

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0, maxIterations: 10 });
    const result = await loop.run("goal-1");

    expectTerminationReason(result, "stopped", 3);
    expect(result.iterations.every((iteration) => iteration.taskResult?.action === "approval_denied")).toBe(true);
  });

  it("stalls after three consecutive escalate task results", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    await mocks.stateManager.saveGoal(makeGoal());
    mocks.taskLifecycle.runTaskCycle.mockResolvedValue(makeTaskCycleResult({ action: "escalate" }));

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0, maxIterations: 10 });
    const result = await loop.run("goal-1");

    expectTerminationReason(result, "stalled", 3);
    expect(result.iterations.every((iteration) => iteration.taskResult?.action === "escalate")).toBe(true);
  });

  it("dryRun suppresses checkpoint persistence while still returning a valid iteration result", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    await mocks.stateManager.saveGoal(makeGoal());
    mocks.taskLifecycle.runTaskCycle.mockResolvedValue(makeTaskCycleResult({ action: "completed" }));
    mocks.stateManager.writeRaw = vi.fn().mockResolvedValue(undefined);

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0, maxIterations: 1, dryRun: true });
    const result = await loop.run("goal-1");

    expectTerminationReason(result, "max_iterations", 1);
    expect(mocks.stateManager.writeRaw).not.toHaveBeenCalled();
    expect(fs.existsSync(`${tmpDir}/goals/goal-1/checkpoint.json`)).toBe(false);
    expect(result.iterations[0]!.taskResult?.action).toBe("completed");
  });

  it("dryRun suppresses final completion writes and archive side effects", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    await mocks.stateManager.saveGoal(makeGoal());
    mocks.satisficingJudge.isGoalComplete.mockReturnValue(makeCompletionJudgment({ is_complete: true }));
    mocks.stateManager.saveGoal = vi.fn().mockResolvedValue(undefined);
    mocks.stateManager.archiveGoal = vi.fn().mockResolvedValue(undefined);

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0, maxIterations: 1, autoArchive: true, dryRun: true });
    const result = await loop.run("goal-1");

    expectTerminationReason(result, "completed", 1);
    expect(mocks.stateManager.saveGoal).not.toHaveBeenCalled();
    expect(mocks.stateManager.archiveGoal).not.toHaveBeenCalled();
    const savedGoal = await mocks.stateManager.loadGoal("goal-1");
    expect(savedGoal?.status).toBe("active");
  });
});
