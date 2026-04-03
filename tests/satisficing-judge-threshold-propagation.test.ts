import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { SatisficingJudge, aggregateValues } from "../src/drive/satisficing-judge.js";
import { MockEmbeddingClient } from "../src/knowledge/embedding-client.js";
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
