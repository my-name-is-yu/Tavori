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
