import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  aggregateGaps,
  applyConfidenceWeight,
  calculateDimensionGap,
  calculateGapVector,
  computeRawGap,
  normalizeGap,
} from "../../src/drive/gap-calculator.js";
import {
  SatisficingJudge,
  aggregateValues,
} from "../../src/drive/satisficing-judge.js";
import {
  buildThreshold,
  deduplicateDimensionKeys,
  decompositionToDimension,
  findBestDimensionMatch,
} from "../../src/goal/goal-validation.js";
import { MockEmbeddingClient } from "../../src/knowledge/embedding-client.js";
import { StateManager } from "../../src/state/state-manager.js";
import type { Dimension, Goal } from "../../src/types/goal.js";
import type { Threshold } from "../../src/types/core.js";

function makeDimension(
  name: string,
  threshold: Threshold,
  overrides: Partial<Dimension> = {}
): Dimension {
  return {
    name,
    label: name,
    current_value: null,
    threshold,
    confidence: 0.9,
    observation_method: {
      type: "llm_review",
      source: "test",
      schedule: null,
      endpoint: null,
      confidence_tier: "self_report",
    },
    last_updated: null,
    history: [],
    weight: 1,
    uncertainty_weight: null,
    state_integrity: "ok",
    dimension_mapping: null,
    ...overrides,
  };
}

