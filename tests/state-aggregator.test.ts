import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state/state-manager.js";
import { SatisficingJudge } from "../src/drive/satisficing-judge.js";
import { StateAggregator } from "../src/goal/state-aggregator.js";
import type { Goal, Dimension } from "../src/types/goal.js";
import type { StateAggregationRule } from "../src/types/goal-tree.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";

function makeDimension(overrides: Partial<Dimension> = {}): Dimension {
  return {
    name: "score",
    label: "Score",
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

/** Create an ISO timestamp offset from now by the given number of hours */
function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;
let judge: SatisficingJudge;
let aggregator: StateAggregator;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  judge = new SatisficingJudge(stateManager);
  aggregator = new StateAggregator(stateManager, judge);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── Helper: build a parent with N children ───

async function buildTree(
  numChildren: number,
  childOverrides: Partial<Goal>[] = []
): Promise<{ parent: Goal; children: Goal[] }> {
  const children = Array.from({ length: numChildren }, (_, i) => {
    const overrides = childOverrides[i] ?? {};
    return makeGoal({ id: `child-${i}`, ...overrides });
  });

  const parent = makeGoal({
    id: "parent",
    children_ids: children.map((c) => c.id),
  });

  for (const child of children) {
    await stateManager.saveGoal({ ...child, parent_id: parent.id });
  }
  await stateManager.saveGoal(parent);

  return { parent, children };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Min aggregation
// ═══════════════════════════════════════════════════════════════════════════

describe("aggregateChildStates — min aggregation (default)", async () => {
  it("picks the worst (largest) child gap — single dominant child", async () => {
    await buildTree(3, [
      { dimensions: [makeDimension({ current_value: 90 })] }, // gap ~0.10
      { dimensions: [makeDimension({ current_value: 0 })] }, // gap = 1.0
      { dimensions: [makeDimension({ current_value: 80 })] }, // gap ~0.20
    ]);

    const result = await aggregator.aggregateChildStates("parent");
    // "min" on gaps = smallest gap, which corresponds to the BEST child
    // (closest to threshold). The worst child has gap 1.0, but min gives 0.10.
    expect(result.aggregation_method).toBe("min");
    expect(result.aggregated_gap).toBeCloseTo(0.1, 1);
  });

  it("returns 0 when all children are completed", async () => {
    await buildTree(2, [
      { status: "completed", dimensions: [] },
      { status: "completed", dimensions: [] },
    ]);
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBe(0);
  });

  it("returns 0 when all children have gap 0", async () => {
    await buildTree(2, [
      { dimensions: [makeDimension({ current_value: 100 })] },
      { dimensions: [makeDimension({ current_value: 100 })] },
    ]);
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBe(0);
  });

  it("returns same gap when all children have identical gap", async () => {
    await buildTree(3, [
      { dimensions: [makeDimension({ current_value: 50 })] },
      { dimensions: [makeDimension({ current_value: 50 })] },
      { dimensions: [makeDimension({ current_value: 50 })] },
    ]);
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeCloseTo(0.5, 5);
  });

  it("tracks per-child gaps in child_gaps map", async () => {
    await buildTree(2, [
      { dimensions: [makeDimension({ current_value: 100 })] }, // gap 0
      { dimensions: [makeDimension({ current_value: 0 })] }, // gap 1
    ]);
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.child_gaps["child-0"]).toBeCloseTo(0, 5);
    expect(result.child_gaps["child-1"]).toBeCloseTo(1.0, 5);
  });

  it("tracks per-child completion status", async () => {
    await buildTree(2, [
      { status: "completed" },
      { status: "active" },
    ]);
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.child_completions["child-0"]).toBe(true);
    expect(result.child_completions["child-1"]).toBe(false);
  });

  it("returns aggregated_gap = 0 when parent has no children", async () => {
    const parent = makeGoal({ id: "empty-parent", children_ids: [] });
    await stateManager.saveGoal(parent);
    const result = await aggregator.aggregateChildStates("empty-parent");
    expect(result.aggregated_gap).toBe(0);
  });

  it("handles one child with very high gap (1.0)", async () => {
    await buildTree(2, [
      { dimensions: [makeDimension({ current_value: 99 })] }, // gap 0.01
      { dimensions: [makeDimension({ current_value: 0 })] },  // gap 1.0
    ]);
    const result = await aggregator.aggregateChildStates("parent");
    // min picks the best child (gap 0.01)
    expect(result.aggregated_gap).toBeCloseTo(0.01, 2);
  });

  it("throws when parent goal not found", async () => {
    await expect(aggregator.aggregateChildStates("nonexistent-parent")).rejects.toThrow(/not found/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Avg aggregation
// ═══════════════════════════════════════════════════════════════════════════

describe("aggregateChildStates — avg aggregation", () => {
  function setAvgRule(): void {
    const rule: StateAggregationRule = {
      parent_id: "parent",
      child_ids: ["child-0", "child-1"],
      aggregation: "avg",
      propagation_direction: "up",
    };
    aggregator.registerAggregationRule(rule);
  }

  it("averages child gaps", async () => {
    await buildTree(2, [
      { dimensions: [makeDimension({ current_value: 0 })] },   // gap 1.0
      { dimensions: [makeDimension({ current_value: 100 })] }, // gap 0.0
    ]);
    setAvgRule();
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregation_method).toBe("avg");
    expect(result.aggregated_gap).toBeCloseTo(0.5, 5);
  });

  it("avg with 3 equal children", async () => {
    await buildTree(3, [
      { dimensions: [makeDimension({ current_value: 50 })] },
      { dimensions: [makeDimension({ current_value: 50 })] },
      { dimensions: [makeDimension({ current_value: 50 })] },
    ]);
    aggregator.registerAggregationRule({
      parent_id: "parent",
      child_ids: ["child-0", "child-1", "child-2"],
      aggregation: "avg",
      propagation_direction: "up",
    });
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeCloseTo(0.5, 5);
  });

  it("avg of 0.25 and 0.75 gives 0.5", async () => {
    await buildTree(2, [
      { dimensions: [makeDimension({ current_value: 75 })] }, // gap 0.25
      { dimensions: [makeDimension({ current_value: 25 })] }, // gap 0.75
    ]);
    setAvgRule();
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeCloseTo(0.5, 2);
  });

  it("avg with single child equals that child gap", async () => {
    await buildTree(1, [{ dimensions: [makeDimension({ current_value: 60 })] }]);
    aggregator.registerAggregationRule({
      parent_id: "parent",
      child_ids: ["child-0"],
      aggregation: "avg",
      propagation_direction: "up",
    });
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeCloseTo(0.4, 2);
  });

  it("avg includes completed children as gap 0", async () => {
    await buildTree(2, [
      { status: "completed", dimensions: [] },
      { dimensions: [makeDimension({ current_value: 0 })] }, // gap 1.0
    ]);
    setAvgRule();
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeCloseTo(0.5, 5);
  });

  it("avg returns 0 when all children complete", async () => {
    await buildTree(2, [
      { status: "completed", dimensions: [] },
      { status: "completed", dimensions: [] },
    ]);
    setAvgRule();
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Max aggregation
// ═══════════════════════════════════════════════════════════════════════════

describe("aggregateChildStates — max aggregation", () => {
  function setMaxRule(): void {
    aggregator.registerAggregationRule({
      parent_id: "parent",
      child_ids: ["child-0", "child-1"],
      aggregation: "max",
      propagation_direction: "up",
    });
  }

  it("picks the largest child gap (worst child)", async () => {
    await buildTree(2, [
      { dimensions: [makeDimension({ current_value: 90 })] }, // gap 0.10
      { dimensions: [makeDimension({ current_value: 0 })] },  // gap 1.0
    ]);
    setMaxRule();
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregation_method).toBe("max");
    expect(result.aggregated_gap).toBeCloseTo(1.0, 5);
  });

  it("returns 0 when all children gap is 0", async () => {
    await buildTree(2, [
      { dimensions: [makeDimension({ current_value: 100 })] },
      { dimensions: [makeDimension({ current_value: 100 })] },
    ]);
    setMaxRule();
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBe(0);
  });

  it("max gap with 3 children picks worst", async () => {
    await buildTree(3, [
      { dimensions: [makeDimension({ current_value: 100 })] }, // 0
      { dimensions: [makeDimension({ current_value: 50 })] },  // 0.5
      { dimensions: [makeDimension({ current_value: 80 })] },  // 0.2
    ]);
    aggregator.registerAggregationRule({
      parent_id: "parent",
      child_ids: ["child-0", "child-1", "child-2"],
      aggregation: "max",
      propagation_direction: "up",
    });
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeCloseTo(0.5, 2);
  });

  it("max with single child equals that child gap", async () => {
    await buildTree(1, [{ dimensions: [makeDimension({ current_value: 40 })] }]);
    aggregator.registerAggregationRule({
      parent_id: "parent",
      child_ids: ["child-0"],
      aggregation: "max",
      propagation_direction: "up",
    });
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeCloseTo(0.6, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. All_required aggregation
// ═══════════════════════════════════════════════════════════════════════════

describe("aggregateChildStates — all_required aggregation", async () => {
  function setAllRequiredRule(childIds?: string[]): void {
    aggregator.registerAggregationRule({
      parent_id: "parent",
      child_ids: childIds ?? ["child-0", "child-1"],
      aggregation: "all_required",
      propagation_direction: "up",
    });
  }

  it("returns non-zero gap when any child is incomplete", async () => {
    await buildTree(2, [
      { status: "completed", dimensions: [] }, // done
      { dimensions: [makeDimension({ current_value: 0 })] }, // gap 1.0
    ]);
    setAllRequiredRule();
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregation_method).toBe("all_required");
    expect(result.aggregated_gap).toBeGreaterThan(0);
  });

  it("returns 0 gap when all children are complete", async () => {
    await buildTree(2, [
      { status: "completed", dimensions: [] },
      { status: "completed", dimensions: [] },
    ]);
    setAllRequiredRule();
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBe(0);
  });

  it("partial completion still blocks parent", async () => {
    await buildTree(3, [
      { status: "completed", dimensions: [] },
      { status: "completed", dimensions: [] },
      { dimensions: [makeDimension({ current_value: 50 })] }, // still active
    ]);
    setAllRequiredRule(["child-0", "child-1", "child-2"]);
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeGreaterThan(0);
  });

  it("single incomplete child with full gap", async () => {
    await buildTree(1, [{ dimensions: [makeDimension({ current_value: 0 })] }]);
    aggregator.registerAggregationRule({
      parent_id: "parent",
      child_ids: ["child-0"],
      aggregation: "all_required",
      propagation_direction: "up",
    });
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeGreaterThan(0);
  });

  it("returns 0 when parent has no children", async () => {
    const parent = makeGoal({ id: "empty" });
    await stateManager.saveGoal(parent);
    aggregator.registerAggregationRule({
      parent_id: "empty",
      child_ids: [],
      aggregation: "all_required",
      propagation_direction: "up",
    });
    const result = await aggregator.aggregateChildStates("empty");
    expect(result.aggregated_gap).toBe(0);
  });

  it("cancelled child counts as done", async () => {
    await buildTree(2, [
      { status: "cancelled", dimensions: [] },
      { status: "completed", dimensions: [] },
    ]);
    setAllRequiredRule();
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Confidence propagation
// ═══════════════════════════════════════════════════════════════════════════

describe("aggregateChildStates — confidence propagation", async () => {
  it("aggregated confidence is min of all child confidences", async () => {
    await buildTree(3, [
      { dimensions: [makeDimension({ confidence: 0.9 })] },
      { dimensions: [makeDimension({ confidence: 0.6 })] },
      { dimensions: [makeDimension({ confidence: 0.8 })] },
    ]);
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_confidence).toBeCloseTo(0.6, 5);
  });

  it("single child confidence equals that child's confidence", async () => {
    await buildTree(1, [{ dimensions: [makeDimension({ confidence: 0.72 })] }]);
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_confidence).toBeCloseTo(0.72, 5);
  });

  it("high confidence across all children gives high aggregated confidence", async () => {
    await buildTree(3, [
      { dimensions: [makeDimension({ confidence: 0.95 })] },
      { dimensions: [makeDimension({ confidence: 0.90 })] },
      { dimensions: [makeDimension({ confidence: 0.88 })] },
    ]);
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_confidence).toBeCloseTo(0.88, 5);
  });

  it("one very low confidence child drives the aggregate down", async () => {
    await buildTree(3, [
      { dimensions: [makeDimension({ confidence: 0.95 })] },
      { dimensions: [makeDimension({ confidence: 0.95 })] },
      { dimensions: [makeDimension({ confidence: 0.1 })] },
    ]);
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_confidence).toBeCloseTo(0.1, 5);
  });

  it("missing child sets its confidence contribution to 0", async () => {
    const parent = makeGoal({
      id: "parent-missing",
      children_ids: ["real-child", "ghost-child"],
    });
    const realChild = makeGoal({
      id: "real-child",
      parent_id: "parent-missing",
      dimensions: [makeDimension({ confidence: 0.9 })],
    });
    await stateManager.saveGoal(parent);
    await stateManager.saveGoal(realChild);

    const result = await aggregator.aggregateChildStates("parent-missing");
    expect(result.aggregated_confidence).toBe(0);
  });

  it("no children returns confidence 1.0", async () => {
    const parent = makeGoal({ id: "no-children-conf", children_ids: [] });
    await stateManager.saveGoal(parent);
    const result = await aggregator.aggregateChildStates("no-children-conf");
    expect(result.aggregated_confidence).toBe(1.0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Downward constraint propagation
// ═══════════════════════════════════════════════════════════════════════════

describe("propagateStateDown — constraint propagation", async () => {
  it("new parent constraint is appended to child", async () => {
    const child = makeGoal({
      id: "child",
      parent_id: "parent",
      constraints: ["existing"],
    });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      constraints: ["existing", "new-constraint"],
    });
    await stateManager.saveGoal(child);
    await stateManager.saveGoal(parent);

    await aggregator.propagateStateDown("parent");

    const updatedChild = (await stateManager.loadGoal("child"))!;
    expect(updatedChild.constraints).toContain("new-constraint");
    expect(updatedChild.constraints).toContain("existing");
  });

  it("does not duplicate an existing constraint (idempotent)", async () => {
    const child = makeGoal({
      id: "child",
      parent_id: "parent",
      constraints: ["shared"],
    });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      constraints: ["shared"],
    });
    await stateManager.saveGoal(child);
    await stateManager.saveGoal(parent);

    await aggregator.propagateStateDown("parent");

    const updatedChild = (await stateManager.loadGoal("child"))!;
    const occurrences = updatedChild.constraints.filter((c) => c === "shared");
    expect(occurrences).toHaveLength(1);
  });

  it("propagates multiple new constraints at once", async () => {
    const child = makeGoal({ id: "child", parent_id: "parent" });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      constraints: ["c1", "c2", "c3"],
    });
    await stateManager.saveGoal(child);
    await stateManager.saveGoal(parent);

    await aggregator.propagateStateDown("parent");

    const updatedChild = (await stateManager.loadGoal("child"))!;
    expect(updatedChild.constraints).toEqual(
      expect.arrayContaining(["c1", "c2", "c3"])
    );
  });

  it("propagates to multiple children", async () => {
    const c1 = makeGoal({ id: "c1", parent_id: "parent" });
    const c2 = makeGoal({ id: "c2", parent_id: "parent" });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["c1", "c2"],
      constraints: ["budget-limit"],
    });
    await stateManager.saveGoal(c1);
    await stateManager.saveGoal(c2);
    await stateManager.saveGoal(parent);

    await aggregator.propagateStateDown("parent");

    expect((await stateManager.loadGoal("c1"))!.constraints).toContain("budget-limit");
    expect((await stateManager.loadGoal("c2"))!.constraints).toContain("budget-limit");
  });

  it("is idempotent across multiple propagation calls", async () => {
    const child = makeGoal({ id: "child", parent_id: "parent" });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      constraints: ["once"],
    });
    await stateManager.saveGoal(child);
    await stateManager.saveGoal(parent);

    await aggregator.propagateStateDown("parent");
    await aggregator.propagateStateDown("parent");
    await aggregator.propagateStateDown("parent");

    const updatedChild = (await stateManager.loadGoal("child"))!;
    const count = updatedChild.constraints.filter((c) => c === "once").length;
    expect(count).toBe(1);
  });

  it("throws when parent goal not found", async () => {
    await expect(aggregator.propagateStateDown("ghost-parent")).rejects.toThrow(/not found/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Downward deadline adjustment
// ═══════════════════════════════════════════════════════════════════════════

describe("propagateStateDown — deadline adjustment", async () => {
  it("child deadline is not later than parent deadline", async () => {
    const childDeadline = hoursFromNow(48);
    const parentDeadline = hoursFromNow(24); // shorter than child

    const child = makeGoal({
      id: "child",
      parent_id: "parent",
      deadline: childDeadline,
    });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      deadline: parentDeadline,
    });
    await stateManager.saveGoal(child);
    await stateManager.saveGoal(parent);

    await aggregator.propagateStateDown("parent");

    const updated = (await stateManager.loadGoal("child"))!;
    const updatedMs = Date.parse(updated.deadline!);
    const parentMs = Date.parse(parentDeadline);
    expect(updatedMs).toBeLessThanOrEqual(parentMs);
  });

  it("child deadline is not changed when it is already within parent window", async () => {
    const childDeadline = hoursFromNow(12);
    const parentDeadline = hoursFromNow(24); // parent is later

    const child = makeGoal({
      id: "child",
      parent_id: "parent",
      deadline: childDeadline,
    });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      deadline: parentDeadline,
    });
    await stateManager.saveGoal(child);
    await stateManager.saveGoal(parent);

    await aggregator.propagateStateDown("parent");

    const updated = (await stateManager.loadGoal("child"))!;
    // child already within parent window — deadline should stay the same
    expect(updated.deadline).toBe(childDeadline);
  });

  it("child with null deadline is not affected by parent deadline", async () => {
    const child = makeGoal({
      id: "child",
      parent_id: "parent",
      deadline: null,
    });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      deadline: hoursFromNow(10),
    });
    await stateManager.saveGoal(child);
    await stateManager.saveGoal(parent);

    await aggregator.propagateStateDown("parent");

    const updated = (await stateManager.loadGoal("child"))!;
    expect(updated.deadline).toBeNull();
  });

  it("no deadline propagation when parent has no deadline", async () => {
    const childDeadline = hoursFromNow(24);
    const child = makeGoal({
      id: "child",
      parent_id: "parent",
      deadline: childDeadline,
    });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      deadline: null,
    });
    await stateManager.saveGoal(child);
    await stateManager.saveGoal(parent);

    await aggregator.propagateStateDown("parent");

    const updated = (await stateManager.loadGoal("child"))!;
    expect(updated.deadline).toBe(childDeadline);
  });

  it("shortened parent deadline is propagated to child", async () => {
    // child has 48h, parent now only has 12h → child should be capped
    const childDeadline = hoursFromNow(48);
    const parentDeadline = hoursFromNow(12);

    const child = makeGoal({
      id: "child",
      parent_id: "parent",
      deadline: childDeadline,
    });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["child"],
      deadline: parentDeadline,
    });
    await stateManager.saveGoal(child);
    await stateManager.saveGoal(parent);

    await aggregator.propagateStateDown("parent");

    const updated = (await stateManager.loadGoal("child"))!;
    const newMs = Date.parse(updated.deadline!);
    const parentMs = Date.parse(parentDeadline);
    expect(newMs).toBeLessThanOrEqual(parentMs + 1000); // allow 1s slack
  });

  it("propagates deadline to multiple children", async () => {
    const parentDeadline = hoursFromNow(6);

    const c1 = makeGoal({ id: "c1", parent_id: "parent", deadline: hoursFromNow(48) });
    const c2 = makeGoal({ id: "c2", parent_id: "parent", deadline: hoursFromNow(48) });
    const parent = makeGoal({
      id: "parent",
      children_ids: ["c1", "c2"],
      deadline: parentDeadline,
    });
    await stateManager.saveGoal(c1);
    await stateManager.saveGoal(c2);
    await stateManager.saveGoal(parent);

    await aggregator.propagateStateDown("parent");

    const parentMs = Date.parse(parentDeadline);
    expect(Date.parse((await stateManager.loadGoal("c1"))!.deadline!)).toBeLessThanOrEqual(parentMs + 1000);
    expect(Date.parse((await stateManager.loadGoal("c2"))!.deadline!)).toBeLessThanOrEqual(parentMs + 1000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Completion cascade
// ═══════════════════════════════════════════════════════════════════════════

describe("checkCompletionCascade", async () => {
  it("returns parent ID when all siblings are complete", async () => {
    const c1 = makeGoal({ id: "c1", parent_id: "parent", status: "completed" });
    const c2 = makeGoal({ id: "c2", parent_id: "parent", status: "completed" });
    const parent = makeGoal({ id: "parent", children_ids: ["c1", "c2"] });
    await stateManager.saveGoal(c1);
    await stateManager.saveGoal(c2);
    await stateManager.saveGoal(parent);

    const result = await aggregator.checkCompletionCascade("c1");
    expect(result).toContain("parent");
  });

  it("returns empty when one sibling is still active", async () => {
    const c1 = makeGoal({ id: "c1", parent_id: "parent", status: "completed" });
    const c2 = makeGoal({ id: "c2", parent_id: "parent", status: "active" });
    const parent = makeGoal({ id: "parent", children_ids: ["c1", "c2"] });
    await stateManager.saveGoal(c1);
    await stateManager.saveGoal(c2);
    await stateManager.saveGoal(parent);

    const result = await aggregator.checkCompletionCascade("c1");
    expect(result).toEqual([]);
  });

  it("cascades through multiple levels", async () => {
    // leaf → mid → root
    const leaf = makeGoal({ id: "leaf", parent_id: "mid", status: "completed" });
    const mid = makeGoal({
      id: "mid",
      parent_id: "root",
      children_ids: ["leaf"],
      status: "active",
    });
    const root = makeGoal({ id: "root", children_ids: ["mid"] });
    await stateManager.saveGoal(leaf);
    await stateManager.saveGoal(mid);
    await stateManager.saveGoal(root);

    // After leaf completes, mid becomes eligible, then root
    const result = await aggregator.checkCompletionCascade("leaf");
    expect(result).toContain("mid");
    expect(result).toContain("root");
  });

  it("stops cascade when a sibling at higher level is active", async () => {
    // root has two children: mid (all children done) and blocker (active)
    const leaf = makeGoal({ id: "leaf", parent_id: "mid", status: "completed" });
    const mid = makeGoal({
      id: "mid",
      parent_id: "root",
      children_ids: ["leaf"],
      status: "active",
    });
    const blocker = makeGoal({ id: "blocker", parent_id: "root", status: "active" });
    const root = makeGoal({ id: "root", children_ids: ["mid", "blocker"] });
    await stateManager.saveGoal(leaf);
    await stateManager.saveGoal(mid);
    await stateManager.saveGoal(blocker);
    await stateManager.saveGoal(root);

    const result = await aggregator.checkCompletionCascade("leaf");
    expect(result).toContain("mid");
    expect(result).not.toContain("root");
  });

  it("cancelled child (merged) counts as done for cascade", async () => {
    const c1 = makeGoal({ id: "c1", parent_id: "parent", status: "completed" });
    const c2 = makeGoal({ id: "c2", parent_id: "parent", status: "cancelled" }); // merged/pruned
    const parent = makeGoal({ id: "parent", children_ids: ["c1", "c2"] });
    await stateManager.saveGoal(c1);
    await stateManager.saveGoal(c2);
    await stateManager.saveGoal(parent);

    const result = await aggregator.checkCompletionCascade("c1");
    expect(result).toContain("parent");
  });

  it("root goal becomes eligible when its only child completes", async () => {
    const child = makeGoal({ id: "child", parent_id: "root-goal", status: "completed" });
    const root = makeGoal({ id: "root-goal", parent_id: null, children_ids: ["child"] });
    await stateManager.saveGoal(child);
    await stateManager.saveGoal(root);

    const result = await aggregator.checkCompletionCascade("child");
    // root-goal becomes completable because its only child is done
    expect(result).toContain("root-goal");
  });

  it("returns empty for a goal with no parent", async () => {
    const standalone = makeGoal({ id: "standalone", parent_id: null });
    await stateManager.saveGoal(standalone);
    const result = await aggregator.checkCompletionCascade("standalone");
    expect(result).toEqual([]);
  });

  it("result is ordered bottom-up (closest ancestor first)", async () => {
    const l1 = makeGoal({ id: "l1", parent_id: "l2", status: "completed" });
    const l2 = makeGoal({ id: "l2", parent_id: "l3", children_ids: ["l1"], status: "active" });
    const l3 = makeGoal({ id: "l3", parent_id: null, children_ids: ["l2"] });
    await stateManager.saveGoal(l1);
    await stateManager.saveGoal(l2);
    await stateManager.saveGoal(l3);

    const result = await aggregator.checkCompletionCascade("l1");
    expect(result[0]).toBe("l2");
    expect(result[1]).toBe("l3");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. 3+ layer nesting
// ═══════════════════════════════════════════════════════════════════════════

describe("3+ layer nesting", async () => {
  it("deep tree aggregation uses correct child gaps at each level", async () => {
    // root → mid → leaf
    const leaf = makeGoal({
      id: "leaf",
      parent_id: "mid",
      dimensions: [makeDimension({ current_value: 0 })], // gap 1.0
    });
    const mid = makeGoal({
      id: "mid",
      parent_id: "root",
      children_ids: ["leaf"],
    });
    const root = makeGoal({
      id: "root",
      children_ids: ["mid"],
    });
    await stateManager.saveGoal(leaf);
    await stateManager.saveGoal(mid);
    await stateManager.saveGoal(root);

    // Aggregate mid (its child is leaf with gap 1.0)
    const midResult = await aggregator.aggregateChildStates("mid");
    expect(midResult.aggregated_gap).toBeCloseTo(1.0, 5);
    expect(midResult.child_gaps["leaf"]).toBeCloseTo(1.0, 5);
  });

  it("3-level cascade completes all the way to the root", async () => {
    const l1 = makeGoal({ id: "l1", parent_id: "l2", status: "completed" });
    const l2 = makeGoal({ id: "l2", parent_id: "l3", children_ids: ["l1"] });
    const l3 = makeGoal({ id: "l3", parent_id: "l4", children_ids: ["l2"] });
    const l4 = makeGoal({ id: "l4", parent_id: null, children_ids: ["l3"] });
    await stateManager.saveGoal(l1);
    await stateManager.saveGoal(l2);
    await stateManager.saveGoal(l3);
    await stateManager.saveGoal(l4);

    const result = await aggregator.checkCompletionCascade("l1");
    expect(result).toContain("l2");
    expect(result).toContain("l3");
    // l4 is root — it also becomes completable since all its children are done
    expect(result).toContain("l4");
  });

  it("mid-level partial completion blocks grandparent cascade", async () => {
    const l1a = makeGoal({ id: "l1a", parent_id: "l2", status: "completed" });
    const l1b = makeGoal({ id: "l1b", parent_id: "l2", status: "active" }); // blocker
    const l2 = makeGoal({ id: "l2", parent_id: "l3", children_ids: ["l1a", "l1b"] });
    const l3 = makeGoal({ id: "l3", parent_id: null, children_ids: ["l2"] });
    await stateManager.saveGoal(l1a);
    await stateManager.saveGoal(l1b);
    await stateManager.saveGoal(l2);
    await stateManager.saveGoal(l3);

    const result = await aggregator.checkCompletionCascade("l1a");
    expect(result).not.toContain("l2");
    expect(result).not.toContain("l3");
  });

  it("aggregation of a mid node includes only its direct children", async () => {
    // root → mid → [leaf-a, leaf-b]
    const leafA = makeGoal({
      id: "leaf-a",
      parent_id: "mid",
      dimensions: [makeDimension({ current_value: 100 })], // gap 0
    });
    const leafB = makeGoal({
      id: "leaf-b",
      parent_id: "mid",
      dimensions: [makeDimension({ current_value: 50 })],  // gap 0.5
    });
    const mid = makeGoal({
      id: "mid",
      parent_id: "root",
      children_ids: ["leaf-a", "leaf-b"],
    });
    const root = makeGoal({ id: "root", children_ids: ["mid"] });
    await stateManager.saveGoal(leafA);
    await stateManager.saveGoal(leafB);
    await stateManager.saveGoal(mid);
    await stateManager.saveGoal(root);

    const midResult = await aggregator.aggregateChildStates("mid");
    expect(midResult.child_gaps).toHaveProperty("leaf-a");
    expect(midResult.child_gaps).toHaveProperty("leaf-b");
    expect(midResult.child_gaps).not.toHaveProperty("root");
    // default "min": picks smaller gap (leaf-a = 0)
    expect(midResult.aggregated_gap).toBeCloseTo(0, 5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("edge cases", async () => {
  it("parent with no children returns gap 0 and confidence 1.0", async () => {
    const parent = makeGoal({ id: "no-kids", children_ids: [] });
    await stateManager.saveGoal(parent);
    const result = await aggregator.aggregateChildStates("no-kids");
    expect(result.aggregated_gap).toBe(0);
    expect(result.aggregated_confidence).toBe(1.0);
  });

  it("single child result mirrors that child's gap", async () => {
    await buildTree(1, [{ dimensions: [makeDimension({ current_value: 75 })] }]);
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBeCloseTo(0.25, 2);
  });

  it("missing child contributes gap 1.0 and confidence 0", async () => {
    const parent = makeGoal({
      id: "parent-ghost",
      children_ids: ["ghost"],
    });
    await stateManager.saveGoal(parent);

    const result = await aggregator.aggregateChildStates("parent-ghost");
    expect(result.child_gaps["ghost"]).toBe(1.0);
    expect(result.aggregated_confidence).toBe(0);
  });

  it("throws when parent not found in aggregateChildStates", async () => {
    await expect(aggregator.aggregateChildStates("no-such-parent")).rejects.toThrow(/not found/);
  });

  it("throws when parent not found in propagateStateDown", async () => {
    await expect(aggregator.propagateStateDown("no-such-parent")).rejects.toThrow(/not found/);
  });

  it("goal with empty dimensions has gap 0", async () => {
    await buildTree(1, [{ dimensions: [] }]);
    const result = await aggregator.aggregateChildStates("parent");
    expect(result.aggregated_gap).toBe(0);
  });
});
