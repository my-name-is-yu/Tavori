/**
 * core-loop-stall-refine.test.ts
 *
 * Tests for stall-handler integration with GoalRefiner (Step 5 of
 * docs/design/goal-refinement-pipeline.md §4.5).
 *
 * Verifies:
 *   - Observation-failure stall (suggested_cause === "information_deficit")
 *     triggers reRefineLeaf() when goalRefiner is available.
 *   - Progress stall (other suggested_cause) does NOT trigger reRefineLeaf().
 *   - reRefineLeaf() failures are non-fatal (loop continues).
 *   - goalRefiner absent → no reRefineLeaf() call (backward compat).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type CoreLoopDeps,
  type GapCalculatorModule,
  type DriveScorerModule,
  type ReportingEngine,
} from "../core-loop.js";
import { detectStallsAndRebalance } from "../core-loop/task-cycle.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { ObservationEngine } from "../../../platform/observation/observation-engine.js";
import type { TaskLifecycle } from "../../execution/task/task-lifecycle.js";
import type { SatisficingJudge } from "../../../platform/drive/satisficing-judge.js";
import type { StallDetector } from "../../../platform/drive/stall-detector.js";
import type { StrategyManager } from "../../strategy/strategy-manager.js";
import type { DriveSystem } from "../../../platform/drive/drive-system.js";
import type { AdapterRegistry } from "../../execution/adapter-layer.js";
import type { GoalRefiner } from "../../goal/goal-refiner.js";
import type { Goal } from "../../../base/types/goal.js";
import type { StallReport } from "../../../base/types/stall.js";
import type { LoopIterationResult } from "../core-loop/contracts.js";
import type { PhaseCtx } from "../core-loop/preparation.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";

// ─── Helpers ───

function makeStallReport(
  overrides: Partial<StallReport> = {}
): StallReport {
  return {
    stall_type: "dimension_stall",
    goal_id: "goal-1",
    dimension_name: "dim1",
    task_id: null,
    detected_at: new Date().toISOString(),
    escalation_level: 1,
    suggested_cause: "approach_failure", // default = progress stall
    decay_factor: 0.8,
    ...overrides,
  };
}

function makeIterationResult(): LoopIterationResult {
  return {
    loopIndex: 0,
    goalId: "goal-1",
    gapAggregate: 0.5,
    driveScores: [],
    taskResult: null,
    stallDetected: false,
    stallReport: null,
    pivotOccurred: false,
    completionJudgment: {
      is_complete: false,
      blocking_dimensions: ["dim1"],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    },
    elapsedMs: 0,
    error: null,
  };
}

function makeGapHistoryWithStall(dimensionName: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    iteration: i,
    timestamp: new Date().toISOString(),
    gap_vector: [
      {
        dimension_name: dimensionName,
        normalized_weighted_gap: 0.8,
      },
    ],
    confidence_vector: [
      {
        dimension_name: dimensionName,
        confidence: 0.5,
      },
    ],
  }));
}

function buildPhaseCtx(
  deps: CoreLoopDeps,
  config: { maxIterations: number; adapterType: string }
): PhaseCtx {
  return {
    deps,
    config: {
      maxIterations: config.maxIterations,
      maxConsecutiveErrors: 3,
      delayBetweenLoopsMs: 0,
      adapterType: config.adapterType,
      treeMode: false,
      multiGoalMode: false,
      goalIds: [],
      minIterations: 1,
      autoArchive: false,
      dryRun: false,
      maxConsecutiveSkips: 5,
      autoDecompose: true,
      autoConsolidateOnComplete: true,
      consolidationRawThreshold: 20,
    },
    logger: undefined,
  };
}

function createBaseDeps(tmpDir: string): CoreLoopDeps {
  const stateManager = new StateManager(tmpDir);

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
    calculateGapVector: vi.fn(),
    aggregateGaps: vi.fn().mockReturnValue(0.5),
  };

  const driveScorer = {
    scoreAllDimensions: vi.fn().mockReturnValue([]),
    rankDimensions: vi.fn().mockReturnValue([]),
  };

  const taskLifecycle = {
    runTaskCycle: vi.fn(),
    selectTargetDimension: vi.fn(),
    generateTask: vi.fn(),
    checkIrreversibleApproval: vi.fn(),
    executeTask: vi.fn(),
    verifyTask: vi.fn(),
    handleVerdict: vi.fn(),
    handleFailure: vi.fn(),
  };

  const satisficingJudge = {
    isGoalComplete: vi.fn().mockReturnValue({
      is_complete: false,
      blocking_dimensions: ["dim1"],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    }),
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
    getPortfolio: vi.fn().mockResolvedValue(null),
    generateCandidates: vi.fn(),
    activateBestCandidate: vi.fn(),
    updateState: vi.fn(),
    getStrategyHistory: vi.fn(),
    incrementPivotCount: vi.fn().mockResolvedValue(undefined),
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
    getAdapter: vi.fn(),
    register: vi.fn(),
    listAdapters: vi.fn().mockReturnValue(["openai_codex_cli"]),
  };

  return {
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
}

// ─── Setup ───

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
});

// ─── Tests ───

describe("detectStallsAndRebalance — reRefineLeaf on observation-failure stall", () => {
  it("uses the goal workspace_path for tool-based stall evidence", async () => {
    const deps = createBaseDeps(tmpDir);
    const workspacePath = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    const goal = makeGoal({
      id: "goal-1",
      constraints: [`workspace_path:${workspacePath}`],
    });
    await deps.stateManager.saveGoal(goal);
    await deps.stateManager.saveGapHistory("goal-1", []);

    const execute = vi.fn().mockResolvedValue({
      success: true,
      data: "",
      summary: "no changes",
      durationMs: 0,
    });
    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    ctx.toolExecutor = { execute } as never;
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(execute).toHaveBeenCalledWith(
      "git-diff",
      { target: "unstaged", path: workspacePath },
      expect.objectContaining({ cwd: workspacePath, goalId: "goal-1" }),
    );
  });

  it("calls reRefineLeaf() when stall suggested_cause is information_deficit and goalRefiner is present", async () => {
    const deps = createBaseDeps(tmpDir);

    const mockRefiner = {
      refine: vi.fn(),
      reRefineLeaf: vi.fn().mockResolvedValue({ leaf: true }),
    } as unknown as GoalRefiner;

    deps.goalRefiner = mockRefiner;

    // Set up goal with a stalling dimension
    const goal = makeGoal({
      id: "goal-1",
      dimensions: [
        {
          name: "dim1",
          label: "Dim 1",
          current_value: 0.2,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.5,
          observation_method: {
            type: "manual",
            source: "manual",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await deps.stateManager.saveGoal(goal);

    // Seed enough gap history to trigger stall
    const gapHistory = makeGapHistoryWithStall("dim1", 5);
    await deps.stateManager.saveGapHistory("goal-1", gapHistory);

    // Make stallDetector fire an information_deficit stall
    const stallReport = makeStallReport({
      suggested_cause: "information_deficit",
      goal_id: "goal-1",
      dimension_name: "dim1",
    });
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(stallReport);

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(result.stallDetected).toBe(true);
    expect(mockRefiner.reRefineLeaf).toHaveBeenCalledOnce();
    expect(mockRefiner.reRefineLeaf).toHaveBeenCalledWith("goal-1", "information_deficit");
  });

  it("does NOT call reRefineLeaf() for a progress stall (approach_failure)", async () => {
    const deps = createBaseDeps(tmpDir);

    const mockRefiner = {
      refine: vi.fn(),
      reRefineLeaf: vi.fn(),
    } as unknown as GoalRefiner;

    deps.goalRefiner = mockRefiner;

    const goal = makeGoal({ id: "goal-1" });
    await deps.stateManager.saveGoal(goal);

    const gapHistory = makeGapHistoryWithStall("dim1", 5);
    await deps.stateManager.saveGapHistory("goal-1", gapHistory);

    const stallReport = makeStallReport({
      suggested_cause: "approach_failure", // progress stall
      goal_id: "goal-1",
      dimension_name: "dim1",
    });
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(stallReport);

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(result.stallDetected).toBe(true);
    expect(mockRefiner.reRefineLeaf).not.toHaveBeenCalled();
  });

  it("does NOT call reRefineLeaf() when goalRefiner is absent (backward compat)", async () => {
    const deps = createBaseDeps(tmpDir);
    // No goalRefiner set

    const goal = makeGoal({ id: "goal-1" });
    await deps.stateManager.saveGoal(goal);

    const gapHistory = makeGapHistoryWithStall("dim1", 5);
    await deps.stateManager.saveGapHistory("goal-1", gapHistory);

    const stallReport = makeStallReport({
      suggested_cause: "information_deficit",
      goal_id: "goal-1",
      dimension_name: "dim1",
    });
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(stallReport);

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    // Should not throw
    await expect(detectStallsAndRebalance(ctx, "goal-1", goal, result)).resolves.toBeUndefined();
    expect(result.stallDetected).toBe(true);
  });

  it("reRefineLeaf() failure is non-fatal — loop continues", async () => {
    const deps = createBaseDeps(tmpDir);

    const mockRefiner = {
      refine: vi.fn(),
      reRefineLeaf: vi.fn().mockRejectedValue(new Error("reRefineLeaf failed")),
    } as unknown as GoalRefiner;

    deps.goalRefiner = mockRefiner;

    const goal = makeGoal({ id: "goal-1" });
    await deps.stateManager.saveGoal(goal);

    const gapHistory = makeGapHistoryWithStall("dim1", 5);
    await deps.stateManager.saveGapHistory("goal-1", gapHistory);

    const stallReport = makeStallReport({
      suggested_cause: "information_deficit",
      goal_id: "goal-1",
      dimension_name: "dim1",
    });
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(stallReport);

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    // Should not throw even when reRefineLeaf errors
    await expect(detectStallsAndRebalance(ctx, "goal-1", goal, result)).resolves.toBeUndefined();
    expect(result.stallDetected).toBe(true);
    expect(mockRefiner.reRefineLeaf).toHaveBeenCalledOnce();
  });
});

describe("detectStallsAndRebalance — global stall reRefineLeaf", () => {
  it("calls reRefineLeaf() for global information_deficit stall when goalRefiner is present", async () => {
    const deps = createBaseDeps(tmpDir);

    const mockRefiner = {
      refine: vi.fn(),
      reRefineLeaf: vi.fn().mockResolvedValue({ leaf: true }),
    } as unknown as GoalRefiner;

    deps.goalRefiner = mockRefiner;

    const goal = makeGoal({
      id: "goal-1",
      dimensions: [
        {
          name: "dim1",
          label: "Dim 1",
          current_value: 0.2,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.5,
          observation_method: {
            type: "manual",
            source: "manual",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await deps.stateManager.saveGoal(goal);

    const gapHistory = makeGapHistoryWithStall("dim1", 5);
    await deps.stateManager.saveGapHistory("goal-1", gapHistory);

    // Per-dimension stall returns null so global stall is checked
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const globalStallReport = makeStallReport({
      stall_type: "global_stall",
      suggested_cause: "information_deficit",
      goal_id: "goal-1",
      dimension_name: null,
    });
    (deps.stallDetector.checkGlobalStall as ReturnType<typeof vi.fn>).mockReturnValue(globalStallReport);

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(result.stallDetected).toBe(true);
    expect(mockRefiner.reRefineLeaf).toHaveBeenCalledOnce();
    expect(mockRefiner.reRefineLeaf).toHaveBeenCalledWith("goal-1", "information_deficit");
  });

  it("does NOT call reRefineLeaf() for global progress stall (capability_limit)", async () => {
    const deps = createBaseDeps(tmpDir);

    const mockRefiner = {
      refine: vi.fn(),
      reRefineLeaf: vi.fn(),
    } as unknown as GoalRefiner;

    deps.goalRefiner = mockRefiner;

    const goal = makeGoal({ id: "goal-1" });
    await deps.stateManager.saveGoal(goal);

    const gapHistory = makeGapHistoryWithStall("dim1", 5);
    await deps.stateManager.saveGapHistory("goal-1", gapHistory);

    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const globalStallReport = makeStallReport({
      stall_type: "global_stall",
      suggested_cause: "capability_limit",
      goal_id: "goal-1",
      dimension_name: null,
    });
    (deps.stallDetector.checkGlobalStall as ReturnType<typeof vi.fn>).mockReturnValue(globalStallReport);

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(result.stallDetected).toBe(true);
    expect(mockRefiner.reRefineLeaf).not.toHaveBeenCalled();
  });
});

describe("detectStallsAndRebalance — gap history indexing reuse", () => {
  it("reuses the same per-dimension history for dimension and global stall checks", async () => {
    const deps = createBaseDeps(tmpDir);
    const goal = makeGoal({
      id: "goal-1",
      dimensions: [
        {
          name: "dim1",
          label: "Dim 1",
          current_value: 0.2,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.5,
          observation_method: {
            type: "manual",
            source: "manual",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
        {
          name: "dim2",
          label: "Dim 2",
          current_value: 0.4,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.5,
          observation_method: {
            type: "manual",
            source: "manual",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await deps.stateManager.saveGoal(goal);

    await deps.stateManager.saveGapHistory("goal-1", [
      {
        iteration: 0,
        timestamp: new Date().toISOString(),
        gap_vector: [
          { dimension_name: "dim1", normalized_weighted_gap: 0.8 },
          { dimension_name: "dim2", normalized_weighted_gap: 0.4 },
        ],
        confidence_vector: [],
      },
      {
        iteration: 1,
        timestamp: new Date().toISOString(),
        gap_vector: [
          { dimension_name: "dim2", normalized_weighted_gap: 0.3 },
        ],
        confidence_vector: [],
      },
      {
        iteration: 2,
        timestamp: new Date().toISOString(),
        gap_vector: [
          { dimension_name: "dim1", normalized_weighted_gap: 0.6 },
        ],
        confidence_vector: [],
      },
    ]);

    const dimensionHistories = new Map<string, Array<{ normalized_gap: number }>>();
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockImplementation(
      (_goalId: string, dimName: string, dimGapHistory: Array<{ normalized_gap: number }>) => {
        dimensionHistories.set(dimName, dimGapHistory);
        return null;
      }
    );

    const globalHistories: Array<Map<string, Array<{ normalized_gap: number }>>> = [];
    (deps.stallDetector.checkGlobalStall as ReturnType<typeof vi.fn>).mockImplementation(
      (_goalId: string, allDimGaps: Map<string, Array<{ normalized_gap: number }>>) => {
        globalHistories.push(allDimGaps);
        return null;
      }
    );

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(dimensionHistories.get("dim1")).toEqual([
      { normalized_gap: 0.8 },
      { normalized_gap: 0.6 },
    ]);
    expect(dimensionHistories.get("dim2")).toEqual([
      { normalized_gap: 0.4 },
      { normalized_gap: 0.3 },
    ]);

    const globalHistory = globalHistories[0];
    expect(globalHistory).toBeDefined();
    expect(globalHistory?.get("dim1")).toBe(dimensionHistories.get("dim1"));
    expect(globalHistory?.get("dim2")).toBe(dimensionHistories.get("dim2"));
  });

  it("ignores stale dimensions that are no longer present on the goal", async () => {
    const deps = createBaseDeps(tmpDir);
    const goal = makeGoal({
      id: "goal-1",
      dimensions: [
        {
          name: "dim1",
          label: "Dim 1",
          current_value: 0.2,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.5,
          observation_method: {
            type: "manual",
            source: "manual",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await deps.stateManager.saveGoal(goal);

    await deps.stateManager.saveGapHistory("goal-1", [
      {
        iteration: 0,
        timestamp: new Date().toISOString(),
        gap_vector: [
          { dimension_name: "dim1", normalized_weighted_gap: 0.8 },
          { dimension_name: "stale-dim", normalized_weighted_gap: 0.1 },
        ],
        confidence_vector: [],
      },
    ]);

    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const globalCheck = deps.stallDetector.checkGlobalStall as ReturnType<typeof vi.fn>;
    globalCheck.mockReturnValue(null);

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    const globalHistory = globalCheck.mock.calls[0]?.[1] as Map<string, Array<{ normalized_gap: number }>>;
    expect(globalHistory.has("dim1")).toBe(true);
    expect(globalHistory.has("stale-dim")).toBe(false);
  });
});
