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

  // ─── KnowledgeManager integration ───

  describe("KnowledgeManager integration", async () => {
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
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

      // No knowledgeManager in deps
      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("non-fatal: continues when detectKnowledgeGap throws", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

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

  describe("CapabilityDetector integration", async () => {
    it("delegates capability detection to TaskLifecycle when capabilityDetector provided and deficiency detected", async () => {
      // Capability detection is handled inside TaskLifecycle.runTaskCycle, not CoreLoop.
      // CoreLoop must still call runTaskCycle and return whatever result TaskLifecycle produces.
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("always calls runTaskCycle even when capabilityDetector is present", async () => {
      // CoreLoop no longer calls detectDeficiency directly — TaskLifecycle owns that.
      // Verify CoreLoop always reaches runTaskCycle regardless of capabilityDetector presence.
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

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

  describe("PortfolioManager integration", async () => {
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
      await mocks.stateManager.saveGoal(makeGoal());

      // deps has no portfolioManager
      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("calls selectNextStrategyForTask when portfolioManager provided", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const portfolioManager = createMockPortfolioManager();
      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.selectNextStrategyForTask).toHaveBeenCalledWith("goal-1");
    });

    it("calls setOnTaskComplete when selectNextStrategyForTask returns a result", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.stallDetector.checkDimensionStall.mockReturnValue(makeStallReport());

      const portfolioManager = createMockPortfolioManager();
      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.shouldRebalance).toHaveBeenCalledWith("goal-1");
    });

    it("calls rebalance when shouldRebalance returns a trigger", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

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

      expect(mocks.strategyManager.onStallDetected).toHaveBeenCalledWith("goal-1", 3, expect.any(String));
    });

    it("handles WaitStrategy expiry check — calls rebalance when handleWaitStrategyExpiry returns a trigger", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

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
      await mocks.stateManager.saveGoal(makeGoal());

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
