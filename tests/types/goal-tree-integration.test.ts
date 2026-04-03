import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../../src/state/state-manager.js";
import { SatisficingJudge } from "../../src/drive/satisficing-judge.js";
import type { Goal, Dimension } from "../../src/types/goal.js";
import { makeTempDir } from "../helpers/temp-dir.js";
import { makeGoal } from "../helpers/fixtures.js";

function makeDimension(overrides: Partial<Dimension> = {}): Dimension {
  return {
    name: "test_dim",
    label: "Test Dimension",
    current_value: 100,
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

// ─── Shared Setup ───

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

// ─── judgeTreeCompletion ───

describe("judgeTreeCompletion", async () => {
  it("leaf goal with no children_ids delegates to isGoalComplete (satisfied)", async () => {
    const goal = makeGoal({
      id: "leaf-1",
      dimensions: [makeDimension({ current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    await stateManager.saveGoal(goal);

    // Two calls required: double-confirmation guard applies to leaf nodes.
    await judge.judgeTreeCompletion("leaf-1");  // first cycle: streak=1, not yet complete
    const result = await judge.judgeTreeCompletion("leaf-1");  // second cycle: streak=2, confirmed
    expect(result.is_complete).toBe(true);
    expect(result.blocking_dimensions).toHaveLength(0);
  });

  it("leaf goal with no children_ids delegates to isGoalComplete (not satisfied)", async () => {
    const goal = makeGoal({
      id: "leaf-incomplete",
      dimensions: [makeDimension({ current_value: 50, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    await stateManager.saveGoal(goal);

    const result = await judge.judgeTreeCompletion("leaf-incomplete");
    expect(result.is_complete).toBe(false);
    expect(result.blocking_dimensions).toContain("test_dim");
  });

  it("all children complete → parent complete", async () => {
    const child1 = makeGoal({
      id: "child-1",
      dimensions: [makeDimension({ current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    const child2 = makeGoal({
      id: "child-2",
      dimensions: [makeDimension({ current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    const parent = makeGoal({
      id: "parent-complete",
      children_ids: ["child-1", "child-2"],
      dimensions: [],
    });

    await stateManager.saveGoal(child1);
    await stateManager.saveGoal(child2);
    await stateManager.saveGoal(parent);

    const result = await judge.judgeTreeCompletion("parent-complete");
    expect(result.is_complete).toBe(true);
  });

  it("one child incomplete → parent incomplete", async () => {
    const child1 = makeGoal({
      id: "child-done",
      dimensions: [makeDimension({ current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    const child2 = makeGoal({
      id: "child-not-done",
      dimensions: [makeDimension({ current_value: 40, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    const parent = makeGoal({
      id: "parent-blocked",
      children_ids: ["child-done", "child-not-done"],
      dimensions: [],
    });

    await stateManager.saveGoal(child1);
    await stateManager.saveGoal(child2);
    await stateManager.saveGoal(parent);

    const result = await judge.judgeTreeCompletion("parent-blocked");
    expect(result.is_complete).toBe(false);
    expect(result.blocking_dimensions).toContain("test_dim");
  });

  it("cancelled child counts as complete", async () => {
    const child1 = makeGoal({
      id: "child-cancelled",
      status: "cancelled",
      dimensions: [makeDimension({ current_value: 0, threshold: { type: "min", value: 100 } })],
    });
    const child2 = makeGoal({
      id: "child-ok",
      dimensions: [makeDimension({ current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    const parent = makeGoal({
      id: "parent-with-cancelled",
      children_ids: ["child-cancelled", "child-ok"],
      dimensions: [],
    });

    await stateManager.saveGoal(child1);
    await stateManager.saveGoal(child2);
    await stateManager.saveGoal(parent);

    const result = await judge.judgeTreeCompletion("parent-with-cancelled");
    expect(result.is_complete).toBe(true);
  });

  it("deep tree (3 levels) completion — all complete", async () => {
    const leaf = makeGoal({
      id: "deep-leaf",
      dimensions: [makeDimension({ current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    const mid = makeGoal({
      id: "deep-mid",
      children_ids: ["deep-leaf"],
      dimensions: [],
    });
    const root = makeGoal({
      id: "deep-root",
      children_ids: ["deep-mid"],
      dimensions: [],
    });

    await stateManager.saveGoal(leaf);
    await stateManager.saveGoal(mid);
    await stateManager.saveGoal(root);

    const result = await judge.judgeTreeCompletion("deep-root");
    expect(result.is_complete).toBe(true);
  });

  it("mixed completed and cancelled children → parent complete", async () => {
    const childCompleted = makeGoal({
      id: "mixed-complete",
      status: "completed",
      dimensions: [makeDimension({ current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 })],
    });
    const childCancelled = makeGoal({
      id: "mixed-cancelled",
      status: "cancelled",
      dimensions: [],
    });
    const parent = makeGoal({
      id: "mixed-parent",
      children_ids: ["mixed-complete", "mixed-cancelled"],
      dimensions: [],
    });

    await stateManager.saveGoal(childCompleted);
    await stateManager.saveGoal(childCancelled);
    await stateManager.saveGoal(parent);

    const result = await judge.judgeTreeCompletion("mixed-parent");
    expect(result.is_complete).toBe(true);
  });

  it("blocking dimensions aggregated from children", async () => {
    const dim1 = makeDimension({ name: "dim_a", current_value: 10, threshold: { type: "min", value: 100 }, confidence: 0.9 });
    const dim2 = makeDimension({ name: "dim_b", current_value: 20, threshold: { type: "min", value: 100 }, confidence: 0.9 });

    const child1 = makeGoal({ id: "agg-child-1", dimensions: [dim1] });
    const child2 = makeGoal({ id: "agg-child-2", dimensions: [dim2] });
    const parent = makeGoal({
      id: "agg-parent",
      children_ids: ["agg-child-1", "agg-child-2"],
      dimensions: [],
    });

    await stateManager.saveGoal(child1);
    await stateManager.saveGoal(child2);
    await stateManager.saveGoal(parent);

    const result = await judge.judgeTreeCompletion("agg-parent");
    expect(result.is_complete).toBe(false);
    expect(result.blocking_dimensions).toContain("dim_a");
    expect(result.blocking_dimensions).toContain("dim_b");
  });

  it("low_confidence_dimensions aggregated from children", async () => {
    // Low confidence (< 0.50) dimension that is met threshold-wise but is low confidence
    const lowConfDim = makeDimension({
      name: "low_conf_dim",
      current_value: 100,
      threshold: { type: "min", value: 100 },
      confidence: 0.3,
    });

    const child = makeGoal({ id: "low-conf-child", dimensions: [lowConfDim] });
    const parent = makeGoal({
      id: "low-conf-parent",
      children_ids: ["low-conf-child"],
      dimensions: [],
    });

    await stateManager.saveGoal(child);
    await stateManager.saveGoal(parent);

    const result = await judge.judgeTreeCompletion("low-conf-parent");
    expect(result.is_complete).toBe(false);
    expect(result.low_confidence_dimensions).toContain("low_conf_dim");
  });
});

// ─── getGoalTree ───

describe("getGoalTree", async () => {
  it("returns all goals in tree (BFS order, root first)", async () => {
    const child1 = makeGoal({ id: "gt-child-1" });
    const child2 = makeGoal({ id: "gt-child-2" });
    const root = makeGoal({ id: "gt-root", children_ids: ["gt-child-1", "gt-child-2"] });

    await stateManager.saveGoal(child1);
    await stateManager.saveGoal(child2);
    await stateManager.saveGoal(root);

    const result = await stateManager.getGoalTree("gt-root");
    expect(result).not.toBeNull();
    const ids = result!.map(g => g.id);
    expect(ids).toContain("gt-root");
    expect(ids).toContain("gt-child-1");
    expect(ids).toContain("gt-child-2");
    expect(ids[0]).toBe("gt-root");
  });

  it("returns null for non-existent root", async () => {
    const result = await stateManager.getGoalTree("non-existent-root");
    expect(result).toBeNull();
  });
});

// ─── getSubtree ───

describe("getSubtree", async () => {
  it("returns single node for leaf goal", async () => {
    const leaf = makeGoal({ id: "sub-leaf" });
    await stateManager.saveGoal(leaf);

    const result = await stateManager.getSubtree("sub-leaf");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("sub-leaf");
  });

  it("returns full subtree for parent with children", async () => {
    const child1 = makeGoal({ id: "sub-child-1" });
    const child2 = makeGoal({ id: "sub-child-2" });
    const parent = makeGoal({ id: "sub-parent", children_ids: ["sub-child-1", "sub-child-2"] });

    await stateManager.saveGoal(child1);
    await stateManager.saveGoal(child2);
    await stateManager.saveGoal(parent);

    const result = await stateManager.getSubtree("sub-parent");
    expect(result).toHaveLength(3);
    const ids = result.map(g => g.id);
    expect(ids).toContain("sub-parent");
    expect(ids).toContain("sub-child-1");
    expect(ids).toContain("sub-child-2");
  });

  it("returns empty array for non-existent goal", async () => {
    const result = await stateManager.getSubtree("does-not-exist");
    expect(result).toHaveLength(0);
  });

  it("handles deep subtree (3 levels)", async () => {
    const deepLeaf = makeGoal({ id: "deep-sub-leaf" });
    const deepMid = makeGoal({ id: "deep-sub-mid", children_ids: ["deep-sub-leaf"] });
    const deepRoot = makeGoal({ id: "deep-sub-root", children_ids: ["deep-sub-mid"] });

    await stateManager.saveGoal(deepLeaf);
    await stateManager.saveGoal(deepMid);
    await stateManager.saveGoal(deepRoot);

    const result = await stateManager.getSubtree("deep-sub-root");
    expect(result).toHaveLength(3);
    const ids = result.map(g => g.id);
    expect(ids).toContain("deep-sub-root");
    expect(ids).toContain("deep-sub-mid");
    expect(ids).toContain("deep-sub-leaf");
  });

  it("handles missing child gracefully (skips missing)", async () => {
    // Parent references a child that doesn't exist
    const parent = makeGoal({ id: "partial-parent", children_ids: ["missing-child"] });
    await stateManager.saveGoal(parent);

    const result = await stateManager.getSubtree("partial-parent");
    // Should still return parent, just not the missing child
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("partial-parent");
  });
});

// ─── updateGoalInTree ───

describe("updateGoalInTree", async () => {
  it("basic field update persists correctly", async () => {
    const goal = makeGoal({ id: "upd-basic", title: "Original Title" });
    await stateManager.saveGoal(goal);

    await stateManager.updateGoalInTree("upd-basic", { title: "Updated Title" });

    const loaded = await stateManager.loadGoal("upd-basic");
    expect(loaded!.title).toBe("Updated Title");
  });

  it("status update persists correctly", async () => {
    const goal = makeGoal({ id: "upd-status", status: "active" });
    await stateManager.saveGoal(goal);

    await stateManager.updateGoalInTree("upd-status", { status: "completed" });

    const loaded = await stateManager.loadGoal("upd-status");
    expect(loaded!.status).toBe("completed");
  });

  it("preserves existing fields not included in update", async () => {
    const goal = makeGoal({
      id: "upd-preserve",
      title: "Original",
      description: "Keep this",
    });
    await stateManager.saveGoal(goal);

    await stateManager.updateGoalInTree("upd-preserve", { title: "New Title" });

    const loaded = await stateManager.loadGoal("upd-preserve");
    expect(loaded!.title).toBe("New Title");
    expect(loaded!.description).toBe("Keep this");
    expect(loaded!.id).toBe("upd-preserve");  // id must not change
  });

  it("multiple updates work correctly", async () => {
    const goal = makeGoal({ id: "upd-multi", title: "Start", status: "active" });
    await stateManager.saveGoal(goal);

    await stateManager.updateGoalInTree("upd-multi", { title: "Middle", status: "waiting" });
    await stateManager.updateGoalInTree("upd-multi", { title: "Final", status: "completed" });

    const loaded = await stateManager.loadGoal("upd-multi");
    expect(loaded!.title).toBe("Final");
    expect(loaded!.status).toBe("completed");
  });

  it("throws when goal not found", async () => {
    await expect(async () => {
      await stateManager.updateGoalInTree("does-not-exist", { title: "X" });
    }).rejects.toThrow();
  });
});
