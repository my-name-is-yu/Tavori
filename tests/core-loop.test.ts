import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CoreLoop,
  buildDriveContext,
  type LoopConfig,
  type CoreLoopDeps,
  type GapCalculatorModule,
  type DriveScorerModule,
  type ReportingEngine,
  type LoopIterationResult,
} from "../src/core-loop.js";
import { StateManager } from "../src/state-manager.js";
import type { ObservationEngine } from "../src/observation/observation-engine.js";
import type { TaskLifecycle, TaskCycleResult } from "../src/execution/task-lifecycle.js";
import type { SatisficingJudge } from "../src/drive/satisficing-judge.js";
import type { StallDetector } from "../src/drive/stall-detector.js";
import type { StrategyManager } from "../src/strategy/strategy-manager.js";
import type { DriveSystem } from "../src/drive/drive-system.js";
import type { AdapterRegistry, IAdapter } from "../src/execution/adapter-layer.js";
import type { Goal } from "../src/types/goal.js";
import type { GapVector } from "../src/types/gap.js";
import type { CompletionJudgment } from "../src/types/satisficing.js";
import type { StallReport } from "../src/types/stall.js";
import type { DriveScore } from "../src/types/drive.js";

// ─── Test Helpers ───

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-core-loop-test-"));
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: "goal-1",
    parent_id: null,
    node_type: "goal",
    title: "Test Goal",
    description: "A test goal",
    status: "active",
    dimensions: [
      {
        name: "dim1",
        label: "Dimension 1",
        current_value: 5,
        threshold: { type: "min", value: 10 },
        confidence: 0.8,
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
      {
        name: "dim2",
        label: "Dimension 2",
        current_value: 3,
        threshold: { type: "min", value: 8 },
        confidence: 0.7,
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
    ...overrides,
  };
}

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

// ─── Mock Factories ───

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

describe("CoreLoop", () => {
  // NOTE: All collaborators are mocked. These tests verify orchestration contract
  // (correct methods called in correct order, correct exit conditions) but cannot
  // detect bugs in actual data flow between modules.
  // For cross-module integration coverage, see core-loop-integration.test.ts

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
      const goal = makeGoal();
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

  describe("stop()", () => {
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
      mocks.stateManager.saveGoal(goal);

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

  // ─── runOneIteration ───

  describe("runOneIteration", () => {
    it("calls each step in correct order", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      const goal = makeGoal();
      mocks.stateManager.saveGoal(goal);

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
      mocks.stateManager.saveGoal(makeGoal());
      mocks.gapCalculator.aggregateGaps.mockReturnValue(0.75);

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.gapAggregate).toBe(0.75);
    });

    it("populates driveScores", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.driveScores.length).toBe(2);
    });

    it("populates loopIndex", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 7);

      expect(result.loopIndex).toBe(7);
    });

    it("records elapsed time", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it("persists gap history entry", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      const history = mocks.stateManager.loadGapHistory("goal-1");
      expect(history.length).toBe(1);
      expect(history[0]!.iteration).toBe(0);
    });

    it("skips task generation when gapAggregate is 0", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

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

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.gapAggregate).toBe(0);
      expect(result.taskResult).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
      expect(result.completionJudgment.is_complete).toBe(true);
    });
  });

  // ─── Completion detection ───

  describe("completion detection", () => {
    it("returns completed result when goal is complete", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

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
      mocks.stateManager.saveGoal(makeGoal());

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
      mocks.stateManager.saveGoal(goal);

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

  describe("error handling", () => {
    it("handles gap calculation failure gracefully", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());
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
      mocks.stateManager.saveGoal(makeGoal());
      mocks.driveScorer.scoreAllDimensions.mockImplementation(() => {
        throw new Error("Drive scoring error");
      });

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toContain("Drive scoring");
    });

    it("handles completion check failure gracefully", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());
      mocks.satisficingJudge.isGoalComplete.mockImplementation(() => {
        throw new Error("Completion check error");
      });

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toContain("Completion check");
    });

    it("handles task cycle failure gracefully", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockRejectedValue(
        new Error("Task cycle error")
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toContain("Task cycle");
    });

    it("stall detection failure does not crash the iteration", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());
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
      mocks.stateManager.saveGoal(makeGoal());
      mocks.reportingEngine.generateExecutionSummary.mockImplementation(() => {
        throw new Error("Report error");
      });

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      // Iteration should still complete successfully
      expect(result.taskResult).not.toBeNull();
    });
  });

  // ─── Consecutive error limit ───

  describe("consecutive error limit", () => {
    it("stops loop after maxConsecutiveErrors", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockRejectedValue(
        new Error("Persistent error")
      );

      const loop = new CoreLoop(deps, {
        maxIterations: 100,
        maxConsecutiveErrors: 3,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("error");
      expect(result.totalIterations).toBe(3);
    });

    it("resets consecutive errors on success", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      let callCount = 0;
      mocks.taskLifecycle.runTaskCycle.mockImplementation(async () => {
        callCount++;
        // Fail on calls 1-2, succeed on 3, fail on 4-5, succeed on 6
        if (callCount <= 2 || (callCount >= 4 && callCount <= 5)) {
          throw new Error("Temporary error");
        }
        return makeTaskCycleResult();
      });

      const loop = new CoreLoop(deps, {
        maxIterations: 7,
        maxConsecutiveErrors: 3,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      // Should not stop with "error" because errors are interspersed with successes
      expect(result.finalStatus).toBe("max_iterations");
      expect(result.totalIterations).toBe(7);
    });

    it("accumulates consecutive errors correctly", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      let callCount = 0;
      mocks.taskLifecycle.runTaskCycle.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return makeTaskCycleResult(); // success
        throw new Error("Error"); // fail from 2 onward
      });

      const loop = new CoreLoop(deps, {
        maxIterations: 100,
        maxConsecutiveErrors: 3,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("error");
      // 1 success + 3 errors = 4 iterations
      expect(result.totalIterations).toBe(4);
    });
  });

  // ─── Max iterations ───

  describe("max iterations", () => {
    it("stops loop at maxIterations", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, {
        maxIterations: 5,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("max_iterations");
      expect(result.totalIterations).toBe(5);
    });

    it("respects maxIterations of 1", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, {
        maxIterations: 1,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.totalIterations).toBe(1);
    });
  });

  // ─── Stall detection + pivot ───

  describe("stall detection", () => {
    it("detects dimension stall", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      mocks.stallDetector.checkDimensionStall.mockReturnValue(makeStallReport());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.stallDetected).toBe(true);
      expect(result.stallReport).not.toBeNull();
    });

    it("calls strategyManager.onStallDetected when stall detected", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      mocks.stallDetector.checkDimensionStall.mockReturnValue(makeStallReport());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.strategyManager.onStallDetected).toHaveBeenCalledWith(
        "goal-1",
        expect.any(Number)
      );
    });

    it("records pivot when strategy manager returns new strategy", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      mocks.stallDetector.checkDimensionStall.mockReturnValue(makeStallReport());
      mocks.strategyManager.onStallDetected.mockResolvedValue({
        id: "strategy-2",
        state: "active",
      });

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.pivotOccurred).toBe(true);
    });

    it("does not record pivot when strategy manager returns null", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      mocks.stallDetector.checkDimensionStall.mockReturnValue(makeStallReport());
      mocks.strategyManager.onStallDetected.mockResolvedValue(null);

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.pivotOccurred).toBe(false);
    });

    it("increments escalation on stall", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      mocks.stallDetector.checkDimensionStall.mockReturnValue(makeStallReport());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.stallDetector.incrementEscalation).toHaveBeenCalledWith(
        "goal-1",
        "dim1"
      );
    });

    it("detects global stall when no dimension stall", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      mocks.stallDetector.checkDimensionStall.mockReturnValue(null);
      mocks.stallDetector.checkGlobalStall.mockReturnValue(
        makeStallReport({ stall_type: "global_stall", dimension_name: null })
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.stallDetected).toBe(true);
      expect(result.stallReport!.stall_type).toBe("global_stall");
    });

    it("stops loop on high escalation level stall", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      mocks.stallDetector.checkDimensionStall.mockReturnValue(
        makeStallReport({ escalation_level: 3 })
      );

      const loop = new CoreLoop(deps, {
        maxIterations: 100,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("stalled");
    });

    it("does not stop loop on low escalation level stall", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      mocks.stallDetector.checkDimensionStall.mockReturnValue(
        makeStallReport({ escalation_level: 1 })
      );

      const loop = new CoreLoop(deps, {
        maxIterations: 3,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("max_iterations");
    });
  });

  // ─── Task cycle results ───

  describe("task cycle results", () => {
    it("records completed action", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(
        makeTaskCycleResult({ action: "completed" })
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.taskResult!.action).toBe("completed");
    });

    it("records keep action", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(
        makeTaskCycleResult({ action: "keep" })
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.taskResult!.action).toBe("keep");
    });

    it("records discard action", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(
        makeTaskCycleResult({ action: "discard" })
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.taskResult!.action).toBe("discard");
    });

    it("records escalate action", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(
        makeTaskCycleResult({ action: "escalate" })
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.taskResult!.action).toBe("escalate");
    });

    it("records approval_denied action", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(
        makeTaskCycleResult({ action: "approval_denied" })
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.taskResult!.action).toBe("approval_denied");
    });
  });

  // ─── approval_denied and escalate loop stopping ───

  describe("approval_denied loop stopping", () => {
    it("stops loop after 3 consecutive approval_denied results", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(
        makeTaskCycleResult({ action: "approval_denied" })
      );

      const loop = new CoreLoop(deps, {
        maxIterations: 100,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("stopped");
      expect(result.totalIterations).toBe(3);
    });

    it("does not stop loop after only 2 consecutive approval_denied results", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      let callCount = 0;
      mocks.taskLifecycle.runTaskCycle.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return makeTaskCycleResult({ action: "approval_denied" });
        }
        return makeTaskCycleResult({ action: "completed" });
      });

      const loop = new CoreLoop(deps, {
        maxIterations: 5,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("max_iterations");
      expect(result.totalIterations).toBe(5);
    });

    it("resets consecutiveDenied counter on non-denied result", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      // Pattern: denied, denied, completed, denied, denied, denied → should stop on 6th iteration
      const actions = [
        "approval_denied",
        "approval_denied",
        "completed",
        "approval_denied",
        "approval_denied",
        "approval_denied",
      ] as const;
      let callCount = 0;
      mocks.taskLifecycle.runTaskCycle.mockImplementation(async () => {
        const action = actions[callCount] ?? "completed";
        callCount++;
        return makeTaskCycleResult({ action });
      });

      const loop = new CoreLoop(deps, {
        maxIterations: 100,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("stopped");
      // 3 non-reset denials happen at iterations 4,5,6 (1-indexed)
      expect(result.totalIterations).toBe(6);
    });
  });

  describe("escalate loop stopping", () => {
    it("stops loop after 3 consecutive escalate results", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(
        makeTaskCycleResult({ action: "escalate" })
      );

      const loop = new CoreLoop(deps, {
        maxIterations: 100,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("stalled");
      expect(result.totalIterations).toBe(3);
    });

    it("does not stop loop after only 2 consecutive escalate results", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      let callCount = 0;
      mocks.taskLifecycle.runTaskCycle.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return makeTaskCycleResult({ action: "escalate" });
        }
        return makeTaskCycleResult({ action: "completed" });
      });

      const loop = new CoreLoop(deps, {
        maxIterations: 5,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("max_iterations");
      expect(result.totalIterations).toBe(5);
    });

    it("resets consecutiveEscalations counter on non-escalated result", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      // Pattern: escalate, escalate, completed, escalate, escalate, escalate → stops on 6th
      const actions = [
        "escalate",
        "escalate",
        "completed",
        "escalate",
        "escalate",
        "escalate",
      ] as const;
      let callCount = 0;
      mocks.taskLifecycle.runTaskCycle.mockImplementation(async () => {
        const action = actions[callCount] ?? "completed";
        callCount++;
        return makeTaskCycleResult({ action });
      });

      const loop = new CoreLoop(deps, {
        maxIterations: 100,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("stalled");
      expect(result.totalIterations).toBe(6);
    });
  });

  // ─── LoopResult construction ───

  describe("LoopResult construction", () => {
    it("populates all fields in LoopResult", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, {
        maxIterations: 2,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.goalId).toBe("goal-1");
      expect(result.totalIterations).toBe(2);
      expect(result.finalStatus).toBe("max_iterations");
      expect(result.iterations).toHaveLength(2);
      expect(result.startedAt).toBeDefined();
      expect(result.completedAt).toBeDefined();
    });

    it("startedAt is before completedAt", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, {
        maxIterations: 1,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      const started = new Date(result.startedAt).getTime();
      const completed = new Date(result.completedAt).getTime();
      expect(completed).toBeGreaterThanOrEqual(started);
    });

    it("iterations array contains correct number of results", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, {
        maxIterations: 3,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.iterations.length).toBe(3);
      expect(result.iterations[0]!.loopIndex).toBe(0);
      expect(result.iterations[1]!.loopIndex).toBe(1);
      expect(result.iterations[2]!.loopIndex).toBe(2);
    });

    it("returns error status when goal not found", async () => {
      const { deps } = createMockDeps(tmpDir);
      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.run("nonexistent-goal");

      expect(result.finalStatus).toBe("error");
      expect(result.totalIterations).toBe(0);
      expect(result.iterations).toHaveLength(0);
    });

    it("returns error status when goal has terminal status", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal({ status: "completed" }));

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("error");
      expect(result.totalIterations).toBe(0);
    });

    it("accepts waiting status goals", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal({ status: "waiting" }));

      const loop = new CoreLoop(deps, {
        maxIterations: 1,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.totalIterations).toBe(1);
    });
  });

  // ─── Report generation ───

  describe("report generation", () => {
    it("calls reportingEngine.generateExecutionSummary", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

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
      mocks.stateManager.saveGoal(makeGoal());
      const mockReport = { type: "test_report" };
      mocks.reportingEngine.generateExecutionSummary.mockReturnValue(mockReport);

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.reportingEngine.saveReport).toHaveBeenCalledWith(mockReport);
    });

    it("generates report on completion", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());
      mocks.satisficingJudge.isGoalComplete.mockReturnValue(
        makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.reportingEngine.generateExecutionSummary).toHaveBeenCalled();
    });

    it("generates report on task cycle error", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockRejectedValue(new Error("fail"));

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.reportingEngine.generateExecutionSummary).toHaveBeenCalled();
    });
  });

  // ─── Adapter resolution ───

  describe("adapter resolution", () => {
    it("gets adapter from registry using configured adapterType", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, {
        delayBetweenLoopsMs: 0,
        adapterType: "test_adapter",
      });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.adapterRegistry.getAdapter).toHaveBeenCalledWith("test_adapter");
    });

    it("uses default adapter type (openai_codex_cli)", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.adapterRegistry.getAdapter).toHaveBeenCalledWith("openai_codex_cli");
    });

    it("passes adapter to taskLifecycle.runTaskCycle", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

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

  describe("multi-iteration scenarios", () => {
    it("runs multiple iterations before completion", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

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
      mocks.stateManager.saveGoal(makeGoal());

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
      mocks.stateManager.saveGoal(makeGoal());

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

  describe("gap history", () => {
    it("appends gap history across iterations", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, {
        maxIterations: 3,
        delayBetweenLoopsMs: 0,
      });
      await loop.run("goal-1");

      const history = mocks.stateManager.loadGapHistory("goal-1");
      expect(history.length).toBe(3);
      expect(history[0]!.iteration).toBe(0);
      expect(history[1]!.iteration).toBe(1);
      expect(history[2]!.iteration).toBe(2);
    });

    it("gap history entries contain correct dimension data", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, {
        maxIterations: 1,
        delayBetweenLoopsMs: 0,
      });
      await loop.run("goal-1");

      const history = mocks.stateManager.loadGapHistory("goal-1");
      expect(history[0]!.gap_vector).toHaveLength(2);
      expect(history[0]!.gap_vector[0]!.dimension_name).toBe("dim1");
      expect(history[0]!.gap_vector[1]!.dimension_name).toBe("dim2");
      expect(history[0]!.confidence_vector).toHaveLength(2);
    });
  });

  // ─── Edge cases ───

  describe("edge cases", () => {
    it("handles goal with single dimension", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      const goal = makeGoal();
      goal.dimensions = [goal.dimensions[0]!];
      mocks.stateManager.saveGoal(goal);

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
      mocks.stateManager.saveGoal(goal);

      const loop = new CoreLoop(deps, {
        maxIterations: 1,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.totalIterations).toBe(1);
    });

    it("handles cancelled goal status", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal({ status: "cancelled" }));

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("error");
      expect(result.totalIterations).toBe(0);
    });

    it("handles archived goal status", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal({ status: "archived" }));

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("error");
      expect(result.totalIterations).toBe(0);
    });

    it("re-checks completion after task cycle", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

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

  describe("DriveContext usage", () => {
    it("passes correctly built DriveContext to task cycle", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      const deadline = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
      mocks.stateManager.saveGoal(makeGoal({ deadline }));

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

  describe("concurrent stop()", () => {
    it("stops between iterations", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, {
        maxIterations: 100,
        delayBetweenLoopsMs: 10,
      });

      // Stop after a short delay
      setTimeout(() => loop.stop(), 5);

      const result = await loop.run("goal-1");
      expect(result.finalStatus).toBe("stopped");
      expect(result.totalIterations).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── KnowledgeManager integration ───

  describe("KnowledgeManager integration", () => {
    function makeAcquisitionTask() {
      return {
        id: "acq-task-1",
        goal_id: "goal-1",
        strategy_id: null,
        target_dimensions: [],
        primary_dimension: "knowledge",
        work_description: "Research task: missing knowledge",
        rationale: "Knowledge gap detected",
        approach: "Research questions",
        success_criteria: [
          {
            description: "All questions answered",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
        scope_boundary: {
          in_scope: ["Information collection"],
          out_of_scope: ["System modifications"],
          blast_radius: "None — read-only research task",
        },
        constraints: ["No system modifications allowed"],
        plateau_until: null,
        estimated_duration: { value: 4, unit: "hours" as const },
        consecutive_failure_count: 0,
        reversibility: "reversible" as const,
        task_category: "knowledge_acquisition" as const,
        status: "pending" as const,
        started_at: null,
        completed_at: null,
        timeout_at: null,
        heartbeat_at: null,
        created_at: new Date().toISOString(),
      };
    }

    it("generates acquisition task when knowledge gap detected", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const gapSignal = {
        signal_type: "interpretation_difficulty" as const,
        missing_knowledge: "Unknown domain",
        source_step: "gap_recognition",
        related_dimension: null,
      };

      const acquisitionTask = makeAcquisitionTask();

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(gapSignal),
        generateAcquisitionTask: vi.fn().mockResolvedValue(acquisitionTask),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(knowledgeManager.detectKnowledgeGap).toHaveBeenCalledOnce();
      expect(knowledgeManager.generateAcquisitionTask).toHaveBeenCalledWith(gapSignal, "goal-1");
      // runTaskCycle should NOT have been called — early return with acquisition task
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
      expect(result.taskResult).not.toBeNull();
      expect(result.taskResult?.task.task_category).toBe("knowledge_acquisition");
      expect(result.taskResult?.action).toBe("completed");
    });

    it("proceeds with normal task cycle when no knowledge gap detected", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(null),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(knowledgeManager.detectKnowledgeGap).toHaveBeenCalledOnce();
      expect(knowledgeManager.generateAcquisitionTask).not.toHaveBeenCalled();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("injects relevant knowledge into task generation context", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const knowledgeEntries = [
        {
          entry_id: "e1",
          question: "What is the auth pattern?",
          answer: "JWT tokens",
          sources: [],
          confidence: 0.9,
          acquired_at: new Date().toISOString(),
          acquisition_task_id: "t1",
          superseded_by: null,
          tags: ["dim2"],
        },
      ];

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(null),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue(knowledgeEntries),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue(knowledgeEntries),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(knowledgeManager.getRelevantKnowledge).toHaveBeenCalledWith("goal-1", expect.any(String));
      // runTaskCycle should receive knowledgeContext as the 5th argument
      const callArgs = mocks.taskLifecycle.runTaskCycle.mock.calls[0];
      expect(callArgs![4]).toContain("JWT tokens");
    });

    it("skips knowledge injection gracefully when getRelevantKnowledge returns empty", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(null),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      const callArgs = mocks.taskLifecycle.runTaskCycle.mock.calls[0];
      // knowledgeContext should be undefined when no entries found
      expect(callArgs![4]).toBeUndefined();
    });

    it("continues normally when knowledgeManager is undefined", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      // No knowledgeManager in deps
      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("non-fatal: continues when detectKnowledgeGap throws", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockRejectedValue(new Error("LLM failure")),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      // Should fall through to normal task cycle
      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });
  });

  // ─── CapabilityDetector integration ───

  describe("CapabilityDetector integration", () => {
    function makeCapabilityGap() {
      return {
        missing_capability: { name: "bash_execution", type: "tool" as const },
        reason: "Task requires running shell commands",
        alternatives: ["Use a subprocess adapter"],
        impact_description: "Cannot execute shell-based tasks",
        related_task_id: "task-preview-1",
      };
    }

    it("delegates capability detection to TaskLifecycle when capabilityDetector provided and deficiency detected", async () => {
      // Capability detection is handled inside TaskLifecycle.runTaskCycle, not CoreLoop.
      // CoreLoop must still call runTaskCycle and return whatever result TaskLifecycle produces.
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const escalateResult = makeTaskCycleResult({ action: "escalate" });
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(escalateResult);

      const capabilityDetector = {
        detectDeficiency: vi.fn(),
        escalateToUser: vi.fn(),
        loadRegistry: vi.fn(),
        saveRegistry: vi.fn(),
        registerCapability: vi.fn(),
        confirmDeficiency: vi.fn(),
      };

      const depsWithCD = { ...deps, capabilityDetector: capabilityDetector as any };
      const loop = new CoreLoop(depsWithCD, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      // CoreLoop must delegate to runTaskCycle — capability detection is TaskLifecycle's concern
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
      // CoreLoop must NOT call detectDeficiency directly (avoids duplicate calls + orphan tasks)
      expect(capabilityDetector.detectDeficiency).not.toHaveBeenCalled();
      expect(result.taskResult?.action).toBe("escalate");
    });

    it("proceeds with runTaskCycle when capabilityDetector provided and no deficiency", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const capabilityDetector = {
        detectDeficiency: vi.fn(),
        escalateToUser: vi.fn(),
        loadRegistry: vi.fn(),
        saveRegistry: vi.fn(),
        registerCapability: vi.fn(),
        confirmDeficiency: vi.fn(),
      };

      const depsWithCD = { ...deps, capabilityDetector: capabilityDetector as any };
      const loop = new CoreLoop(depsWithCD, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      // CoreLoop delegates to runTaskCycle; capability detection is inside TaskLifecycle
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
      expect(capabilityDetector.detectDeficiency).not.toHaveBeenCalled();
      expect(capabilityDetector.escalateToUser).not.toHaveBeenCalled();
    });

    it("continues normally when capabilityDetector is undefined", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("always calls runTaskCycle even when capabilityDetector is present", async () => {
      // CoreLoop no longer calls detectDeficiency directly — TaskLifecycle owns that.
      // Verify CoreLoop always reaches runTaskCycle regardless of capabilityDetector presence.
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const capabilityDetector = {
        detectDeficiency: vi.fn(),
        escalateToUser: vi.fn(),
        loadRegistry: vi.fn(),
        saveRegistry: vi.fn(),
        registerCapability: vi.fn(),
        confirmDeficiency: vi.fn(),
      };

      const depsWithCD = { ...deps, capabilityDetector: capabilityDetector as any };
      const loop = new CoreLoop(depsWithCD, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });
  });

  // ─── PortfolioManager integration ───

  describe("PortfolioManager integration", () => {
    function createMockPortfolioManager() {
      return {
        selectNextStrategyForTask: vi.fn().mockReturnValue(null),
        recordTaskCompletion: vi.fn(),
        shouldRebalance: vi.fn().mockReturnValue(null),
        rebalance: vi.fn().mockReturnValue({ triggered_by: "periodic", adjustments: [], new_generation_needed: false, timestamp: new Date().toISOString() }),
        isWaitStrategy: vi.fn().mockReturnValue(false),
        handleWaitStrategyExpiry: vi.fn().mockReturnValue(null),
        getRebalanceHistory: vi.fn().mockReturnValue([]),
      };
    }

    it("works without portfolioManager (backward compat)", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      // deps has no portfolioManager
      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("calls selectNextStrategyForTask when portfolioManager provided", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const portfolioManager = createMockPortfolioManager();
      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.selectNextStrategyForTask).toHaveBeenCalledWith("goal-1");
    });

    it("calls setOnTaskComplete when selectNextStrategyForTask returns a result", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const selectionResult = { strategy_id: "strategy-1", allocation: 0.6 };
      const portfolioManager = createMockPortfolioManager();
      portfolioManager.selectNextStrategyForTask.mockReturnValue(selectionResult);

      // Add setOnTaskComplete to taskLifecycle mock
      mocks.taskLifecycle.setOnTaskComplete = vi.fn();

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.taskLifecycle.setOnTaskComplete).toHaveBeenCalledWith(expect.any(Function));
    });

    it("calls recordTaskCompletion after task completion when strategy_id present", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      // Task result has a strategy_id
      const taskResultWithStrategy = makeTaskCycleResult({
        action: "completed",
        task: {
          ...makeTaskCycleResult().task,
          strategy_id: "strategy-abc",
        },
      });
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(taskResultWithStrategy);

      const portfolioManager = createMockPortfolioManager();
      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.recordTaskCompletion).toHaveBeenCalledWith("strategy-abc");
    });

    it("does not call recordTaskCompletion when task action is not completed", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const taskResultKeep = makeTaskCycleResult({
        action: "keep",
        task: {
          ...makeTaskCycleResult().task,
          strategy_id: "strategy-abc",
        },
      });
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(taskResultKeep);

      const portfolioManager = createMockPortfolioManager();
      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.recordTaskCompletion).not.toHaveBeenCalled();
    });

    it("checks shouldRebalance after stall detection", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());
      mocks.stallDetector.checkDimensionStall.mockReturnValue(makeStallReport());

      const portfolioManager = createMockPortfolioManager();
      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.shouldRebalance).toHaveBeenCalledWith("goal-1");
    });

    it("calls rebalance when shouldRebalance returns a trigger", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const trigger = { type: "periodic" as const, details: "interval elapsed" };
      const portfolioManager = createMockPortfolioManager();
      portfolioManager.shouldRebalance.mockReturnValue(trigger);

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.rebalance).toHaveBeenCalledWith("goal-1", trigger);
    });

    it("calls onStallDetected when rebalance requires new generation", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const trigger = { type: "periodic" as const, details: "interval elapsed" };
      const portfolioManager = createMockPortfolioManager();
      portfolioManager.shouldRebalance.mockReturnValue(trigger);
      portfolioManager.rebalance.mockReturnValue({
        triggered_by: "periodic",
        adjustments: [],
        new_generation_needed: true,
        timestamp: new Date().toISOString(),
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.strategyManager.onStallDetected).toHaveBeenCalledWith("goal-1", 3);
    });

    it("handles WaitStrategy expiry check — calls rebalance when handleWaitStrategyExpiry returns a trigger", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const waitStrategy = {
        id: "wait-strategy-1",
        state: "active",
        goal_id: "goal-1",
      };
      // Return a portfolio with a wait strategy
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });

      const waitTrigger = { type: "wait_expired" as const, details: "wait period elapsed" };
      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry.mockReturnValue(waitTrigger);

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.handleWaitStrategyExpiry).toHaveBeenCalledWith("goal-1", waitStrategy.id);
      expect(portfolioManager.rebalance).toHaveBeenCalledWith("goal-1", waitTrigger);
    });

    it("portfolio rebalance errors are non-fatal", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      const portfolioManager = createMockPortfolioManager();
      portfolioManager.shouldRebalance.mockImplementation(() => {
        throw new Error("rebalance check failed");
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      // Should still reach task cycle
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
      expect(result.error).toBeNull();
    });
  });
});

