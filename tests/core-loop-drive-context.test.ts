import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import {
  CoreLoop,
  buildDriveContext,
  type LoopConfig,
  type CoreLoopDeps,
  type GapCalculatorModule,
  type DriveScorerModule,
  type ReportingEngine,
  type LoopIterationResult,
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

  // ─── buildDriveContext ───

  describe("buildDriveContext", () => {
    it("builds context from goal with dimensions", () => {
      const goal = makeGoal({
        dimensions: [
          makeDimension({ name: "dim1", label: "Dimension 1" }),
          makeDimension({ name: "dim2", label: "Dimension 2", current_value: 3, threshold: { type: "min", value: 8 }, confidence: 0.7, observation_method: { type: "mechanical", source: "test", schedule: null, endpoint: null, confidence_tier: "mechanical" } }),
        ],
      });
      const ctx = buildDriveContext(goal);

      expect(ctx.time_since_last_attempt).toHaveProperty("dim1");
      expect(ctx.time_since_last_attempt).toHaveProperty("dim2");
      expect(ctx.deadlines.dim1).toBeNull();
      expect(ctx.deadlines.dim2).toBeNull();
      expect(ctx.opportunities).toEqual({});
    });

    it("computes deadline hours remaining when goal has deadline", () => {
      const futureDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      const goal = makeGoal({ deadline: futureDate });
      const ctx = buildDriveContext(goal);

      expect(ctx.deadlines.dim1).toBeGreaterThan(47);
      expect(ctx.deadlines.dim1).toBeLessThanOrEqual(48);
    });

    it("returns negative deadline hours when overdue", () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const goal = makeGoal({ deadline: pastDate });
      const ctx = buildDriveContext(goal);

      expect(ctx.deadlines.dim1).toBeLessThan(0);
    });

    it("sets large time_since_last_attempt when no last_updated", () => {
      const goal = makeGoal();
      goal.dimensions[0]!.last_updated = null;
      const ctx = buildDriveContext(goal);

      expect(ctx.time_since_last_attempt.dim1).toBe(168);
    });

    it("computes time_since_last_attempt from last_updated", () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const goal = makeGoal();
      goal.dimensions[0]!.last_updated = twoHoursAgo;
      const ctx = buildDriveContext(goal);

      expect(ctx.time_since_last_attempt.dim1).toBeGreaterThan(1.9);
      expect(ctx.time_since_last_attempt.dim1).toBeLessThan(2.1);
    });

    it("handles goal with no dimensions", () => {
      const goal = makeGoal({ dimensions: [] });
      const ctx = buildDriveContext(goal);

      expect(ctx.time_since_last_attempt).toEqual({});
      expect(ctx.deadlines).toEqual({});
    });
  });

  // ─── Constructor & Config ───

  describe("constructor", () => {
    it("creates CoreLoop with default config", () => {
      const { deps } = createMockDeps(tmpDir);
      const loop = new CoreLoop(deps);
      expect(loop).toBeDefined();
    });

    it("accepts custom config", () => {
      const { deps } = createMockDeps(tmpDir);
      const config: LoopConfig = {
        maxIterations: 5,
        maxConsecutiveErrors: 2,
        delayBetweenLoopsMs: 0,
        adapterType: "test_adapter",
      };
      const loop = new CoreLoop(deps, config);
      expect(loop).toBeDefined();
    });
  });

  // ─── stop() ───

  describe("stop()", async () => {
    it("sets stopped flag", () => {
      const { deps } = createMockDeps(tmpDir);
      const loop = new CoreLoop(deps);

      expect(loop.isStopped()).toBe(false);
      loop.stop();
      expect(loop.isStopped()).toBe(true);
    });

    it("stops the loop on next iteration", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      const goal = makeGoal();
      await mocks.stateManager.saveGoal(goal);

      const loop = new CoreLoop(deps, { maxIterations: 100, delayBetweenLoopsMs: 0 });

      // Stop after first iteration
      let iterationCount = 0;
      mocks.taskLifecycle.runTaskCycle.mockImplementation(async () => {
        iterationCount++;
        if (iterationCount >= 1) {
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
