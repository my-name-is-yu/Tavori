import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { SatisficingJudge } from "../src/drive/satisficing-judge.js";
import type { Dimension } from "../src/types/goal.js";
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

// ─── isGoalComplete ───

describe("isGoalComplete", () => {
  it("all dimensions satisfied with high confidence → complete (requires 2 consecutive cycles)", () => {
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
    // First cycle: not yet complete (streak = 1)
    const first = judge.isGoalComplete(goal);
    expect(first.is_complete).toBe(false);
    // Second cycle: complete (streak = 2)
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
    // First cycle: not yet complete
    judge.isGoalComplete(goal);
    // Second cycle: complete, no verification needed
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

  it("converged_satisficed status treats unsatisfied dimension as complete", () => {
    // Dimension has current_value=85 vs threshold=100 → isSatisfiedRaw returns false
    // But convergence status says converged_satisficed → should be treated as satisfied
    const goal = makeGoal({
      id: "goal-cs-1",
      dimensions: [
        makeDimension({
          name: "test_dim",
          current_value: 85,
          threshold: { type: "min", value: 100 },
          confidence: 0.9,
        }),
      ],
    });
    // Without convergence statuses → not complete
    const withoutConvergence = judge.isGoalComplete(goal);
    expect(withoutConvergence.is_complete).toBe(false);
    expect(withoutConvergence.blocking_dimensions).toContain("test_dim");

    // With converged_satisficed status → complete after 2 consecutive cycles
    const convergenceStatuses = new Map([["goal-cs-1:test_dim", "converged_satisficed" as const]]);
    // First cycle with converged status: streak = 1, not yet complete
    judge.isGoalComplete(goal, convergenceStatuses);
    // Second cycle: complete
    const withConvergence = judge.isGoalComplete(goal, convergenceStatuses);
    expect(withConvergence.is_complete).toBe(true);
    expect(withConvergence.blocking_dimensions).toHaveLength(0);
  });

  it("converged_satisficed only applies to matching dimension key, not others", () => {
    const goal = makeGoal({
      id: "goal-cs-2",
      dimensions: [
        makeDimension({
          name: "dim1",
          current_value: 85,
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
    // Only dim1 has converged_satisficed
    const convergenceStatuses = new Map([["goal-cs-2:dim1", "converged_satisficed" as const]]);
    const result = judge.isGoalComplete(goal, convergenceStatuses);
    expect(result.is_complete).toBe(false);
    expect(result.blocking_dimensions).toContain("dim2");
    expect(result.blocking_dimensions).not.toContain("dim1");
  });

  it("other convergence statuses (stalled, in_progress) do not override unsatisfied", () => {
    const goal = makeGoal({
      id: "goal-cs-3",
      dimensions: [
        makeDimension({
          name: "dim1",
          current_value: 40,
          threshold: { type: "min", value: 100 },
          confidence: 0.9,
        }),
      ],
    });
    const stalledStatuses = new Map([["goal-cs-3:dim1", "stalled" as const]]);
    const result = judge.isGoalComplete(goal, stalledStatuses);
    expect(result.is_complete).toBe(false);
    expect(result.blocking_dimensions).toContain("dim1");

    const inProgressStatuses = new Map([["goal-cs-3:dim1", "in_progress" as const]]);
    const result2 = judge.isGoalComplete(goal, inProgressStatuses);
    expect(result2.is_complete).toBe(false);
  });

  it("converged_satisficed with low confidence dimension still results in goal completion", () => {
    // Dimension has confidence < 0.5 → confidence_tier is "low"
    // Without convergence it would block completion via low_confidence_dimensions
    // With converged_satisficed the convergence itself IS the statistical evidence
    const goal = makeGoal({
      id: "goal-cs-low-conf",
      dimensions: [
        makeDimension({
          name: "test_dim",
          current_value: 85,
          threshold: { type: "min", value: 100 },
          confidence: 0.3, // low confidence → confidence_tier "low"
        }),
      ],
    });
    const convergenceStatuses = new Map([["goal-cs-low-conf:test_dim", "converged_satisficed" as const]]);
    // First cycle: streak = 1, not yet complete
    judge.isGoalComplete(goal, convergenceStatuses);
    // Second cycle: complete
    const result = judge.isGoalComplete(goal, convergenceStatuses);
    expect(result.is_complete).toBe(true);
    expect(result.blocking_dimensions).toHaveLength(0);
    expect(result.low_confidence_dimensions).toHaveLength(0);
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