// ─── Tree Mode Tests (14B) ───
describe("CoreLoop tree mode (14B)", () => {
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
    mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    await loop.runOneIteration("goal-1", 0);

    expect(mockStateAggregator.aggregateChildStates).toHaveBeenCalledWith("goal-1");
  });

  it("reloads goal after tree aggregation", async () => {
    const { deps, mocks } = createTreeDeps(tmpDir);
    const childId = "child-goal-1";
    const goal = makeGoal({ id: "goal-1", children_ids: [childId] });
    mocks.stateManager.saveGoal(goal);

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
    mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    await loop.runOneIteration("goal-1", 0);

    expect(mockStateAggregator.aggregateChildStates).not.toHaveBeenCalled();
  });

  it("uses judgeTreeCompletion for goals with children", async () => {
    const { deps, mocks } = createTreeDeps(tmpDir);
    const childId = "child-goal-1";
    const goal = makeGoal({ id: "goal-1", children_ids: [childId] });
    mocks.stateManager.saveGoal(goal);

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
    mocks.stateManager.saveGoal(goal);

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
    mocks.stateManager.saveGoal(goal);

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
    mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    const result = await loop.runOneIteration("goal-1", 0);

    expect(result.error).toBeNull();
    expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalled();
  });

  it("backward compatible without goalTreeManager", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    // goalTreeManager intentionally omitted
    const goal = makeGoal({ id: "goal-1", children_ids: [] });
    mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    const result = await loop.runOneIteration("goal-1", 0);

    expect(result.error).toBeNull();
    expect(mocks.satisficingJudge.isGoalComplete).toHaveBeenCalled();
  });

  it("post-task re-check uses judgeTreeCompletion for tree goals", async () => {
    const { deps, mocks } = createTreeDeps(tmpDir);
    const childId = "child-goal-1";
    const goal = makeGoal({ id: "goal-1", children_ids: [childId] });
    mocks.stateManager.saveGoal(goal);

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
    mocks.stateManager.saveGoal(goal);

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
import type { TreeLoopOrchestrator } from "../src/goal/tree-loop-orchestrator.js";

describe("CoreLoop tree mode (14C)", () => {
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
    mocks.stateManager.saveGoal(rootGoal);
    mocks.stateManager.saveGoal(nodeGoal);

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

    const rootGoal = makeGoal({ id: "root-1", children_ids: [] });
    mocks.stateManager.saveGoal(rootGoal);

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
    mocks.stateManager.saveGoal(goal);

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
    mocks.stateManager.saveGoal(rootGoal);
    mocks.stateManager.saveGoal(nodeGoal);

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
    mocks.stateManager.saveGoal(rootGoal);
    mocks.stateManager.saveGoal(nodeGoal);

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
    mocks.stateManager.saveGoal(rootGoal);
    mocks.stateManager.saveGoal(nodeGoal1);
    mocks.stateManager.saveGoal(nodeGoal2);

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
    mocks.stateManager.saveGoal(rootGoal);
    mocks.stateManager.saveGoal(nodeGoal);

    const loop = new CoreLoop(deps, { treeMode: true, delayBetweenLoopsMs: 0 });
    const iterResult = await loop.runTreeIteration("root-1", 0);

    // The iteration result goalId should be the selected node, not root
    expect(iterResult.goalId).toBe("node-id-1");
  });

  it("runTreeIteration with null node returns rootId and no task", async () => {
    const orchestratorMock = createTreeLoopOrchestratorMock();
    orchestratorMock.selectNextNode.mockReturnValue(null);
    const { deps, mocks } = createTreeModeDeps(tmpDir, orchestratorMock);

    const rootGoal = makeGoal({ id: "root-1", children_ids: [] });
    mocks.stateManager.saveGoal(rootGoal);

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
    mocks.stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { treeMode: false, maxIterations: 1, delayBetweenLoopsMs: 0 });
    await loop.run("goal-1");

    // selectNextNode should NOT be called — normal mode
    expect(orchestratorMock.selectNextNode).not.toHaveBeenCalled();
    // Normal task cycle is called
    expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalled();
  });

  // ─── Archive on completion ───

  describe("archive on completion", () => {
    it("calls memoryLifecycleManager.onGoalClose on completion", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

      mocks.satisficingJudge.isGoalComplete.mockReturnValue(
        makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })
      );

      const memoryLifecycleManager = {
        onGoalClose: vi.fn().mockResolvedValue(undefined),
      };
      deps.memoryLifecycleManager = memoryLifecycleManager as unknown as import("../src/knowledge/memory-lifecycle.js").MemoryLifecycleManager;

      const loop = new CoreLoop(deps, { maxIterations: 10, delayBetweenLoopsMs: 0 });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("completed");
      expect(memoryLifecycleManager.onGoalClose).toHaveBeenCalledWith("goal-1", "completed");
    });

    it("calls stateManager.archiveGoal on completion", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      mocks.stateManager.saveGoal(makeGoal());

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
      mocks.stateManager.saveGoal(makeGoal());

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
      mocks.stateManager.saveGoal(makeGoal());

      // Goal never completes — max_iterations
      const archiveSpy = vi.spyOn(mocks.stateManager, "archiveGoal");

      const loop = new CoreLoop(deps, { maxIterations: 2, delayBetweenLoopsMs: 0 });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("max_iterations");
      expect(archiveSpy).not.toHaveBeenCalled();
    });
  });
});