function makeGoal(id: string, dimensions: Dimension[], overrides: Partial<Goal> = {}): Goal {
  const now = "2026-03-17T00:00:00.000Z";
  return {
    id,
    parent_id: null,
    node_type: "goal",
    title: id,
    description: "",
    status: "active",
    dimensions,
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: "manual",
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1,
    decomposition_depth: 0,
    specificity_score: null,
    loop_status: "idle",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeTempStateManager(): { stateManager: StateManager; baseDir: string } {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-example-test-"));
  return { stateManager: new StateManager(baseDir), baseDir };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("example unit coverage", () => {
  it("covers goal validation helpers", () => {
    const dimension = decompositionToDimension({
      name: "coverage",
      label: "Coverage",
      threshold_type: "min",
      threshold_value: 80,
      observation_method_hint: "ci",
    });

    expect(dimension.threshold).toEqual({ type: "min", value: 80 });
    expect(dimension.current_value).toBeNull();
    expect(buildThreshold("max", "bad")).toEqual({ type: "max", value: 100 });
    expect(buildThreshold("range", [10, "bad"])).toEqual({ type: "range", low: 10, high: 100 });
    expect(buildThreshold("match", ["bad"])).toEqual({ type: "match", value: "" });

    const deduped = deduplicateDimensionKeys([
      {
        name: "coverage",
        label: "Coverage",
        threshold_type: "min",
        threshold_value: 80,
        observation_method_hint: "ci",
      },
      {
        name: "coverage",
        label: "Coverage 2",
        threshold_type: "min",
        threshold_value: 90,
        observation_method_hint: "ci",
      },
      {
        name: "coverage",
        label: "Coverage 3",
        threshold_type: "min",
        threshold_value: 95,
        observation_method_hint: "ci",
      },
    ]);

    expect(deduped.map((item) => item.name)).toEqual(["coverage", "coverage_2", "coverage_3"]);
    expect(findBestDimensionMatch("test_coverage_percent", ["latency", "test_coverage"])).toBe(
      "test_coverage"
    );
    expect(findBestDimensionMatch("revenue_growth", ["burn_rate", "latency"])).toBeNull();
  });

  it("covers gap calculation pipeline and aggregation branches", () => {
    expect(computeRawGap(null, { type: "min", value: 8 })).toBe(8);
    expect(computeRawGap(null, { type: "max", value: 0 })).toBe(1);
    expect(computeRawGap(null, { type: "range", low: 2, high: 6 })).toBe(4);
    expect(computeRawGap("", { type: "present" })).toBe(1);
    expect(computeRawGap("done", { type: "match", value: "done" })).toBe(0);
    expect(computeRawGap(15, { type: "max", value: 10 })).toBe(5);

    expect(normalizeGap(3, { type: "min", value: 0 }, 1)).toBe(1);
    expect(normalizeGap(0.4, { type: "max", value: 0 }, 0.4)).toBe(0.4);
    expect(normalizeGap(4, { type: "range", low: 10, high: 10 }, 14)).toBe(1);
    expect(normalizeGap(1, { type: "present" }, false)).toBe(1);
    expect(normalizeGap(0, { type: "match", value: true }, true)).toBe(0);
    expect(normalizeGap(99, { type: "match", value: "x" }, null)).toBe(1);

    // 0.5 * (1 + 0.75 * 2) = 1.25, clamped to 1.0 by [0,1] invariant
    expect(applyConfidenceWeight(0.5, 0.25, 2, false)).toBe(1.0);
    expect(applyConfidenceWeight(1, 0.1, 5, true)).toBe(1);

    expect(
      calculateDimensionGap({
        name: "coverage",
        current_value: 60,
        threshold: { type: "min", value: 80 },
        confidence: 0.5,
        uncertainty_weight: null,
      }, 2)
    ).toMatchObject({
      dimension_name: "coverage",
      raw_gap: 20,
      normalized_gap: 0.25,
      normalized_weighted_gap: 0.5,
      uncertainty_weight: 2,
    });

    const vector = calculateGapVector(
      "goal-1",
      [
        makeDimension("coverage", { type: "min", value: 100 }, { current_value: 70, confidence: 0.8 }),
        makeDimension("bug_count", { type: "max", value: 5 }, { current_value: 8, confidence: 0.9 }),
      ],
      1.5
    );
    expect(vector.goal_id).toBe("goal-1");
    expect(vector.gaps).toHaveLength(2);

    expect(aggregateGaps([], "max")).toBe(0);
    expect(aggregateGaps([0.1, 0.6, 0.4], "max")).toBe(0.6);
    expect(aggregateGaps([1, 2], "weighted_avg", [1, 3])).toBe(1.75);
    expect(aggregateGaps([1, 2], "weighted_avg", [0, 0])).toBe(0);
    expect(aggregateGaps([0.2, 0.3], "sum")).toBe(0.5);
  });

  it("covers satisfaction, completion, selection, and proposal logic", async () => {
    const { stateManager, baseDir } = makeTempStateManager();
    tempDirs.push(baseDir);

    const callback = vi.fn();
    const judge = new SatisficingJudge(stateManager, new MockEmbeddingClient(8), callback);

    const highSatisfied = makeDimension("revenue", { type: "min", value: 100 }, {
      current_value: 120,
      confidence: 0.9,
    });
    const mediumSatisfied = makeDimension("uptime", { type: "min", value: 99 }, {
      current_value: 99,
      confidence: 0.6,
    });
    const lowUnsatisfied = makeDimension("quality", { type: "present" }, {
      current_value: false,
      confidence: 0.2,
    });

    expect(judge.isDimensionSatisfied(highSatisfied)).toMatchObject({
      dimension_name: "revenue",
      is_satisfied: true,
      confidence_tier: "high",
      effective_progress: 1,
      progress_ceiling: 1,
    });
    expect(judge.isDimensionSatisfied(mediumSatisfied)).toMatchObject({
      dimension_name: "uptime",
      is_satisfied: true,
      confidence_tier: "medium",
      effective_progress: 0.85,
      progress_ceiling: 0.85,
    });
    expect(judge.isDimensionSatisfied(lowUnsatisfied)).toMatchObject({
      dimension_name: "quality",
      is_satisfied: false,
      confidence_tier: "low",
      effective_progress: 0,
      progress_ceiling: 0.6,
    });

    expect(judge.applyProgressCeiling(0.95, 0.6)).toBe(0.85);

    const incompleteGoal = makeGoal("goal-incomplete", [
      highSatisfied,
      mediumSatisfied,
      lowUnsatisfied,
    ]);
    expect(judge.isGoalComplete(incompleteGoal)).toMatchObject({
      is_complete: false,
      blocking_dimensions: ["quality"],
      low_confidence_dimensions: ["quality"],
      needs_verification_task: true,
    });

    const completeGoal = makeGoal("goal-complete", [
      highSatisfied,
      makeDimension("docs", { type: "match", value: "done" }, {
        current_value: "done",
        confidence: 0.95,
      }),
    ]);
    // Double-confirm guard: requires 2 consecutive cycles
    judge.isGoalComplete(completeGoal);
    expect(judge.isGoalComplete(completeGoal)).toMatchObject({
      is_complete: true,
      blocking_dimensions: [],
      low_confidence_dimensions: [],
      needs_verification_task: false,
    });
    expect(callback).toHaveBeenCalledWith("goal-complete", ["revenue", "docs"]);

    expect(
      judge.selectDimensionsForIteration(
        [
          highSatisfied,
          mediumSatisfied,
          makeDimension("latency", { type: "max", value: 100 }, { current_value: 140, confidence: 0.8 }),
          makeDimension("adoption", { type: "min", value: 1000 }, { current_value: 400, confidence: 0.4 }),
        ],
        [
          { dimension_name: "latency", score: 0.9 },
          { dimension_name: "adoption", score: 0.95 },
          { dimension_name: "uptime", score: 0.2 },
        ],
        { max_dimensions: 2, uncertainty_threshold: 0.5 }
      )
    ).toEqual(["latency"]);

    const proposalGoal = makeGoal("proposal-goal", [
      makeDimension("sales", { type: "min", value: 100 }, { current_value: 5, confidence: 0.9 }),
      makeDimension("nps", { type: "min", value: 40 }, { current_value: 40, confidence: 0.9 }),
    ]);
    await stateManager.writeRaw("tasks/proposal-goal/task-history.json", [
      { primary_dimension: "sales", actual_elapsed_ms: 100, estimated_duration_ms: 500 },
      { primary_dimension: "sales", actual_elapsed_ms: 120, estimated_duration_ms: 500 },
      { primary_dimension: "sales", actual_elapsed_ms: 150, estimated_duration_ms: 500 },
    ]);
    const proposals = await judge.detectThresholdAdjustmentNeeded(
      proposalGoal,
      new Map([
        ["sales", 4],
        ["nps", 0],
      ])
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      goal_id: "proposal-goal",
      dimension_name: "sales",
      reason: "high_failure_no_progress",
    });

    const mappings = await judge.proposeDimensionMapping(
      [{ name: "test coverage", description: "automated test ratio" }],
      [
        { name: "deployment frequency", description: "release cadence" },
        { name: "test coverage", description: "automated test ratio" },
      ]
    );
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.parent_dimension).toBe("test coverage");
  });

  it("covers tree completion and subgoal propagation flows", async () => {
    const { stateManager, baseDir } = makeTempStateManager();
    tempDirs.push(baseDir);

    const judge = new SatisficingJudge(stateManager);

    const child = makeGoal(
      "child-1",
      [makeDimension("coverage", { type: "min", value: 80 }, { current_value: 80, confidence: 0.9 })],
      { parent_id: "root" }
    );
    const cancelledChild = makeGoal("child-2", [], {
      parent_id: "root",
      status: "cancelled",
    });
    const root = makeGoal(
      "root",
      [makeDimension("root-progress", { type: "present" }, { current_value: true, confidence: 0.95 })],
      { children_ids: ["child-1", "child-2"] }
    );

    await stateManager.saveGoal(root);
    await stateManager.saveGoal(child);
    await stateManager.saveGoal(cancelledChild);

    expect(await judge.judgeTreeCompletion("root")).toMatchObject({
      is_complete: true,
      blocking_dimensions: [],
      low_confidence_dimensions: [],
    });
    expect((await judge.judgeTreeCompletion("missing-root")).is_complete).toBe(false);

    const parent = makeGoal("parent", [
      makeDimension("shipping", { type: "min", value: 100 }, { current_value: 0, confidence: 0.9 }),
      makeDimension("quality_gate", { type: "present" }, { current_value: false, confidence: 0.9 }),
    ]);
    await stateManager.saveGoal(parent);

    await judge.propagateSubgoalCompletion("shipping", "parent");
    let updatedParent = await stateManager.loadGoal("parent");
    expect(updatedParent?.dimensions.find((dim) => dim.name === "shipping")?.current_value).toBe(100);

    await judge.propagateSubgoalCompletion("subgoal-1", "parent", [
      makeDimension("throughput-a", { type: "min", value: 100 }, {
        current_value: 80,
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "shipping", aggregation: "avg" },
      }),
      makeDimension("throughput-b", { type: "min", value: 100 }, {
        current_value: 100,
        confidence: 0.9,
        dimension_mapping: { parent_dimension: "shipping", aggregation: "avg" },
      }),
      makeDimension("quality_gate", { type: "present" }, {
        current_value: true,
        confidence: 0.9,
        dimension_mapping: null,
      }),
    ]);

    updatedParent = await stateManager.loadGoal("parent");
    expect(updatedParent?.dimensions.find((dim) => dim.name === "shipping")?.current_value).toBe(90);
    expect(updatedParent?.dimensions.find((dim) => dim.name === "quality_gate")?.current_value).toBe(
      true
    );

    expect(aggregateValues([], "avg")).toBe(0);
    expect(aggregateValues([1, 4, 2], "min")).toBe(1);
    expect(aggregateValues([1, 4, 2], "max")).toBe(4);
    expect(aggregateValues([1, 2, 3], "avg")).toBe(2);
    expect(aggregateValues([0.7, 1, 0.9], "all_required")).toBe(0.7);
  });
});
