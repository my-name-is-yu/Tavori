import { describe, it, expect } from "vitest";
import {
  estimateDifficulty,
  curriculumSort,
  MEDIUM_BAND,
  NEAR_COMPLETE_GAP_THRESHOLD,
} from "../src/goal/subgoal-curriculum.js";
import { makeGoal, makeDimension } from "./helpers/fixtures.js";

// ─── estimateDifficulty ───

describe("estimateDifficulty", () => {
  it("returns 0.5 when dimensions is empty", () => {
    const goal = makeGoal({ dimensions: [] });
    expect(estimateDifficulty(goal)).toBe(0.5);
  });

  it("returns gap * (1 - confidence) when current_value is null", () => {
    // current_value=null → normalized_gap=1.0; confidence=0.5
    // difficulty = 1.0 * (1 - 0.5) = 0.5
    const goal = makeGoal({
      dimensions: [
        makeDimension({
          current_value: null,
          threshold: { type: "min", value: 10 },
          confidence: 0.5,
          weight: 1.0,
        }),
      ],
    });
    expect(estimateDifficulty(goal)).toBe(0.5);
  });

  it("returns 0.5 when gap is 0 (near-complete guard applies)", () => {
    // min threshold: current_value >= threshold → normalized_gap=0
    // aggregatedGap=0 < NEAR_COMPLETE_GAP_THRESHOLD(0.1) → near-complete guard → 0.5
    const goal = makeGoal({
      dimensions: [
        makeDimension({
          current_value: 10,
          threshold: { type: "min", value: 10 },
          confidence: 0.8,
          weight: 1.0,
        }),
      ],
    });
    expect(estimateDifficulty(goal)).toBe(0.5);
  });

  it("returns 1.0 when gap is full and confidence is 0", () => {
    // current_value=null → normalized_gap=1.0; confidence=0
    // difficulty = 1.0 * (1 - 0) = 1.0
    const goal = makeGoal({
      dimensions: [
        makeDimension({
          current_value: null,
          threshold: { type: "min", value: 10 },
          confidence: 0,
          weight: 1.0,
        }),
      ],
    });
    expect(estimateDifficulty(goal)).toBe(1.0);
  });

  it("returns gap * (1 - confidence) for a partial gap", () => {
    // min threshold=10, current_value=5 → raw_gap=5, normalized=0.5; confidence=0.5
    // difficulty = 0.5 * (1 - 0.5) = 0.25
    const goal = makeGoal({
      dimensions: [
        makeDimension({
          current_value: 5,
          threshold: { type: "min", value: 10 },
          confidence: 0.5,
          weight: 1.0,
        }),
      ],
    });
    expect(estimateDifficulty(goal)).toBeCloseTo(0.25);
  });

  it("uses max gap when gap_aggregation is 'max'", () => {
    // dim1: min threshold=10, current=9 → normalized_gap=0.1; confidence=0.5
    // dim2: current_value=null → normalized_gap=1.0; confidence=0.5
    // max gap = 1.0; min confidence = 0.5 → difficulty = 1.0 * (1-0.5) = 0.5
    const goal = makeGoal({
      gap_aggregation: "max",
      dimensions: [
        makeDimension({
          name: "dim1",
          current_value: 9,
          threshold: { type: "min", value: 10 },
          confidence: 0.5,
          weight: 1.0,
        }),
        makeDimension({
          name: "dim2",
          current_value: null,
          threshold: { type: "min", value: 10 },
          confidence: 0.5,
          weight: 1.0,
        }),
      ],
    });
    expect(estimateDifficulty(goal)).toBeCloseTo(0.5);
  });

  it("uses weighted average when gap_aggregation is 'weighted_avg'", () => {
    // dim1: gap=0.0 (current=10, threshold min:10), weight=1 → normalized_gap=0
    // dim2: gap=1.0 (current=null), weight=1 → normalized_gap=1.0
    // weighted_avg = (0*1 + 1*1) / 2 = 0.5
    // min confidence = 0.5 → difficulty = 0.5 * (1 - 0.5) = 0.25
    const goal = makeGoal({
      gap_aggregation: "weighted_avg",
      dimensions: [
        makeDimension({
          name: "dim1",
          current_value: 10,
          threshold: { type: "min", value: 10 },
          confidence: 0.5,
          weight: 1.0,
        }),
        makeDimension({
          name: "dim2",
          current_value: null,
          threshold: { type: "min", value: 10 },
          confidence: 0.5,
          weight: 1.0,
        }),
      ],
    });
    expect(estimateDifficulty(goal)).toBeCloseTo(0.25);
  });

  it("returns 0.5 for near-complete goal (aggregatedGap < NEAR_COMPLETE_GAP_THRESHOLD)", () => {
    // Small gap: min threshold=10, current=9.5 → raw_gap=0.5, normalized=0.05
    // aggregatedGap=0.05 < NEAR_COMPLETE_GAP_THRESHOLD(0.1) → near-complete guard → 0.5
    const goal = makeGoal({
      dimensions: [
        makeDimension({
          current_value: 9.5,
          threshold: { type: "min", value: 10 },
          confidence: 0.9,
          weight: 1.0,
        }),
      ],
    });
    expect(estimateDifficulty(goal)).toBe(0.5);
  });

  it("clamps result to [0, 1]", () => {
    // Sanity: result should never exceed 1
    const goal = makeGoal({
      dimensions: [
        makeDimension({
          current_value: null,
          threshold: { type: "min", value: 10 },
          confidence: 0,
          weight: 1.0,
        }),
      ],
    });
    const result = estimateDifficulty(goal);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});

// ─── curriculumSort ───

describe("curriculumSort", () => {
  it("sorts entries by |difficulty - 0.5| ascending (closest to medium first)", () => {
    const entries = [
      { id: "a", depth: 1, difficulty: 0.1 },
      { id: "b", depth: 1, difficulty: 0.5 },
      { id: "c", depth: 1, difficulty: 0.9 },
      { id: "d", depth: 1, difficulty: 0.4 },
    ];
    curriculumSort(entries);
    // distances: a=0.4, b=0.0, c=0.4, d=0.1
    // expected order: b(0.0), d(0.1), a or c (0.4)
    expect(entries[0].id).toBe("b");
    expect(entries[1].id).toBe("d");
    // a and c both have distance 0.4 — order among them by depth tiebreaker (same depth here)
    expect(["a", "c"]).toContain(entries[2].id);
    expect(["a", "c"]).toContain(entries[3].id);
  });

  it("uses depth descending as tiebreaker for equal distance", () => {
    const entries = [
      { id: "shallow", depth: 1, difficulty: 0.5 },
      { id: "deep", depth: 3, difficulty: 0.5 },
      { id: "mid", depth: 2, difficulty: 0.5 },
    ];
    curriculumSort(entries);
    // All same difficulty (distance=0), sort by depth descending
    expect(entries[0].id).toBe("deep");
    expect(entries[1].id).toBe("mid");
    expect(entries[2].id).toBe("shallow");
  });

  it("sorts by depth descending when all difficulties are the same", () => {
    const entries = [
      { id: "a", depth: 5, difficulty: 0.3 },
      { id: "b", depth: 1, difficulty: 0.3 },
      { id: "c", depth: 3, difficulty: 0.3 },
    ];
    curriculumSort(entries);
    expect(entries[0].id).toBe("a");
    expect(entries[1].id).toBe("c");
    expect(entries[2].id).toBe("b");
  });

  it("handles empty array without error", () => {
    const entries: Array<{ id: string; depth: number; difficulty: number }> = [];
    expect(() => curriculumSort(entries)).not.toThrow();
    expect(entries).toHaveLength(0);
  });

  it("leaves a single-entry array unchanged", () => {
    const entries = [{ id: "only", depth: 2, difficulty: 0.6 }];
    curriculumSort(entries);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("only");
  });
});

// ─── MEDIUM_BAND constant ───

describe("MEDIUM_BAND", () => {
  it("has min=0.3 and max=0.7", () => {
    expect(MEDIUM_BAND.min).toBe(0.3);
    expect(MEDIUM_BAND.max).toBe(0.7);
  });
});

// ─── NEAR_COMPLETE_GAP_THRESHOLD constant ───

describe("NEAR_COMPLETE_GAP_THRESHOLD", () => {
  it("is 0.1", () => {
    expect(NEAR_COMPLETE_GAP_THRESHOLD).toBe(0.1);
  });
});
