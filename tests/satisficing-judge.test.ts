import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state-manager.js";
import { SatisficingJudge, aggregateValues } from "../src/drive/satisficing-judge.js";
import { MockEmbeddingClient } from "../src/knowledge/embedding-client.js";
import type { Goal, Dimension } from "../src/types/goal.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";

// ─── Test Fixtures ───

function makeDimension(overrides: Partial<Dimension> = {}): Dimension {
  return {
    name: "test_dim",
    label: "Test Dimension",
    current_value: 50,
    threshold: { type: "min", value: 100 },
    confidence: 0.9,
    observation_method: {
      type: "mechanical",
      source: "test",
      schedule: null,
      endpoint: null,
      confidence_tier: "mechanical",
    },
    last_updated: new Date().toISOString(),
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok",
    dimension_mapping: null,
    ...overrides,
  };
}

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;
let judge: SatisficingJudge;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  judge = new SatisficingJudge(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── isDimensionSatisfied ───

describe("isDimensionSatisfied", () => {
  describe("min threshold", () => {
    it("satisfied when current_value >= threshold", () => {
      const dim = makeDimension({
        current_value: 100,
        threshold: { type: "min", value: 100 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.is_satisfied).toBe(true);
      expect(result.dimension_name).toBe("test_dim");
    });

    it("satisfied when current_value exceeds threshold", () => {
      const dim = makeDimension({
        current_value: 150,
        threshold: { type: "min", value: 100 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.is_satisfied).toBe(true);
    });

    it("not satisfied when current_value < threshold", () => {
      const dim = makeDimension({
        current_value: 80,
        threshold: { type: "min", value: 100 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.is_satisfied).toBe(false);
    });

    it("not satisfied when current_value is null", () => {
      const dim = makeDimension({
        current_value: null,
        threshold: { type: "min", value: 100 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.is_satisfied).toBe(false);
      expect(result.effective_progress).toBe(0);
    });
  });

  describe("max threshold", () => {
    it("satisfied when current_value <= threshold", () => {
      const dim = makeDimension({
        current_value: 0.03,
        threshold: { type: "max", value: 0.05 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.is_satisfied).toBe(true);
    });

    it("satisfied when current_value equals threshold", () => {
      const dim = makeDimension({
        current_value: 0.05,
        threshold: { type: "max", value: 0.05 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.is_satisfied).toBe(true);
    });

    it("not satisfied when current_value > threshold", () => {
      const dim = makeDimension({
        current_value: 0.08,
        threshold: { type: "max", value: 0.05 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.is_satisfied).toBe(false);
    });
  });

  describe("range threshold", () => {
    const threshold = { type: "range" as const, low: 36.0, high: 37.0 };

    it("satisfied when current_value is within range", () => {
      const dim = makeDimension({ current_value: 36.5, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(true);
    });

    it("satisfied at lower bound", () => {
      const dim = makeDimension({ current_value: 36.0, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(true);
    });

    it("satisfied at upper bound", () => {
      const dim = makeDimension({ current_value: 37.0, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(true);
    });

    it("not satisfied below range", () => {
      const dim = makeDimension({ current_value: 35.5, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(false);
    });

    it("not satisfied above range", () => {
      const dim = makeDimension({ current_value: 37.5, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(false);
    });
  });

  describe("present threshold", () => {
    const threshold = { type: "present" as const };

    it("satisfied for truthy number", () => {
      const dim = makeDimension({ current_value: 1, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(true);
    });

    it("satisfied for truthy string", () => {
      const dim = makeDimension({ current_value: "yes", threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(true);
    });

    it("satisfied for true boolean", () => {
      const dim = makeDimension({ current_value: true, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(true);
    });

    it("not satisfied for 0", () => {
      const dim = makeDimension({ current_value: 0, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(false);
    });

    it("not satisfied for false", () => {
      const dim = makeDimension({ current_value: false, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(false);
    });

    it("not satisfied for empty string", () => {
      const dim = makeDimension({ current_value: "", threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(false);
    });

    it("not satisfied for null", () => {
      const dim = makeDimension({ current_value: null, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(false);
    });
  });

  describe("match threshold", () => {
    const threshold = { type: "match" as const, value: "approved" };

    it("satisfied on exact string match", () => {
      const dim = makeDimension({ current_value: "approved", threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(true);
    });

    it("not satisfied on mismatch", () => {
      const dim = makeDimension({ current_value: "pending", threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(false);
    });

    it("not satisfied for null", () => {
      const dim = makeDimension({ current_value: null, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(false);
    });
  });

  describe("confidence tiers", () => {
    it("confidence >= 0.85 → tier = high", () => {
      const dim = makeDimension({ confidence: 0.85 });
      expect(judge.isDimensionSatisfied(dim).confidence_tier).toBe("high");
    });

    it("confidence = 1.0 → tier = high", () => {
      const dim = makeDimension({ confidence: 1.0 });
      expect(judge.isDimensionSatisfied(dim).confidence_tier).toBe("high");
    });

    it("confidence = 0.70 → tier = medium", () => {
      const dim = makeDimension({ confidence: 0.70 });
      expect(judge.isDimensionSatisfied(dim).confidence_tier).toBe("medium");
    });

    it("confidence = 0.50 → tier = medium", () => {
      const dim = makeDimension({ confidence: 0.50 });
      expect(judge.isDimensionSatisfied(dim).confidence_tier).toBe("medium");
    });

    it("confidence = 0.30 → tier = low", () => {
      const dim = makeDimension({ confidence: 0.30 });
      expect(judge.isDimensionSatisfied(dim).confidence_tier).toBe("low");
    });

    it("confidence = 0.0 → tier = low", () => {
      const dim = makeDimension({ confidence: 0.0 });
      expect(judge.isDimensionSatisfied(dim).confidence_tier).toBe("low");
    });
  });

  describe("progress ceiling applied", () => {
    it("high confidence: ceiling = 1.0, no cap on perfect progress", () => {
      const dim = makeDimension({
        current_value: 100,
        threshold: { type: "min", value: 100 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.progress_ceiling).toBe(1.0);
      expect(result.effective_progress).toBe(1.0);
    });

    it("medium confidence: ceiling = 0.85 caps progress at 0.85", () => {
      const dim = makeDimension({
        current_value: 100,
        threshold: { type: "min", value: 100 },
        confidence: 0.70,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.progress_ceiling).toBe(0.85);
      expect(result.effective_progress).toBe(0.85);
    });

    it("low confidence: ceiling = 0.60 caps progress at 0.60", () => {
      const dim = makeDimension({
        current_value: 100,
        threshold: { type: "min", value: 100 },
        confidence: 0.30,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.progress_ceiling).toBe(0.60);
      expect(result.effective_progress).toBe(0.60);
    });

    it("partial progress below ceiling is not capped", () => {
      // 50/100 = 0.5 actual progress; with high confidence ceiling = 1.0, stays at 0.5
      const dim = makeDimension({
        current_value: 50,
        threshold: { type: "min", value: 100 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.effective_progress).toBeCloseTo(0.5);
    });

    it("partial progress above medium ceiling gets capped", () => {
      // 90/100 = 0.9 actual progress; medium confidence ceiling = 0.85
      const dim = makeDimension({
        current_value: 90,
        threshold: { type: "min", value: 100 },
        confidence: 0.70,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.effective_progress).toBe(0.85);
    });
  });
});

// ─── isGoalComplete ───

describe("isGoalComplete", () => {
  it("all dimensions satisfied with high confidence → complete", () => {
    const goal = makeGoal({
      dimensions: [
        makeDimension({
          name: "dim1",
          current_value: 100,
          threshold: { type: "min", value: 100 },
          confidence: 0.9,
        }),
        makeDimension({
          name: "dim2",
          current_value: 50,
          threshold: { type: "max", value: 50 },
          confidence: 0.88,
        }),
      ],
    });
    const result = judge.isGoalComplete(goal);
    expect(result.is_complete).toBe(true);
    expect(result.blocking_dimensions).toHaveLength(0);
    expect(result.low_confidence_dimensions).toHaveLength(0);
  });

  it("one dimension unsatisfied → not complete, listed in blocking_dimensions", () => {
    const goal = makeGoal({
      dimensions: [
        makeDimension({
          name: "dim1",
          current_value: 100,
          threshold: { type: "min", value: 100 },
          confidence: 0.9,
        }),
        makeDimension({
          name: "dim2",
          current_value: 40,
          threshold: { type: "min", value: 100 },
          confidence: 0.9,
        }),
      ],
    });
    const result = judge.isGoalComplete(goal);
    expect(result.is_complete).toBe(false);
    expect(result.blocking_dimensions).toContain("dim2");
    expect(result.blocking_dimensions).not.toContain("dim1");
  });

  it("all satisfied but one has low confidence → not complete, listed in low_confidence_dimensions", () => {
    const goal = makeGoal({
      dimensions: [
        makeDimension({
          name: "dim1",
          current_value: 100,
          threshold: { type: "min", value: 100 },
          confidence: 0.9,
        }),
        makeDimension({
          name: "dim2",
          current_value: 100,
          threshold: { type: "min", value: 100 },
          confidence: 0.30, // low confidence
        }),
      ],
    });
    const result = judge.isGoalComplete(goal);
    expect(result.is_complete).toBe(false);
    expect(result.blocking_dimensions).toHaveLength(0);
    expect(result.low_confidence_dimensions).toContain("dim2");
  });

  it("satisfied dimension with medium confidence (0.70) sets needs_verification_task", () => {
    const goal = makeGoal({
      dimensions: [
        makeDimension({
          name: "dim1",
          current_value: 100,
          threshold: { type: "min", value: 100 },
          confidence: 0.70, // satisfied but not high confidence
        }),
      ],
    });
    const result = judge.isGoalComplete(goal);
    // medium tier → not low, but needs verification since confidence < 0.85
    expect(result.needs_verification_task).toBe(true);
  });

  it("satisfied dimension with high confidence does not set needs_verification_task alone", () => {
    const goal = makeGoal({
      dimensions: [
        makeDimension({
          name: "dim1",
          current_value: 100,
          threshold: { type: "min", value: 100 },
          confidence: 0.9,
        }),
      ],
    });
    const result = judge.isGoalComplete(goal);
    expect(result.is_complete).toBe(true);
    expect(result.needs_verification_task).toBe(false);
  });

  it("empty dimensions → vacuously complete", () => {
    const goal = makeGoal({ dimensions: [] });
    const result = judge.isGoalComplete(goal);
    expect(result.is_complete).toBe(true);
    expect(result.blocking_dimensions).toHaveLength(0);
    expect(result.low_confidence_dimensions).toHaveLength(0);
    expect(result.needs_verification_task).toBe(false);
  });

  it("checked_at is an ISO timestamp", () => {
    const goal = makeGoal({ dimensions: [] });
    const result = judge.isGoalComplete(goal);
    expect(() => new Date(result.checked_at)).not.toThrow();
  });
});

// ─── applyProgressCeiling ───

describe("applyProgressCeiling", () => {
  it("confidence = 0.9 (high) → ceiling = 1.0, no cap", () => {
    expect(judge.applyProgressCeiling(0.95, 0.9)).toBe(0.95);
    expect(judge.applyProgressCeiling(1.0, 0.9)).toBe(1.0);
  });

  it("confidence = 0.85 (high boundary) → ceiling = 1.0, no cap", () => {
    expect(judge.applyProgressCeiling(1.0, 0.85)).toBe(1.0);
  });

  it("confidence = 0.70 (medium) → ceiling = 0.85, caps at 0.85", () => {
    expect(judge.applyProgressCeiling(0.95, 0.70)).toBe(0.85);
    expect(judge.applyProgressCeiling(1.0, 0.70)).toBe(0.85);
  });

  it("confidence = 0.50 (medium boundary) → ceiling = 0.85", () => {
    expect(judge.applyProgressCeiling(1.0, 0.50)).toBe(0.85);
  });

  it("confidence = 0.30 (low) → ceiling = 0.60, caps at 0.60", () => {
    expect(judge.applyProgressCeiling(0.95, 0.30)).toBe(0.60);
    expect(judge.applyProgressCeiling(1.0, 0.30)).toBe(0.60);
  });

  it("confidence = 0.0 (low boundary) → ceiling = 0.60", () => {
    expect(judge.applyProgressCeiling(1.0, 0.0)).toBe(0.60);
  });

  it("progress below ceiling is not changed (all tiers)", () => {
    expect(judge.applyProgressCeiling(0.50, 0.9)).toBe(0.50);   // high, below 1.0
    expect(judge.applyProgressCeiling(0.50, 0.70)).toBe(0.50);  // medium, below 0.85
    expect(judge.applyProgressCeiling(0.40, 0.30)).toBe(0.40);  // low, below 0.60
  });
});

// ─── selectDimensionsForIteration ───

describe("selectDimensionsForIteration", () => {
  it("filters out satisfied dimensions", () => {
    const dims: Dimension[] = [
      makeDimension({ name: "satisfied", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      makeDimension({ name: "unsatisfied", current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
    ];
    const driveScores = [
      { dimension_name: "satisfied", score: 0.9 },
      { dimension_name: "unsatisfied", score: 0.5 },
    ];
    const result = judge.selectDimensionsForIteration(dims, driveScores);
    expect(result).not.toContain("satisfied");
    expect(result).toContain("unsatisfied");
  });

  it("respects max_dimensions constraint", () => {
    const dims: Dimension[] = [
      makeDimension({ name: "dim1", current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      makeDimension({ name: "dim2", current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      makeDimension({ name: "dim3", current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      makeDimension({ name: "dim4", current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
    ];
    const driveScores = [
      { dimension_name: "dim1", score: 0.4 },
      { dimension_name: "dim2", score: 0.8 },
      { dimension_name: "dim3", score: 0.6 },
      { dimension_name: "dim4", score: 0.2 },
    ];
    const result = judge.selectDimensionsForIteration(dims, driveScores, { max_dimensions: 2, uncertainty_threshold: 0.50 });
    expect(result).toHaveLength(2);
  });

  it("sorts by drive score descending", () => {
    const dims: Dimension[] = [
      makeDimension({ name: "low_score", current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      makeDimension({ name: "high_score", current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
    ];
    const driveScores = [
      { dimension_name: "low_score", score: 0.2 },
      { dimension_name: "high_score", score: 0.9 },
    ];
    const result = judge.selectDimensionsForIteration(dims, driveScores, { max_dimensions: 3, uncertainty_threshold: 0.50 });
    expect(result[0]).toBe("high_score");
    expect(result[1]).toBe("low_score");
  });

  it("filters out low-confidence dimensions below uncertainty_threshold", () => {
    const dims: Dimension[] = [
      makeDimension({ name: "low_conf", current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.30 }),
      makeDimension({ name: "ok_conf", current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
    ];
    const driveScores = [
      { dimension_name: "low_conf", score: 0.9 },
      { dimension_name: "ok_conf", score: 0.5 },
    ];
    const result = judge.selectDimensionsForIteration(dims, driveScores, { max_dimensions: 3, uncertainty_threshold: 0.50 });
    expect(result).not.toContain("low_conf");
    expect(result).toContain("ok_conf");
  });

  it("defaults: max_dimensions = 3, uncertainty_threshold = 0.50", () => {
    const dims: Dimension[] = Array.from({ length: 5 }, (_, i) =>
      makeDimension({ name: `dim${i}`, current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.9 })
    );
    const driveScores = dims.map((d, i) => ({ dimension_name: d.name, score: i * 0.1 }));
    const result = judge.selectDimensionsForIteration(dims, driveScores);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("returns empty array when all dimensions are satisfied", () => {
    const dims: Dimension[] = [
      makeDimension({ name: "done", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
    ];
    const driveScores = [{ dimension_name: "done", score: 0.9 }];
    const result = judge.selectDimensionsForIteration(dims, driveScores);
    expect(result).toHaveLength(0);
  });
});

// ─── detectThresholdAdjustmentNeeded ───

describe("detectThresholdAdjustmentNeeded", () => {
  it("returns empty array when no dimensions have issues", async () => {
    const goal = makeGoal({
      dimensions: [
        makeDimension({ name: "dim1", current_value: 80, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    const failures = new Map<string, number>([["dim1", 1]]);
    const result = await judge.detectThresholdAdjustmentNeeded(goal, failures);
    expect(result).toHaveLength(0);
  });

  it("generates proposal when dimension has >= 3 failures with no progress", async () => {
    const goal = makeGoal({
      id: "goal-1",
      dimensions: [
        makeDimension({ name: "dim1", current_value: 5, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    const failures = new Map<string, number>([["dim1", 5]]);
    const proposals = await judge.detectThresholdAdjustmentNeeded(goal, failures);
    expect(proposals.length).toBeGreaterThan(0);
    const p = proposals[0];
    expect(p.dimension_name).toBe("dim1");
    expect(p.goal_id).toBe("goal-1");
    expect(p.current_threshold).toBe(100);
    expect(p.proposed_threshold).toBeLessThan(100);
    expect(p.reason).toBe("high_failure_no_progress");
  });

  it("does NOT generate failure proposal when failures < 3", async () => {
    const goal = makeGoal({
      dimensions: [
        makeDimension({ name: "dim1", current_value: 5, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    const failures = new Map<string, number>([["dim1", 2]]);
    const proposals = await judge.detectThresholdAdjustmentNeeded(goal, failures);
    expect(proposals.filter((p) => p.reason === "high_failure_no_progress")).toHaveLength(0);
  });

  it("generates bottleneck proposal when all others satisfied but one is far behind", async () => {
    const goal = makeGoal({
      id: "goal-2",
      dimensions: [
        makeDimension({ name: "done1", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
        makeDimension({ name: "done2", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
        makeDimension({ name: "bottleneck", current_value: 5, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    const failures = new Map<string, number>();
    const proposals = await judge.detectThresholdAdjustmentNeeded(goal, failures);
    const bottleneckProposals = proposals.filter((p) => p.reason === "bottleneck_dimension");
    expect(bottleneckProposals.length).toBeGreaterThan(0);
    expect(bottleneckProposals[0].dimension_name).toBe("bottleneck");
  });

  it("does not generate bottleneck proposal when other dimensions are not all satisfied", async () => {
    const goal = makeGoal({
      dimensions: [
        makeDimension({ name: "dim1", current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
        makeDimension({ name: "dim2", current_value: 5, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    const failures = new Map<string, number>();
    const proposals = await judge.detectThresholdAdjustmentNeeded(goal, failures);
    expect(proposals.filter((p) => p.reason === "bottleneck_dimension")).toHaveLength(0);
  });

  it("returns empty array for goal with no dimensions", async () => {
    const goal = makeGoal({ dimensions: [] });
    const failures = new Map<string, number>();
    const result = await judge.detectThresholdAdjustmentNeeded(goal, failures);
    expect(result).toHaveLength(0);
  });
});

// ─── propagateSubgoalCompletion ───

describe("propagateSubgoalCompletion", () => {
  it("sets parent dimension current_value to satisfied value on name match", async () => {
    const parentGoal = makeGoal({
      id: "parent-goal",
      dimensions: [
        makeDimension({
          name: "subgoal-abc",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.9,
        }),
      ],
    });
    await stateManager.saveGoal(parentGoal);

    await judge.propagateSubgoalCompletion("subgoal-abc", "parent-goal");

    const updated = await stateManager.loadGoal("parent-goal");
    expect(updated).not.toBeNull();
    const dim = updated!.dimensions.find((d) => d.name === "subgoal-abc");
    expect(dim).toBeDefined();
    // threshold is min=1; satisfied value should be 1
    expect(dim!.current_value).toBe(1);
  });

  it("sets dimension to threshold midpoint for range threshold", async () => {
    const parentGoal = makeGoal({
      id: "parent-range",
      dimensions: [
        makeDimension({
          name: "subgoal-range",
          current_value: 0,
          threshold: { type: "range", low: 36.0, high: 37.0 },
          confidence: 0.9,
        }),
      ],
    });
    await stateManager.saveGoal(parentGoal);

    await judge.propagateSubgoalCompletion("subgoal-range", "parent-range");

    const updated = await stateManager.loadGoal("parent-range");
    const dim = updated!.dimensions.find((d) => d.name === "subgoal-range");
    expect(dim!.current_value).toBeCloseTo(36.5); // (36+37)/2
  });

  it("sets dimension to true for present threshold", async () => {
    const parentGoal = makeGoal({
      id: "parent-present",
      dimensions: [
        makeDimension({
          name: "subgoal-present",
          current_value: null,
          threshold: { type: "present" },
          confidence: 0.9,
        }),
      ],
    });
    await stateManager.saveGoal(parentGoal);

    await judge.propagateSubgoalCompletion("subgoal-present", "parent-present");

    const updated = await stateManager.loadGoal("parent-present");
    const dim = updated!.dimensions.find((d) => d.name === "subgoal-present");
    expect(dim!.current_value).toBe(true);
  });

  it("does nothing when no dimension matches subgoalId", async () => {
    const parentGoal = makeGoal({
      id: "parent-no-match",
      dimensions: [
        makeDimension({ name: "other-dim", current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    await stateManager.saveGoal(parentGoal);

    // Should not throw, just no-op
    await expect(judge.propagateSubgoalCompletion("nonexistent-subgoal", "parent-no-match")
    ).resolves.not.toThrow();

    const updated = await stateManager.loadGoal("parent-no-match");
    expect(updated!.dimensions[0].current_value).toBe(50); // unchanged
  });

  it("throws when parent goal does not exist", async () => {
    await expect(judge.propagateSubgoalCompletion("subgoal-x", "nonexistent-parent")
    ).rejects.toThrow(/not found/);
  });
});

// ─── proposeDimensionMapping (Phase 2) ───

describe("proposeDimensionMapping (Phase 2)", async () => {
  it("proposes mappings when embedding client is available", async () => {
    const mockEmbedding = new MockEmbeddingClient();
    const judge2 = new SatisficingJudge(stateManager, mockEmbedding);
    const proposals = await judge2.proposeDimensionMapping(
      [{ name: "code_coverage" }, { name: "test_count" }],
      [{ name: "quality_metrics" }, { name: "documentation" }]
    );
    expect(Array.isArray(proposals)).toBe(true);
    // MockEmbeddingClient produces deterministic vectors, so specific assertions depend on hash behavior
    for (const p of proposals) {
      expect(p.similarity_score).toBeGreaterThan(0.5);
      expect(p.suggested_aggregation).toBeDefined();
      expect(p.reasoning).toBeTruthy();
    }
  });

  it("returns empty when no embedding client", async () => {
    const judge2 = new SatisficingJudge(stateManager);
    const proposals = await judge2.proposeDimensionMapping(
      [{ name: "coverage" }],
      [{ name: "quality" }]
    );
    expect(proposals).toEqual([]);
  });

  it("returns empty when subgoalDimensions is empty", async () => {
    const mockEmbedding = new MockEmbeddingClient();
    const judge2 = new SatisficingJudge(stateManager, mockEmbedding);
    const proposals = await judge2.proposeDimensionMapping([], [{ name: "quality" }]);
    expect(proposals).toEqual([]);
  });

  it("includes reasoning with dimension names and similarity score", async () => {
    const mockEmbedding = new MockEmbeddingClient();
    const judge2 = new SatisficingJudge(stateManager, mockEmbedding);
    const proposals = await judge2.proposeDimensionMapping(
      [{ name: "test_coverage" }],
      [{ name: "quality_metrics" }]
    );
    if (proposals.length > 0) {
      expect(proposals[0].reasoning).toContain("test_coverage");
      expect(proposals[0].reasoning).toContain("quality_metrics");
      expect(proposals[0].confidence).toBeLessThanOrEqual(0.9);
    }
  });
});

// ─── onSatisficingJudgment callback (Phase 2) ───

describe("onSatisficingJudgment callback (Phase 2)", () => {
  it("calls callback with satisfied dimensions when checking completion", () => {
    const calls: Array<{ goalId: string; dims: string[] }> = [];
    const judge2 = new SatisficingJudge(stateManager, undefined, (goalId, dims) => {
      calls.push({ goalId, dims });
    });

    const satisfiedGoal = makeGoal({
      id: "goal-callback-test",
      dimensions: [
        makeDimension({
          name: "done_dim",
          current_value: 100,
          threshold: { type: "min", value: 100 },
          confidence: 0.9,
        }),
      ],
    });

    judge2.isGoalComplete(satisfiedGoal);

    expect(calls).toHaveLength(1);
    expect(calls[0].goalId).toBe("goal-callback-test");
    expect(calls[0].dims).toContain("done_dim");
  });

  it("does not call callback when no dimensions are satisfied", () => {
    const calls: Array<{ goalId: string; dims: string[] }> = [];
    const judge2 = new SatisficingJudge(stateManager, undefined, (goalId, dims) => {
      calls.push({ goalId, dims });
    });

    const unsatisfiedGoal = makeGoal({
      id: "goal-unsatisfied",
      dimensions: [
        makeDimension({
          name: "not_done_dim",
          current_value: 10,
          threshold: { type: "min", value: 100 },
          confidence: 0.9,
        }),
      ],
    });

    judge2.isGoalComplete(unsatisfiedGoal);

    expect(calls).toHaveLength(0);
  });

  it("does not call callback when no callback is provided", () => {
    // Standard judge without callback — should not throw
    const goal = makeGoal({
      dimensions: [
        makeDimension({
          name: "done_dim",
          current_value: 100,
          threshold: { type: "min", value: 100 },
          confidence: 0.9,
        }),
      ],
    });
    expect(() => judge.isGoalComplete(goal)).not.toThrow();
  });

  it("calls callback for each partially satisfied goal independently", () => {
    const calls: Array<{ goalId: string; dims: string[] }> = [];
    const judge2 = new SatisficingJudge(stateManager, undefined, (goalId, dims) => {
      calls.push({ goalId, dims });
    });

    const goal1 = makeGoal({
      id: "goal-a",
      dimensions: [
        makeDimension({ name: "dim1", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
        makeDimension({ name: "dim2", current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });

    judge2.isGoalComplete(goal1);

    expect(calls).toHaveLength(1);
    expect(calls[0].goalId).toBe("goal-a");
    expect(calls[0].dims).toContain("dim1");
    expect(calls[0].dims).not.toContain("dim2");
  });
});

// ─── aggregateValues (pure function unit tests) ───

describe("aggregateValues", () => {
  it("min: returns the smallest value", () => {
    expect(aggregateValues([0.8, 0.5, 0.9], "min")).toBe(0.5);
  });

  it("min: single value returns that value", () => {
    expect(aggregateValues([0.7], "min")).toBe(0.7);
  });

  it("max: returns the largest value", () => {
    expect(aggregateValues([0.3, 0.9, 0.6], "max")).toBe(0.9);
  });

  it("max: single value returns that value", () => {
    expect(aggregateValues([0.4], "max")).toBe(0.4);
  });

  it("avg: returns the mean of values", () => {
    expect(aggregateValues([0.6, 0.8, 1.0], "avg")).toBeCloseTo(0.8);
  });

  it("avg: single value returns that value", () => {
    expect(aggregateValues([0.75], "avg")).toBeCloseTo(0.75);
  });

  it("all_required: returns minimum fulfillment ratio (all meet threshold)", () => {
    // values are fulfillment ratios; min=1.0 means all are complete
    expect(aggregateValues([1.0, 1.0, 1.0], "all_required")).toBe(1.0);
  });

  it("all_required: returns minimum when not all complete", () => {
    expect(aggregateValues([1.0, 0.7, 0.9], "all_required")).toBeCloseTo(0.7);
  });

  it("empty array returns 0 for all aggregation types", () => {
    expect(aggregateValues([], "min")).toBe(0);
    expect(aggregateValues([], "max")).toBe(0);
    expect(aggregateValues([], "avg")).toBe(0);
    expect(aggregateValues([], "all_required")).toBe(0);
  });
});

// ─── propagateSubgoalCompletion Phase 2 (dimension_mapping aggregation) ───

describe("propagateSubgoalCompletion Phase 2 — aggregation mapping", async () => {
  it("backwards compatibility: no dimension_mapping → behaves like MVP name matching", async () => {
    const parentGoal = makeGoal({
      id: "parent-compat",
      dimensions: [
        makeDimension({
          name: "feature-a",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.9,
        }),
      ],
    });
    await stateManager.saveGoal(parentGoal);

    const subgoalDims: Dimension[] = [
      makeDimension({
        name: "feature-a",
        current_value: 0.8,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: null,
      }),
    ];
    await judge.propagateSubgoalCompletion("feature-a", "parent-compat", subgoalDims);

    const updated = await stateManager.loadGoal("parent-compat");
    const dim = updated!.dimensions.find((d) => d.name === "feature-a");
    // Unmapped → name matching → sets to satisfied value (threshold=min 1 → value=1)
    expect(dim!.current_value).toBe(1);
  });

  it("min aggregation: 3 subgoal dims map to same parent dim, min value is used", async () => {
    const parentGoal = makeGoal({
      id: "parent-min",
      dimensions: [
        makeDimension({
          name: "product_readiness",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.9,
        }),
      ],
    });
    await stateManager.saveGoal(parentGoal);

    const subgoalDims: Dimension[] = [
      makeDimension({
        name: "feature_a",
        current_value: 0.8,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "product_readiness", aggregation: "min" },
      }),
      makeDimension({
        name: "feature_b",
        current_value: 0.5,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "product_readiness", aggregation: "min" },
      }),
      makeDimension({
        name: "feature_c",
        current_value: 0.9,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "product_readiness", aggregation: "min" },
      }),
    ];
    await judge.propagateSubgoalCompletion("subgoal-id", "parent-min", subgoalDims);

    const updated = await stateManager.loadGoal("parent-min");
    const dim = updated!.dimensions.find((d) => d.name === "product_readiness");
    expect(dim!.current_value).toBeCloseTo(0.5);
  });

  it("avg aggregation: 3 subgoal dims map to same parent dim, average is used", async () => {
    const parentGoal = makeGoal({
      id: "parent-avg",
      dimensions: [
        makeDimension({
          name: "overall_score",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.9,
        }),
      ],
    });
    await stateManager.saveGoal(parentGoal);

    const subgoalDims: Dimension[] = [
      makeDimension({
        name: "score_a",
        current_value: 0.6,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "overall_score", aggregation: "avg" },
      }),
      makeDimension({
        name: "score_b",
        current_value: 0.8,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "overall_score", aggregation: "avg" },
      }),
      makeDimension({
        name: "score_c",
        current_value: 1.0,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "overall_score", aggregation: "avg" },
      }),
    ];
    await judge.propagateSubgoalCompletion("subgoal-id", "parent-avg", subgoalDims);

    const updated = await stateManager.loadGoal("parent-avg");
    const dim = updated!.dimensions.find((d) => d.name === "overall_score");
    // avg(0.6, 0.8, 1.0) = 0.8
    expect(dim!.current_value).toBeCloseTo(0.8);
  });

  it("max aggregation: 3 subgoal dims map to same parent dim, max value is used", async () => {
    const parentGoal = makeGoal({
      id: "parent-max",
      dimensions: [
        makeDimension({
          name: "best_effort",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.9,
        }),
      ],
    });
    await stateManager.saveGoal(parentGoal);

    const subgoalDims: Dimension[] = [
      makeDimension({
        name: "attempt_a",
        current_value: 0.3,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "best_effort", aggregation: "max" },
      }),
      makeDimension({
        name: "attempt_b",
        current_value: 0.9,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "best_effort", aggregation: "max" },
      }),
      makeDimension({
        name: "attempt_c",
        current_value: 0.6,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "best_effort", aggregation: "max" },
      }),
    ];
    await judge.propagateSubgoalCompletion("subgoal-id", "parent-max", subgoalDims);

    const updated = await stateManager.loadGoal("parent-max");
    const dim = updated!.dimensions.find((d) => d.name === "best_effort");
    expect(dim!.current_value).toBeCloseTo(0.9);
  });

  it("all_required: all subgoal dims meet threshold → parent gets min fulfillment ratio = 1.0", async () => {
    const parentGoal = makeGoal({
      id: "parent-allreq-complete",
      dimensions: [
        makeDimension({
          name: "release_gate",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.9,
        }),
      ],
    });
    await stateManager.saveGoal(parentGoal);

    const subgoalDims: Dimension[] = [
      makeDimension({
        name: "tests_pass",
        current_value: 1.0,
        threshold: { type: "min", value: 1.0 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "release_gate", aggregation: "all_required" },
      }),
      makeDimension({
        name: "docs_done",
        current_value: 1.0,
        threshold: { type: "min", value: 1.0 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "release_gate", aggregation: "all_required" },
      }),
    ];
    await judge.propagateSubgoalCompletion("subgoal-id", "parent-allreq-complete", subgoalDims);

    const updated = await stateManager.loadGoal("parent-allreq-complete");
    const dim = updated!.dimensions.find((d) => d.name === "release_gate");
    // Both fully satisfied → fulfillment ratios = [1.0, 1.0] → min = 1.0
    expect(dim!.current_value).toBeCloseTo(1.0);
  });

  it("all_required partial: not all dims meet threshold → parent current_value reflects min ratio", async () => {
    const parentGoal = makeGoal({
      id: "parent-allreq-partial",
      dimensions: [
        makeDimension({
          name: "release_gate",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.9,
        }),
      ],
    });
    await stateManager.saveGoal(parentGoal);

    const subgoalDims: Dimension[] = [
      makeDimension({
        name: "tests_pass",
        current_value: 1.0,
        threshold: { type: "min", value: 1.0 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "release_gate", aggregation: "all_required" },
      }),
      makeDimension({
        name: "docs_done",
        current_value: 0.5,
        threshold: { type: "min", value: 1.0 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "release_gate", aggregation: "all_required" },
      }),
    ];
    await judge.propagateSubgoalCompletion("subgoal-id", "parent-allreq-partial", subgoalDims);

    const updated = await stateManager.loadGoal("parent-allreq-partial");
    const dim = updated!.dimensions.find((d) => d.name === "release_gate");
    // docs_done progress = 0.5/1.0 = 0.5 → min(1.0, 0.5) = 0.5 → parent not complete
    expect(dim!.current_value).toBeCloseTo(0.5);
    // Confirm parent dimension is not satisfied (0.5 < threshold 1)
    expect(judge.isDimensionSatisfied(dim!).is_satisfied).toBe(false);
  });

  it("mixed mapping: mapped dims use aggregation, unmapped dims use name matching", async () => {
    const parentGoal = makeGoal({
      id: "parent-mixed",
      dimensions: [
        makeDimension({
          name: "product_readiness",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.9,
        }),
        makeDimension({
          name: "feature_x",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.9,
        }),
      ],
    });
    await stateManager.saveGoal(parentGoal);

    const subgoalDims: Dimension[] = [
      // mapped: goes to product_readiness via aggregation
      makeDimension({
        name: "feature_a",
        current_value: 0.7,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "product_readiness", aggregation: "min" },
      }),
      makeDimension({
        name: "feature_b",
        current_value: 0.9,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "product_readiness", aggregation: "min" },
      }),
      // unmapped: name matching → matches "feature_x" in parent
      makeDimension({
        name: "feature_x",
        current_value: 0.5,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: null,
      }),
    ];
    await judge.propagateSubgoalCompletion("subgoal-id", "parent-mixed", subgoalDims);

    const updated = await stateManager.loadGoal("parent-mixed");
    const readinessDim = updated!.dimensions.find((d) => d.name === "product_readiness");
    const featureXDim = updated!.dimensions.find((d) => d.name === "feature_x");

    // mapped: min(0.7, 0.9) = 0.7
    expect(readinessDim!.current_value).toBeCloseTo(0.7);
    // unmapped: name matched → satisfied value = threshold = 1
    expect(featureXDim!.current_value).toBe(1);
  });

  it("empty subgoalDimensions array → no updates made", async () => {
    const parentGoal = makeGoal({
      id: "parent-empty-dims",
      dimensions: [
        makeDimension({
          name: "some_dim",
          current_value: 42,
          threshold: { type: "min", value: 100 },
          confidence: 0.9,
        }),
      ],
    });
    await stateManager.saveGoal(parentGoal);

    await judge.propagateSubgoalCompletion("subgoal-id", "parent-empty-dims", []);

    const updated = await stateManager.loadGoal("parent-empty-dims");
    // With empty array it falls through to MVP name matching; no name match → no update
    expect(updated!.dimensions[0]!.current_value).toBe(42);
  });

  it("non-numeric current_value in avg mode: skips that dimension gracefully", async () => {
    const parentGoal = makeGoal({
      id: "parent-nonnumeric",
      dimensions: [
        makeDimension({
          name: "overall",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.9,
        }),
      ],
    });
    await stateManager.saveGoal(parentGoal);

    const subgoalDims: Dimension[] = [
      makeDimension({
        name: "numeric_dim",
        current_value: 0.6,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "overall", aggregation: "avg" },
      }),
      makeDimension({
        name: "string_dim",
        current_value: "not-a-number",
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "overall", aggregation: "avg" },
      }),
      makeDimension({
        name: "another_numeric",
        current_value: 0.8,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "overall", aggregation: "avg" },
      }),
    ];
    // Should not throw; non-numeric string is skipped
    await expect(judge.propagateSubgoalCompletion("subgoal-id", "parent-nonnumeric", subgoalDims)
    ).resolves.not.toThrow();

    const updated = await stateManager.loadGoal("parent-nonnumeric");
    const dim = updated!.dimensions.find((d) => d.name === "overall");
    // avg of [0.6, 0.8] (skipping "not-a-number") = 0.7
    expect(dim!.current_value).toBeCloseTo(0.7);
  });

  it("multiple parent dimensions: different subgoal dims map to different parent dims", async () => {
    const parentGoal = makeGoal({
      id: "parent-multiparent",
      dimensions: [
        makeDimension({
          name: "dim_alpha",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.9,
        }),
        makeDimension({
          name: "dim_beta",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.9,
        }),
      ],
    });
    await stateManager.saveGoal(parentGoal);

    const subgoalDims: Dimension[] = [
      makeDimension({
        name: "sub_a1",
        current_value: 0.7,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "dim_alpha", aggregation: "max" },
      }),
      makeDimension({
        name: "sub_a2",
        current_value: 0.9,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "dim_alpha", aggregation: "max" },
      }),
      makeDimension({
        name: "sub_b1",
        current_value: 0.4,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "dim_beta", aggregation: "min" },
      }),
      makeDimension({
        name: "sub_b2",
        current_value: 0.6,
        threshold: { type: "min", value: 1 },
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "dim_beta", aggregation: "min" },
      }),
    ];
    await judge.propagateSubgoalCompletion("subgoal-id", "parent-multiparent", subgoalDims);

    const updated = await stateManager.loadGoal("parent-multiparent");
    const alpha = updated!.dimensions.find((d) => d.name === "dim_alpha");
    const beta = updated!.dimensions.find((d) => d.name === "dim_beta");

    // max(0.7, 0.9) = 0.9
    expect(alpha!.current_value).toBeCloseTo(0.9);
    // min(0.4, 0.6) = 0.4
    expect(beta!.current_value).toBeCloseTo(0.4);
  });

  it("MVP path still works: propagation without subgoalDimensions argument uses name matching", async () => {
    const parentGoal = makeGoal({
      id: "parent-mvp-path",
      dimensions: [
        makeDimension({
          name: "subgoal-mvp",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.9,
        }),
      ],
    });
    await stateManager.saveGoal(parentGoal);

    // Called without subgoalDimensions — uses original MVP signature
    await judge.propagateSubgoalCompletion("subgoal-mvp", "parent-mvp-path");

    const updated = await stateManager.loadGoal("parent-mvp-path");
    const dim = updated!.dimensions.find((d) => d.name === "subgoal-mvp");
    expect(dim!.current_value).toBe(1);
  });
});
