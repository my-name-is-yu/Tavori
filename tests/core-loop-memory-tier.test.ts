/**
 * core-loop-memory-tier.test.ts
 *
 * Integration tests for CoreLoop memory tier wiring:
 *   1. highDissatisfaction dimensions extracted and passed through
 *   2. satisficing callback correctly iterates dimensions
 *   3. dynamic budget computed from drive scores
 *   4. full flow: drives → satisficing → memory tier adjustment
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { scoreDrivesAndCheckKnowledge } from "../src/loop/core-loop-phases.js";
import { checkCompletionAndMilestones, runTaskCycleWithContext } from "../src/loop/core-loop-phases-b.js";
import type { PhaseCtx } from "../src/loop/core-loop-phases.js";
import type { LoopIterationResult } from "../src/loop/core-loop-types.js";
import type { Goal } from "../src/types/goal.js";
import type { GapVector } from "../src/types/gap.js";
import type { DriveScore } from "../src/types/drive.js";

// ─── Helpers ───

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    title: "Test goal",
    description: "Test",
    dimensions: [
      {
        name: "dim1",
        threshold: { type: "min", value: 80 },
        current_value: 50,
        confidence: 0.8,
        weight: 1.0,
        last_updated: new Date().toISOString(),
      },
      {
        name: "dim2",
        threshold: { type: "min", value: 80 },
        current_value: 85,
        confidence: 0.9,
        weight: 1.0,
        last_updated: new Date().toISOString(),
      },
    ],
    gap_aggregation: "max",
    uncertainty_weight: 1.0,
    status: "active",
    origin: "general",
    children_ids: [],
    deadline: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeGapVector(goalId = "goal-1"): GapVector {
  return {
    goal_id: goalId,
    gaps: [
      {
        dimension_name: "dim1",
        raw_gap: 30,
        normalized_gap: 0.8,
        normalized_weighted_gap: 0.8,
        confidence: 0.8,
        uncertainty_weight: 1.0,
      },
      {
        dimension_name: "dim2",
        raw_gap: 0,
        normalized_gap: 0.0,
        normalized_weighted_gap: 0.0,
        confidence: 0.9,
        uncertainty_weight: 1.0,
      },
    ],
    timestamp: new Date().toISOString(),
  };
}

function makeResult(): LoopIterationResult {
  return {
    loopIndex: 0,
    goalId: "goal-1",
    gapAggregate: 0.8,
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

function makeBaseCtx(overrides: Partial<PhaseCtx["deps"]> = {}): PhaseCtx {
  const driveScorer = {
    scoreAllDimensions: vi.fn().mockReturnValue([
      { dimension_name: "dim1", dissatisfaction: 0.85, deadline: 0, opportunity: 0, final_score: 0.85, dominant_drive: "dissatisfaction" },
      { dimension_name: "dim2", dissatisfaction: 0.1, deadline: 0, opportunity: 0, final_score: 0.1, dominant_drive: "dissatisfaction" },
    ] as DriveScore[]),
    rankDimensions: vi.fn().mockImplementation((scores: DriveScore[]) => scores),
  };

  const strategyManager = {
    getPortfolio: vi.fn().mockResolvedValue(null),
    getActiveStrategy: vi.fn().mockResolvedValue(null),
    onStallDetected: vi.fn().mockResolvedValue(null),
    incrementPivotCount: vi.fn().mockResolvedValue(undefined),
  };

  const stateManager = {
    loadGoal: vi.fn().mockResolvedValue(null),
    appendGapHistoryEntry: vi.fn().mockResolvedValue(undefined),
    loadGapHistory: vi.fn().mockResolvedValue([]),
    getMilestones: vi.fn().mockReturnValue([]),
    evaluatePace: vi.fn().mockReturnValue({ status: "on_track", pace_ratio: 1.0 }),
    savePaceSnapshot: vi.fn().mockResolvedValue(undefined),
  };

  const satisficingJudge = {
    isGoalComplete: vi.fn().mockReturnValue({
      is_complete: false,
      blocking_dimensions: ["dim1"],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    }),
    judgeTreeCompletion: vi.fn().mockResolvedValue({
      is_complete: false,
      blocking_dimensions: [],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    }),
  };

  const stallDetector = {
    checkDimensionStall: vi.fn().mockReturnValue(null),
    checkGlobalStall: vi.fn().mockReturnValue(null),
    getEscalationLevel: vi.fn().mockResolvedValue(0),
    incrementEscalation: vi.fn().mockResolvedValue(undefined),
    analyzeStallCause: vi.fn().mockReturnValue(null),
  };

  const adapterRegistry = {
    getAdapter: vi.fn().mockReturnValue({
      adapterType: "mock",
      execute: vi.fn().mockResolvedValue({ success: true, output: "done", error: null, exit_code: 0, elapsed_ms: 100, stopped_reason: "completed" }),
    }),
  };

  const taskLifecycle = {
    runTaskCycle: vi.fn().mockResolvedValue({
      task: {
        id: "task-1",
        goal_id: "goal-1",
        strategy_id: null,
        target_dimensions: ["dim1"],
        primary_dimension: "dim1",
        work_description: "Task",
        rationale: "Rationale",
        approach: "Approach",
        success_criteria: [],
        scope_boundary: { in_scope: [], out_of_scope: [], blast_radius: "none" },
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
    }),
    setOnTaskComplete: vi.fn(),
  };

  const reportingEngine = {
    generateExecutionSummary: vi.fn().mockReturnValue({}),
    saveReport: vi.fn(),
  };

  const driveSystem = {
    computePaceConfig: vi.fn().mockReturnValue({}),
    getSchedule: vi.fn().mockResolvedValue(null),
    updateSchedule: vi.fn().mockResolvedValue(undefined),
  };

  return {
    deps: {
      stateManager: stateManager as any,
      observationEngine: {} as any,
      gapCalculator: {
        calculateGapVector: vi.fn().mockReturnValue(makeGapVector()),
        aggregateGaps: vi.fn().mockReturnValue(0.8),
      },
      driveScorer: driveScorer as any,
      taskLifecycle: taskLifecycle as any,
      satisficingJudge: satisficingJudge as any,
      stallDetector: stallDetector as any,
      strategyManager: strategyManager as any,
      reportingEngine: reportingEngine as any,
      driveSystem: driveSystem as any,
      adapterRegistry: adapterRegistry as any,
      ...overrides,
    } as any,
    config: {
      maxIterations: 10,
      maxConsecutiveErrors: 3,
      delayBetweenLoopsMs: 0,
      adapterType: "mock",
      treeMode: false,
      multiGoalMode: false,
      goalIds: [],
      minIterations: 1,
      autoArchive: false,
    },
    logger: undefined,
  };
}

// ─── Tests ───

describe("CoreLoop memory tier wiring", () => {
  describe("1. highDissatisfaction dimensions extraction", () => {
    it("extracts dimensions with dissatisfaction > 0.7 from drive scores", async () => {
      const ctx = makeBaseCtx();
      const goal = makeGoal();
      const gapVector = makeGapVector();
      const result = makeResult();

      const output = await scoreDrivesAndCheckKnowledge(
        ctx,
        "goal-1",
        goal,
        gapVector,
        0,
        result,
        Date.now(),
        vi.fn()
      );

      expect(output).not.toBeNull();
      expect(output!.highDissatisfactionDimensions).toContain("dim1");
      expect(output!.highDissatisfactionDimensions).not.toContain("dim2");
    });

    it("returns empty highDissatisfactionDimensions when no scores exceed 0.7", async () => {
      const ctx = makeBaseCtx();
      (ctx.deps.driveScorer.scoreAllDimensions as ReturnType<typeof vi.fn>).mockReturnValue([
        { dimension_name: "dim1", dissatisfaction: 0.5, deadline: 0, opportunity: 0, final_score: 0.5, dominant_drive: "dissatisfaction" },
        { dimension_name: "dim2", dissatisfaction: 0.3, deadline: 0, opportunity: 0, final_score: 0.3, dominant_drive: "dissatisfaction" },
      ] as DriveScore[]);

      const goal = makeGoal();
      const gapVector = makeGapVector();
      const result = makeResult();

      const output = await scoreDrivesAndCheckKnowledge(
        ctx,
        "goal-1",
        goal,
        gapVector,
        0,
        result,
        Date.now(),
        vi.fn()
      );

      expect(output).not.toBeNull();
      expect(output!.highDissatisfactionDimensions).toHaveLength(0);
    });
  });

  describe("2. satisficing callback iterates dimensions", () => {
    it("calls onSatisficingJudgment for each dimension based on blocking_dimensions", async () => {
      const onSatisficingJudgment = vi.fn();
      const mlm = { onSatisficingJudgment } as any;

      const ctx = makeBaseCtx({ memoryLifecycleManager: mlm });
      const goal = makeGoal(); // dim1 blocked, dim2 satisfied
      const result = makeResult(); // blocking_dimensions: ["dim1"]

      await checkCompletionAndMilestones(ctx, "goal-1", goal, result, Date.now());

      expect(onSatisficingJudgment).toHaveBeenCalledWith("goal-1", "dim1", false);
      expect(onSatisficingJudgment).toHaveBeenCalledWith("goal-1", "dim2", true);
    });

    it("does not call onSatisficingJudgment when memoryLifecycleManager is absent", async () => {
      const ctx = makeBaseCtx(); // no memoryLifecycleManager
      const goal = makeGoal();
      const result = makeResult();

      // Should not throw
      await expect(
        checkCompletionAndMilestones(ctx, "goal-1", goal, result, Date.now())
      ).resolves.toBeUndefined();
    });
  });

  describe("3. dynamic budget computed from drive scores", () => {
    it("computes maxDissatisfaction from driveScores for tier-aware selection", async () => {
      const selectForWorkingMemoryTierAware = vi.fn().mockResolvedValue({ shortTerm: [], lessons: [] });
      const mlm = {
        onSatisficingJudgment: vi.fn(),
        selectForWorkingMemoryTierAware,
      } as any;

      const ctx = makeBaseCtx({ memoryLifecycleManager: mlm });
      const goal = makeGoal();
      const gapVector = makeGapVector();
      const result = makeResult();

      const driveScores: DriveScore[] = [
        { dimension_name: "dim1", dissatisfaction: 0.85, deadline: 0, opportunity: 0, final_score: 0.85, dominant_drive: "dissatisfaction" },
        { dimension_name: "dim2", dissatisfaction: 0.1, deadline: 0, opportunity: 0, final_score: 0.1, dominant_drive: "dissatisfaction" },
      ];
      const highDissatisfactionDimensions = ["dim1"];

      await runTaskCycleWithContext(
        ctx,
        "goal-1",
        goal,
        gapVector,
        driveScores,
        highDissatisfactionDimensions,
        0,
        result,
        Date.now(),
        {
          handleCapabilityAcquisition: vi.fn().mockResolvedValue(undefined),
          incrementTransferCounter: vi.fn().mockReturnValue(1),
          tryGenerateReport: vi.fn(),
        }
      );

      expect(selectForWorkingMemoryTierAware).toHaveBeenCalled();
      const callArgs = selectForWorkingMemoryTierAware.mock.calls[0];
      // maxDissatisfaction should be 0.85 (max of drive scores)
      expect(callArgs[8]).toBeCloseTo(0.85);
    });
  });

  describe("4. full flow: drives → satisficing → memory tier adjustment", () => {
    it("threads highDissatisfactionDimensions from phase 4 through to memory selection", async () => {
      const onSatisficingJudgment = vi.fn();
      const selectForWorkingMemoryTierAware = vi.fn().mockResolvedValue({ shortTerm: [], lessons: [] });
      const mlm = { onSatisficingJudgment, selectForWorkingMemoryTierAware } as any;

      const ctx = makeBaseCtx({ memoryLifecycleManager: mlm });
      const goal = makeGoal();
      const gapVector = makeGapVector();
      const result = makeResult();

      // Phase 4: get drive scores
      const driveOutput = await scoreDrivesAndCheckKnowledge(
        ctx,
        "goal-1",
        goal,
        gapVector,
        0,
        result,
        Date.now(),
        vi.fn()
      );
      expect(driveOutput).not.toBeNull();
      const { driveScores, highDissatisfactionDimensions } = driveOutput!;

      // Phase 5: completion + satisficing callback
      await checkCompletionAndMilestones(ctx, "goal-1", goal, result, Date.now());
      expect(onSatisficingJudgment).toHaveBeenCalledWith("goal-1", "dim1", false);

      // Phase 7: tier-aware memory selection uses the extracted dims
      await runTaskCycleWithContext(
        ctx,
        "goal-1",
        goal,
        gapVector,
        driveScores,
        highDissatisfactionDimensions,
        0,
        result,
        Date.now(),
        {
          handleCapabilityAcquisition: vi.fn().mockResolvedValue(undefined),
          incrementTransferCounter: vi.fn().mockReturnValue(1),
          tryGenerateReport: vi.fn(),
        }
      );

      expect(selectForWorkingMemoryTierAware).toHaveBeenCalled();
      const callArgs = selectForWorkingMemoryTierAware.mock.calls[0];
      // highDissatisfactionDimensions (arg index 7) should contain "dim1"
      expect(callArgs[7]).toContain("dim1");
    });
  });
});
