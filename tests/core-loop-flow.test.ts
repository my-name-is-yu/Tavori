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

  // ─── Consecutive error limit ───

  describe("consecutive error limit", async () => {
    it("stops loop after maxConsecutiveErrors", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
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
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

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

  describe("max iterations", async () => {
    it("stops loop at maxIterations", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, {
        maxIterations: 1,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.totalIterations).toBe(1);
    });
  });

  // ─── Stall detection + pivot ───

  describe("stall detection", async () => {
    it("detects dimension stall", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      mocks.stallDetector.checkDimensionStall.mockReturnValue(makeStallReport());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.stallDetected).toBe(true);
      expect(result.stallReport).not.toBeNull();
    });

    it("calls strategyManager.onStallDetected when stall detected", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      mocks.stallDetector.checkDimensionStall.mockReturnValue(makeStallReport());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.strategyManager.onStallDetected).toHaveBeenCalledWith(
        "goal-1",
        expect.any(Number),
        expect.any(String)
      );
    });

    it("records pivot when strategy manager returns new strategy", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

      mocks.stallDetector.checkDimensionStall.mockReturnValue(makeStallReport());
      mocks.strategyManager.onStallDetected.mockResolvedValue(null);

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.pivotOccurred).toBe(false);
    });

    it("increments escalation on stall", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

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

    it("runs stall detection when gap=0 but is_complete=false", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      // gap=0 triggers skipTaskGeneration
      mocks.gapCalculator.aggregateGaps.mockReturnValue(0);
      // SatisficingJudge says not complete (e.g. low confidence)
      mocks.satisficingJudge.isGoalComplete.mockReturnValue(
        makeCompletionJudgment({ is_complete: false })
      );
      // Stall is detected
      mocks.stallDetector.checkDimensionStall.mockReturnValue(makeStallReport());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.stallDetected).toBe(true);
      expect(result.stallReport).not.toBeNull();
      // Task cycle should NOT have run (gap=0 means no task needed)
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
    });
  });

  // ─── Task cycle results ───

  describe("task cycle results", async () => {
    it("records completed action", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(
        makeTaskCycleResult({ action: "completed" })
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.taskResult!.action).toBe("completed");
    });

    it("records keep action", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(
        makeTaskCycleResult({ action: "keep" })
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.taskResult!.action).toBe("keep");
    });

    it("records discard action", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(
        makeTaskCycleResult({ action: "discard" })
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.taskResult!.action).toBe("discard");
    });

    it("records escalate action", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(
        makeTaskCycleResult({ action: "escalate" })
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.taskResult!.action).toBe("escalate");
    });

    it("records approval_denied action", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(
        makeTaskCycleResult({ action: "approval_denied" })
      );

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.taskResult!.action).toBe("approval_denied");
    });
  });

  // ─── approval_denied and escalate loop stopping ───

  describe("approval_denied loop stopping", async () => {
    it("stops loop after 3 consecutive approval_denied results", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
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
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

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

  describe("escalate loop stopping", async () => {
    it("stops loop after 3 consecutive escalate results", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
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
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

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

  describe("LoopResult construction", async () => {
    it("populates all fields in LoopResult", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal({ status: "completed" }));

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.run("goal-1");

      expect(result.finalStatus).toBe("error");
      expect(result.totalIterations).toBe(0);
    });

    it("accepts waiting status goals", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal({ status: "waiting" }));

      const loop = new CoreLoop(deps, {
        maxIterations: 1,
        delayBetweenLoopsMs: 0,
      });
      const result = await loop.run("goal-1");

      expect(result.totalIterations).toBe(1);
    });
  });
});
