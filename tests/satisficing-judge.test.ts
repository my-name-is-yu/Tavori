import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";
import { SatisficingJudge } from "../src/satisficing-judge.js";
import type { Goal, Dimension } from "../src/types/goal.js";

// ─── Test Fixtures ───

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-satisficing-test-"));
}

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
    ...overrides,
  };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    parent_id: null,
    node_type: "goal",
    title: "Test Goal",
    description: "",
    status: "active",
    dimensions: [makeDimension()],
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
    created_at: now,
    updated_at: now,
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
  it("returns empty array when no dimensions have issues", () => {
    const goal = makeGoal({
      dimensions: [
        makeDimension({ name: "dim1", current_value: 80, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    const failures = new Map<string, number>([["dim1", 1]]);
    const result = judge.detectThresholdAdjustmentNeeded(goal, failures);
    expect(result).toHaveLength(0);
  });

  it("generates proposal when dimension has >= 3 failures with no progress", () => {
    const goal = makeGoal({
      id: "goal-1",
      dimensions: [
        makeDimension({ name: "dim1", current_value: 5, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    const failures = new Map<string, number>([["dim1", 5]]);
    const proposals = judge.detectThresholdAdjustmentNeeded(goal, failures);
    expect(proposals.length).toBeGreaterThan(0);
    const p = proposals[0];
    expect(p.dimension_name).toBe("dim1");
    expect(p.goal_id).toBe("goal-1");
    expect(p.current_threshold).toBe(100);
    expect(p.proposed_threshold).toBeLessThan(100);
    expect(p.reason).toBe("high_failure_no_progress");
  });

  it("does NOT generate failure proposal when failures < 3", () => {
    const goal = makeGoal({
      dimensions: [
        makeDimension({ name: "dim1", current_value: 5, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    const failures = new Map<string, number>([["dim1", 2]]);
    const proposals = judge.detectThresholdAdjustmentNeeded(goal, failures);
    expect(proposals.filter((p) => p.reason === "high_failure_no_progress")).toHaveLength(0);
  });

  it("generates bottleneck proposal when all others satisfied but one is far behind", () => {
    const goal = makeGoal({
      id: "goal-2",
      dimensions: [
        makeDimension({ name: "done1", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
        makeDimension({ name: "done2", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
        makeDimension({ name: "bottleneck", current_value: 5, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    const failures = new Map<string, number>();
    const proposals = judge.detectThresholdAdjustmentNeeded(goal, failures);
    const bottleneckProposals = proposals.filter((p) => p.reason === "bottleneck_dimension");
    expect(bottleneckProposals.length).toBeGreaterThan(0);
    expect(bottleneckProposals[0].dimension_name).toBe("bottleneck");
  });

  it("does not generate bottleneck proposal when other dimensions are not all satisfied", () => {
    const goal = makeGoal({
      dimensions: [
        makeDimension({ name: "dim1", current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
        makeDimension({ name: "dim2", current_value: 5, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    const failures = new Map<string, number>();
    const proposals = judge.detectThresholdAdjustmentNeeded(goal, failures);
    expect(proposals.filter((p) => p.reason === "bottleneck_dimension")).toHaveLength(0);
  });

  it("returns empty array for goal with no dimensions", () => {
    const goal = makeGoal({ dimensions: [] });
    const failures = new Map<string, number>();
    const result = judge.detectThresholdAdjustmentNeeded(goal, failures);
    expect(result).toHaveLength(0);
  });
});

// ─── propagateSubgoalCompletion ───

describe("propagateSubgoalCompletion", () => {
  it("sets parent dimension current_value to satisfied value on name match", () => {
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
    stateManager.saveGoal(parentGoal);

    judge.propagateSubgoalCompletion("subgoal-abc", "parent-goal");

    const updated = stateManager.loadGoal("parent-goal");
    expect(updated).not.toBeNull();
    const dim = updated!.dimensions.find((d) => d.name === "subgoal-abc");
    expect(dim).toBeDefined();
    // threshold is min=1; satisfied value should be 1
    expect(dim!.current_value).toBe(1);
  });

  it("sets dimension to threshold midpoint for range threshold", () => {
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
    stateManager.saveGoal(parentGoal);

    judge.propagateSubgoalCompletion("subgoal-range", "parent-range");

    const updated = stateManager.loadGoal("parent-range");
    const dim = updated!.dimensions.find((d) => d.name === "subgoal-range");
    expect(dim!.current_value).toBeCloseTo(36.5); // (36+37)/2
  });

  it("sets dimension to true for present threshold", () => {
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
    stateManager.saveGoal(parentGoal);

    judge.propagateSubgoalCompletion("subgoal-present", "parent-present");

    const updated = stateManager.loadGoal("parent-present");
    const dim = updated!.dimensions.find((d) => d.name === "subgoal-present");
    expect(dim!.current_value).toBe(true);
  });

  it("does nothing when no dimension matches subgoalId", () => {
    const parentGoal = makeGoal({
      id: "parent-no-match",
      dimensions: [
        makeDimension({ name: "other-dim", current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    stateManager.saveGoal(parentGoal);

    // Should not throw, just no-op
    expect(() =>
      judge.propagateSubgoalCompletion("nonexistent-subgoal", "parent-no-match")
    ).not.toThrow();

    const updated = stateManager.loadGoal("parent-no-match");
    expect(updated!.dimensions[0].current_value).toBe(50); // unchanged
  });

  it("throws when parent goal does not exist", () => {
    expect(() =>
      judge.propagateSubgoalCompletion("subgoal-x", "nonexistent-parent")
    ).toThrow(/not found/);
  });
});
