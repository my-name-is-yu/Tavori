/**
 * core-loop-phases-gap-refresh.test.ts
 *
 * Tests that calculateGapOrComplete() persists refreshed dimension values
 * (via stateManager.saveGoal) after measureDirectly() updates them in-memory.
 * Regression guard for issue #473.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { calculateGapOrComplete } from "../core-loop-phases.js";
import type { PhaseCtx } from "../core-loop-phases.js";
import type { LoopIterationResult } from "../core-loop-types.js";
import type { Goal } from "../../../base/types/goal.js";

// ─── Mocks ───

vi.mock("../../../platform/drive/gap-calculator-tools.js", () => ({
  needsDirectMeasurement: vi.fn(),
  measureDirectly: vi.fn(),
}));

// ─── Helpers ───

function makeStaleDimension() {
  return {
    name: "coverage",
    threshold: { type: "min" as const, value: 80 },
    current_value: 50,
    confidence: 0.3, // below 0.6 staleness threshold
    weight: 1.0,
    last_updated: new Date().toISOString(),
    observation_method: { type: "mechanical" as const, endpoint: "npx vitest run --coverage" },
  };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    title: "Test goal",
    description: "Test",
    dimensions: [makeStaleDimension()],
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

function makeResult(): LoopIterationResult {
  return {
    loopIndex: 0,
    goalId: "goal-1",
    gapAggregate: 0,
    driveScores: [],
    taskResult: null,
    stallDetected: false,
    stallReport: null,
    pivotOccurred: false,
    completionJudgment: null,
    elapsedMs: 0,
    error: null,
  };
}

function makePhaseCtx(stateManagerOverrides: Record<string, unknown> = {}): PhaseCtx {
  const gapCalculator = {
    calculateGapVector: vi.fn().mockReturnValue({
      goal_id: "goal-1",
      gaps: [
        {
          dimension_name: "coverage",
          raw_gap: 30,
          normalized_gap: 0.375,
          normalized_weighted_gap: 0.375,
          confidence: 0.9,
          uncertainty_weight: 1.0,
        },
      ],
      timestamp: new Date().toISOString(),
    }),
    aggregateGaps: vi.fn().mockReturnValue(0.375),
  };

  const stateManager = {
    loadGoal: vi.fn().mockResolvedValue(null),
    saveGoal: vi.fn().mockResolvedValue(undefined),
    appendGapHistoryEntry: vi.fn().mockResolvedValue(undefined),
    loadGapHistory: vi.fn().mockResolvedValue([]),
    ...stateManagerOverrides,
  };

  const satisficingJudge = {
    isGoalComplete: vi.fn().mockReturnValue({
      is_complete: false,
      blocking_dimensions: ["coverage"],
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

  const toolExecutor = {
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: "75",
      error: null,
      exit_code: 0,
      elapsed_ms: 50,
      stopped_reason: "completed",
    }),
  };

  return {
    deps: {
      gapCalculator,
      stateManager,
      satisficingJudge,
    } as unknown as PhaseCtx["deps"],
    config: {} as unknown as PhaseCtx["config"],
    logger: undefined,
    toolExecutor: toolExecutor as unknown as PhaseCtx["toolExecutor"],
  };
}

// ─── Tests ───

describe("calculateGapOrComplete — dimension refresh persistence", () => {
  beforeEach(async () => {
    const tools = await import("../../../platform/drive/gap-calculator-tools.js");
    vi.mocked(tools.needsDirectMeasurement).mockReturnValue(true);
    vi.mocked(tools.measureDirectly).mockResolvedValue({
      value: 75,
      confidence: 0.95,
      measuredAt: new Date(),
      toolUsed: "shell",
    });
  });

  it("calls saveGoal after measureDirectly refreshes a stale dimension", async () => {
    const ctx = makePhaseCtx();
    const goal = makeGoal();
    const result = makeResult();

    await calculateGapOrComplete(ctx, "goal-1", goal, 0, result, Date.now());

    expect(ctx.deps.stateManager.saveGoal).toHaveBeenCalledTimes(1);
    expect(ctx.deps.stateManager.saveGoal).toHaveBeenCalledWith(goal);
  });

  it("persists the updated dimension values (current_value and confidence) to state", async () => {
    const ctx = makePhaseCtx();
    const goal = makeGoal();
    const result = makeResult();

    await calculateGapOrComplete(ctx, "goal-1", goal, 0, result, Date.now());

    // The goal passed to saveGoal should have the refreshed dimension values
    const savedGoal = (ctx.deps.stateManager.saveGoal as ReturnType<typeof vi.fn>).mock.calls[0][0] as Goal;
    const dim = savedGoal.dimensions![0];
    expect(dim.current_value).toBe(75);
    expect(dim.confidence).toBe(0.95);
  });

  it("does not call saveGoal when no toolExecutor is provided", async () => {
    const ctx = makePhaseCtx();
    ctx.toolExecutor = undefined;
    const goal = makeGoal();
    const result = makeResult();

    await calculateGapOrComplete(ctx, "goal-1", goal, 0, result, Date.now());

    expect(ctx.deps.stateManager.saveGoal).not.toHaveBeenCalled();
  });

  it("does not call saveGoal when measureDirectly returns null for all dimensions", async () => {
    const tools = await import("../../../platform/drive/gap-calculator-tools.js");
    vi.mocked(tools.measureDirectly).mockResolvedValue(null);

    const ctx = makePhaseCtx();
    const goal = makeGoal();
    const result = makeResult();

    await calculateGapOrComplete(ctx, "goal-1", goal, 0, result, Date.now());

    // saveGoal is NOT called because no dimension was actually refreshed (anyRefreshed=false).
    expect(ctx.deps.stateManager.saveGoal).not.toHaveBeenCalled();
  });
});

describe("calculateGapOrComplete — parallel dimension measurement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("measures multiple stale dimensions concurrently via Promise.all", async () => {
    const tools = await import("../../../platform/drive/gap-calculator-tools.js");
    vi.mocked(tools.needsDirectMeasurement).mockReturnValue(true);

    const callOrder: number[] = [];
    vi.mocked(tools.measureDirectly).mockImplementation(async (dim) => {
      callOrder.push(Date.now());
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      return { value: 75, confidence: 0.95, measuredAt: new Date(), toolUsed: "shell" };
    });

    const dim1 = { ...makeStaleDimension(), name: "coverage" };
    const dim2 = { ...makeStaleDimension(), name: "lint" };
    const goal = makeGoal({ dimensions: [dim1, dim2] });
    const ctx = makePhaseCtx();
    const result = makeResult();

    await calculateGapOrComplete(ctx, "goal-1", goal, 0, result, Date.now());

    // Both dimensions must have been measured
    expect(tools.measureDirectly).toHaveBeenCalledTimes(2);
    // Both must have updated values
    expect(goal.dimensions![0].current_value).toBe(75);
    expect(goal.dimensions![1].current_value).toBe(75);
    // saveGoal called once (after all measurements complete)
    expect(ctx.deps.stateManager.saveGoal).toHaveBeenCalledTimes(1);
  });

  it("still refreshes other dimensions when one measurement fails", async () => {
    const tools = await import("../../../platform/drive/gap-calculator-tools.js");
    vi.mocked(tools.needsDirectMeasurement).mockReturnValue(true);

    let callCount = 0;
    vi.mocked(tools.measureDirectly).mockImplementation(async (dim) => {
      callCount++;
      if (callCount === 1) throw new Error("tool error");
      return { value: 90, confidence: 0.98, measuredAt: new Date(), toolUsed: "shell" };
    });

    const dim1 = { ...makeStaleDimension(), name: "failing-dim" };
    const dim2 = { ...makeStaleDimension(), name: "passing-dim" };
    const goal = makeGoal({ dimensions: [dim1, dim2] });
    const ctx = makePhaseCtx();
    const result = makeResult();

    await calculateGapOrComplete(ctx, "goal-1", goal, 0, result, Date.now());

    // Only the second dimension should have been refreshed
    expect(goal.dimensions![0].current_value).toBe(50); // unchanged (original stale value)
    expect(goal.dimensions![1].current_value).toBe(90); // refreshed
    // saveGoal still called because anyRefreshed=true from second dim
    expect(ctx.deps.stateManager.saveGoal).toHaveBeenCalledTimes(1);
  });
});
