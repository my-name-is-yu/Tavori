import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GoalRefiner } from "../src/goal/goal-refiner.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";
import { SatisficingJudge } from "../src/drive/satisficing-judge.js";
import { StateAggregator } from "../src/goal/state-aggregator.js";
import { GoalTreeManager } from "../src/goal/goal-tree-manager.js";
import { EthicsGate } from "../src/traits/ethics-gate.js";
import { GoalDependencyGraph } from "../src/goal/goal-dependency-graph.js";
import { TreeLoopOrchestrator } from "../src/goal/tree-loop-orchestrator.js";
import type { Goal, Dimension } from "../src/types/goal.js";
import type { GoalDecompositionConfig } from "../src/types/goal-tree.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeGoal } from "./helpers/fixtures.js";

// ─── Fixtures ───

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

const DEFAULT_CONFIG: GoalDecompositionConfig = {
  max_depth: 5,
  min_specificity: 0.7,
  auto_prune_threshold: 0.3,
  parallel_loop_limit: 3,
};

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;
let satisficingJudge: SatisficingJudge;
let stateAggregator: StateAggregator;
let goalTreeManager: GoalTreeManager;
let orchestrator: TreeLoopOrchestrator;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-tlo-test-"));
  stateManager = new StateManager(tempDir);
  satisficingJudge = new SatisficingJudge(stateManager);
  stateAggregator = new StateAggregator(stateManager, satisficingJudge);
  const mockLLM = createMockLLMClient([]);
  const ethicsGate = new EthicsGate(stateManager, mockLLM);
  const depGraph = new GoalDependencyGraph(stateManager, mockLLM);
  goalTreeManager = new GoalTreeManager(
    stateManager,
    mockLLM,
    ethicsGate,
    depGraph
  );
  orchestrator = new TreeLoopOrchestrator(
    stateManager,
    goalTreeManager,
    stateAggregator,
    satisficingJudge
  );
});

afterEach(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore cleanup race */ }
});

// ─── Helper: save a goal and return it ───
async function saveGoal(overrides: Partial<Goal> = {}): Promise<Goal> {
  const g = makeGoal(overrides);
  await stateManager.saveGoal(g);
  return g;
}

// ─── Helper: build a simple parent–children tree ───
async function buildSimpleTree(
  numChildren: number,
  childOverrides: Partial<Goal> = {}
): Promise<{ parent: Goal; children: Goal[] }> {
  const children: Goal[] = [];
  const childIds: string[] = [];

  for (let i = 0; i < numChildren; i++) {
    const child = await saveGoal({
      id: `child-${i}`,
      node_type: "leaf",
      decomposition_depth: 1,
      ...childOverrides,
    });
    children.push(child);
    childIds.push(child.id);
  }

  const parent = await saveGoal({
    id: "parent",
    node_type: "goal",
    children_ids: childIds,
  });

  // Update each child's parent_id
  for (const child of children) {
    await stateManager.saveGoal({ ...child, parent_id: parent.id });
  }

  return { parent, children };
}

// ═══════════════════════════════════════════════════════════════════
// 1. NODE SELECTION TESTS (~20 tests)
// ═══════════════════════════════════════════════════════════════════

describe("selectNextNode — basic selection", async () => {
  it("returns null when tree root does not exist", async () => {
    const result = await orchestrator.selectNextNode("nonexistent-root");
    expect(result).toBeNull();
  });

  it("selects the root itself if it is the only active idle node", async () => {
    const root = await saveGoal({ id: "root", node_type: "goal" });
    const result = await orchestrator.selectNextNode(root.id);
    expect(result).toBe(root.id);
  });

  it("sets loop_status to 'running' on the selected node", async () => {
    const root = await saveGoal({ id: "root", node_type: "goal" });
    await orchestrator.selectNextNode(root.id);
    const updated = await stateManager.loadGoal(root.id);
    expect(updated?.loop_status).toBe("running");
  });

  it("prefers leaf node over non-leaf node", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["child-leaf", "child-subgoal"],
    });
    await saveGoal({
      id: "child-leaf",
      node_type: "leaf",
      parent_id: "root",
      decomposition_depth: 1,
    });
    await saveGoal({
      id: "child-subgoal",
      node_type: "subgoal",
      parent_id: "root",
      decomposition_depth: 1,
    });

    const result = await orchestrator.selectNextNode("root");
    expect(result).toBe("child-leaf");
  });

  it("falls back to non-leaf when no leaf nodes exist", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["child-sub"],
    });
    await saveGoal({
      id: "child-sub",
      node_type: "subgoal",
      parent_id: "root",
      decomposition_depth: 1,
    });

    // root is also an active+idle non-leaf node and appears before child-sub in iteration
    const result = await orchestrator.selectNextNode("root");
    expect(result).not.toBeNull();
    // Either root or child-sub is valid (both are active+idle non-leaf)
    expect(["root", "child-sub"]).toContain(result);
  });

  it("skips nodes with status !== 'active'", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", status: "completed" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", status: "active" });

    const result = await orchestrator.selectNextNode("root");
    expect(result).toBe("c2");
  });

  it("skips nodes with loop_status 'running'", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "running" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", loop_status: "idle" });

    const result = await orchestrator.selectNextNode("root");
    expect(result).toBe("c2");
  });

  it("skips nodes with loop_status 'paused'", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "paused" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", loop_status: "idle" });

    const result = await orchestrator.selectNextNode("root");
    expect(result).toBe("c2");
  });

  it("returns null when all leaf nodes AND the root are running or paused", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
      loop_status: "running", // root also running
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "running" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", loop_status: "paused" });

    const result = await orchestrator.selectNextNode("root");
    expect(result).toBeNull();
  });

  it("returns null when all nodes are completed", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      status: "completed",
      children_ids: ["c1"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", status: "completed" });

    const result = await orchestrator.selectNextNode("root");
    expect(result).toBeNull();
  });

  it("returns null when all nodes are cancelled", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      status: "cancelled",
      children_ids: ["c1"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", status: "cancelled" });

    const result = await orchestrator.selectNextNode("root");
    expect(result).toBeNull();
  });

  it("selects deeper leaf over shallower leaf when both are eligible", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["mid"],
    });
    await saveGoal({
      id: "mid",
      node_type: "goal",
      parent_id: "root",
      decomposition_depth: 1,
      children_ids: ["deep"],
    });
    await saveGoal({
      id: "deep",
      node_type: "leaf",
      parent_id: "mid",
      decomposition_depth: 2,
    });
    // root itself is also "goal" type (not leaf), mid is also "goal" (not leaf)
    // only deep is leaf
    const result = await orchestrator.selectNextNode("root");
    expect(result).toBe("deep");
  });

  it("selects single-node tree (root is a leaf)", async () => {
    await saveGoal({ id: "root", node_type: "leaf" });
    const result = await orchestrator.selectNextNode("root");
    expect(result).toBe("root");
  });

  it("does not select cancelled nodes even if loop_status is idle", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", status: "cancelled" });

    const result = await orchestrator.selectNextNode("root");
    // root is active+idle+non-leaf, should be selected as fallback
    expect(result).toBe("root");
  });

  it("prefers multiple leaves over non-leaves — first eligible leaf returned", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["leaf1", "leaf2", "sub1"],
    });
    await saveGoal({ id: "leaf1", node_type: "leaf", parent_id: "root", decomposition_depth: 1 });
    await saveGoal({ id: "leaf2", node_type: "leaf", parent_id: "root", decomposition_depth: 1 });
    await saveGoal({ id: "sub1", node_type: "subgoal", parent_id: "root", decomposition_depth: 1 });

    const result = await orchestrator.selectNextNode("root");
    expect(result).toBe("leaf1"); // first in stable order among equal depth
  });

  it("prioritizes deeper eligible leaves over shallower eligible leaves", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["shallow", "deep"],
    });
    await saveGoal({
      id: "shallow",
      node_type: "leaf",
      parent_id: "root",
      decomposition_depth: 1,
    });
    await saveGoal({
      id: "deep",
      node_type: "leaf",
      parent_id: "root",
      decomposition_depth: 3,
    });

    const result = await orchestrator.selectNextNode("root");
    expect(result).toBe("deep");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. PARALLEL EXECUTION CONTROL (~15 tests)
// ═══════════════════════════════════════════════════════════════════

describe("selectNextNode — parallel execution control", async () => {
  it("returns null immediately when parallel_loop_limit=1 and one node is running", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "running" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", loop_status: "idle" });

    await orchestrator.startTreeExecution("root", { ...DEFAULT_CONFIG, parallel_loop_limit: 1 });

    // c1 is already running (set before startTreeExecution reset — but startTreeExecution resets to idle)
    // Re-set c1 to running after startTreeExecution
    const c1 = await stateManager.loadGoal("c1");
    await stateManager.saveGoal({ ...c1!, loop_status: "running" });

    const result = await orchestrator.selectNextNode("root");
    expect(result).toBeNull();
  });

  it("allows one node when parallel_loop_limit=1 and nothing is running", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "root" });

    await orchestrator.startTreeExecution("root", { ...DEFAULT_CONFIG, parallel_loop_limit: 1 });

    const result = await orchestrator.selectNextNode("root");
    expect(result).not.toBeNull();
  });

  it("allows up to parallel_loop_limit=3 concurrent nodes", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2", "c3", "c4"],
    });
    for (let i = 1; i <= 4; i++) {
      await saveGoal({ id: `c${i}`, node_type: "leaf", parent_id: "root", decomposition_depth: 1 });
    }

    // Select 3 nodes (limit=3)
    const sel1 = await orchestrator.selectNextNode("root");
    const sel2 = await orchestrator.selectNextNode("root");
    const sel3 = await orchestrator.selectNextNode("root");
    expect(sel1).not.toBeNull();
    expect(sel2).not.toBeNull();
    expect(sel3).not.toBeNull();

    // 4th should be blocked
    const sel4 = await orchestrator.selectNextNode("root");
    expect(sel4).toBeNull();
  });

  it("returns null when active_loops count equals parallel_loop_limit", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2", "c3"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "running" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", loop_status: "running" });
    await saveGoal({ id: "c3", node_type: "leaf", parent_id: "root", loop_status: "running" });

    // Default config has parallel_loop_limit=3, all 3 are running
    const result = await orchestrator.selectNextNode("root");
    expect(result).toBeNull();
  });

  it("returns a node after a running node is completed (slot freed)", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "running" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", loop_status: "idle" });

    // With parallel_loop_limit=1: cannot select
    orchestrator["config"] = { ...DEFAULT_CONFIG, parallel_loop_limit: 1 };
    let result = await orchestrator.selectNextNode("root");
    expect(result).toBeNull();

    // Complete c1 to free the slot
    await orchestrator.onNodeCompleted("c1");
    // Also mark c1 status as completed so it's not selected again
    const c1 = await stateManager.loadGoal("c1");
    await stateManager.saveGoal({ ...c1!, status: "completed" });

    // Now should be able to select c2
    result = await orchestrator.selectNextNode("root");
    expect(result).toBe("c2");
  });

  it("sequential selections mark nodes as running and reduce available slots", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", decomposition_depth: 1 });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", decomposition_depth: 1 });

    const first = await orchestrator.selectNextNode("root");
    const second = await orchestrator.selectNextNode("root");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
  });

  it("respects config parallel_loop_limit=2", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2", "c3"],
    });
    for (let i = 1; i <= 3; i++) {
      await saveGoal({ id: `c${i}`, node_type: "leaf", parent_id: "root", decomposition_depth: 1 });
    }

    await orchestrator.startTreeExecution("root", {
      ...DEFAULT_CONFIG,
      parallel_loop_limit: 2,
    });

    const sel1 = await orchestrator.selectNextNode("root");
    const sel2 = await orchestrator.selectNextNode("root");
    const sel3 = await orchestrator.selectNextNode("root");

    expect(sel1).not.toBeNull();
    expect(sel2).not.toBeNull();
    expect(sel3).toBeNull(); // limit of 2 reached
  });

  it("paused nodes do not count toward active_loops", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "paused" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", loop_status: "idle" });

    // Only "running" counts for active_loops. With limit=1, paused doesn't block.
    orchestrator["config"] = { ...DEFAULT_CONFIG, parallel_loop_limit: 1 };
    const result = await orchestrator.selectNextNode("root");
    // c2 should be selectable because c1 is paused (not running)
    expect(result).toBe("c2");
  });

  it("selecting a node increments active count for subsequent calls", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", decomposition_depth: 1 });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", decomposition_depth: 1 });

    orchestrator["config"] = { ...DEFAULT_CONFIG, parallel_loop_limit: 1 };

    const first = await orchestrator.selectNextNode("root");
    expect(first).not.toBeNull();

    // After selecting one, the limit is reached
    const second = await orchestrator.selectNextNode("root");
    expect(second).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. NODE COMPLETION CASCADE (~20 tests)
// ═══════════════════════════════════════════════════════════════════

describe("onNodeCompleted — loop_status reset", async () => {
  it("sets loop_status to 'idle' after node completes", async () => {
    const node = await saveGoal({ id: "node1", node_type: "leaf", loop_status: "running" });
    await orchestrator.onNodeCompleted(node.id);
    const updated = await stateManager.loadGoal(node.id);
    expect(updated?.loop_status).toBe("idle");
  });

  it("is a no-op if goal does not exist", async () => {
    await expect(orchestrator.onNodeCompleted("nonexistent")).resolves.not.toThrow();
  });

  it("updates updated_at timestamp", async () => {
    const before = new Date().toISOString();
    const node = await saveGoal({ id: "n1", loop_status: "running" });
    await orchestrator.onNodeCompleted(node.id);
    const updated = await stateManager.loadGoal("n1");
    expect(updated?.updated_at >= before).toBe(true);
  });
});

describe("onNodeCompleted — parent aggregation", async () => {
  it("triggers aggregation up the parent chain", async () => {
    const { parent, children } = await buildSimpleTree(2);
    const child = children[0]!;

    // Mark child as completed
    await stateManager.saveGoal({ ...child, status: "completed" });
    await orchestrator.onNodeCompleted(child.id);

    // Parent should still exist
    const updatedParent = await stateManager.loadGoal(parent.id);
    expect(updatedParent).not.toBeNull();
  });

  it("aggregates child states — parent confidence should reflect children", async () => {
    await saveGoal({
      id: "parent",
      node_type: "goal",
      children_ids: ["c1"],
    });
    await saveGoal({
      id: "c1",
      node_type: "leaf",
      parent_id: "parent",
      loop_status: "running",
      status: "completed",
      dimensions: [makeDimension({ confidence: 0.4 })],
    });

    await orchestrator.onNodeCompleted("c1");
    // No throw — aggregation ran
    const parent = await stateManager.loadGoal("parent");
    expect(parent).not.toBeNull();
  });

  it("does not throw when parent has no further parent (root level)", async () => {
    const root = await saveGoal({ id: "root", loop_status: "running" });
    await expect(orchestrator.onNodeCompleted(root.id)).resolves.not.toThrow();
    const updated = await stateManager.loadGoal("root");
    expect(updated?.loop_status).toBe("idle");
  });
});

describe("onNodeCompleted — completion cascade", async () => {
  it("marks parent as completed when all siblings are done", async () => {
    await saveGoal({
      id: "parent",
      node_type: "goal",
      status: "active",
      children_ids: ["c1", "c2"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "parent", status: "completed" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "parent", status: "active", loop_status: "running" });

    // Complete c2 — now all children are done
    await stateManager.saveGoal({
      ...await stateManager.loadGoal("c2")!,
      status: "completed",
    });
    await orchestrator.onNodeCompleted("c2");

    const parent = await stateManager.loadGoal("parent");
    expect(parent?.status).toBe("completed");
  });

  it("does not mark parent as completed when sibling is still active", async () => {
    await saveGoal({
      id: "parent",
      node_type: "goal",
      status: "active",
      children_ids: ["c1", "c2"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "parent", status: "active" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "parent", status: "active", loop_status: "running" });

    await orchestrator.onNodeCompleted("c2");

    // c1 is still active — parent should NOT be completed
    const parent = await stateManager.loadGoal("parent");
    expect(parent?.status).not.toBe("completed");
  });

  it("treats cancelled siblings as done for cascade purposes", async () => {
    await saveGoal({
      id: "parent",
      node_type: "goal",
      status: "active",
      children_ids: ["c1", "c2"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "parent", status: "cancelled" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "parent", status: "active", loop_status: "running" });

    await stateManager.saveGoal({ ...await stateManager.loadGoal("c2")!, status: "completed" });
    await orchestrator.onNodeCompleted("c2");

    const parent = await stateManager.loadGoal("parent");
    expect(parent?.status).toBe("completed");
  });

  it("cascades completion through 3 layers", async () => {
    // root → mid → leaf
    await saveGoal({ id: "root", node_type: "goal", status: "active", children_ids: ["mid"] });
    await saveGoal({ id: "mid", node_type: "subgoal", parent_id: "root", status: "active", children_ids: ["leaf1"] });
    await saveGoal({ id: "leaf1", node_type: "leaf", parent_id: "mid", status: "active", loop_status: "running" });

    await stateManager.saveGoal({ ...await stateManager.loadGoal("leaf1")!, status: "completed" });
    await orchestrator.onNodeCompleted("leaf1");

    const mid = await stateManager.loadGoal("mid");
    const root = await stateManager.loadGoal("root");
    expect(mid?.status).toBe("completed");
    expect(root?.status).toBe("completed");
  });

  it("stops cascade when a parent has remaining active children", async () => {
    await saveGoal({ id: "root", node_type: "goal", status: "active", children_ids: ["mid1", "mid2"] });
    await saveGoal({ id: "mid1", node_type: "subgoal", parent_id: "root", status: "active", children_ids: ["leaf1"] });
    await saveGoal({ id: "mid2", node_type: "subgoal", parent_id: "root", status: "active", children_ids: [] });
    await saveGoal({ id: "leaf1", node_type: "leaf", parent_id: "mid1", status: "active", loop_status: "running" });

    await stateManager.saveGoal({ ...await stateManager.loadGoal("leaf1")!, status: "completed" });
    await orchestrator.onNodeCompleted("leaf1");

    // mid1 should complete (all its children done), but root should not (mid2 still active)
    const mid1 = await stateManager.loadGoal("mid1");
    const root = await stateManager.loadGoal("root");
    expect(mid1?.status).toBe("completed");
    expect(root?.status).not.toBe("completed");
  });

  it("does not re-complete already completed ancestors", async () => {
    await saveGoal({ id: "root", node_type: "goal", status: "completed", children_ids: ["c1"] });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", status: "active", loop_status: "running" });

    await stateManager.saveGoal({ ...await stateManager.loadGoal("c1")!, status: "completed" });
    await orchestrator.onNodeCompleted("c1");

    const root = await stateManager.loadGoal("root");
    expect(root?.status).toBe("completed"); // remains completed (idempotent)
  });

  it("loop_status is idle after cascade-completion", async () => {
    await saveGoal({ id: "root", node_type: "goal", status: "active", children_ids: ["c1"] });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "running", status: "active" });

    await stateManager.saveGoal({ ...await stateManager.loadGoal("c1")!, status: "completed" });
    await orchestrator.onNodeCompleted("c1");

    const c1 = await stateManager.loadGoal("c1");
    expect(c1?.loop_status).toBe("idle");
  });

  it("single child completion triggers parent completion", async () => {
    await saveGoal({ id: "parent", status: "active", children_ids: ["c1"] });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "parent", status: "active", loop_status: "running" });

    await stateManager.saveGoal({ ...await stateManager.loadGoal("c1")!, status: "completed" });
    await orchestrator.onNodeCompleted("c1");

    expect((await stateManager.loadGoal("parent"))?.status).toBe("completed");
  });

  it("4-level cascade: leaf → L3 → L2 → root", async () => {
    await saveGoal({ id: "root", status: "active", children_ids: ["l2"] });
    await saveGoal({ id: "l2", parent_id: "root", status: "active", children_ids: ["l3"] });
    await saveGoal({ id: "l3", parent_id: "l2", status: "active", children_ids: ["leaf"] });
    await saveGoal({ id: "leaf", node_type: "leaf", parent_id: "l3", status: "active", loop_status: "running" });

    await stateManager.saveGoal({ ...await stateManager.loadGoal("leaf")!, status: "completed" });
    await orchestrator.onNodeCompleted("leaf");

    expect((await stateManager.loadGoal("l3"))?.status).toBe("completed");
    expect((await stateManager.loadGoal("l2"))?.status).toBe("completed");
    expect((await stateManager.loadGoal("root"))?.status).toBe("completed");
  });

  it("applies cascade completion to every ancestor returned by the aggregator", async () => {
    await saveGoal({ id: "root", node_type: "goal", status: "active", children_ids: ["mid"] });
    await saveGoal({ id: "mid", node_type: "subgoal", parent_id: "root", status: "active", children_ids: ["leaf"] });
    await saveGoal({ id: "leaf", node_type: "leaf", parent_id: "mid", status: "active", loop_status: "running" });

    await stateManager.saveGoal({ ...await stateManager.loadGoal("leaf")!, status: "completed" });
    await orchestrator.onNodeCompleted("leaf");

    expect((await stateManager.loadGoal("mid"))?.status).toBe("completed");
    expect((await stateManager.loadGoal("root"))?.status).toBe("completed");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. PAUSE / RESUME (~10 tests)
// ═══════════════════════════════════════════════════════════════════

describe("pauseNodeLoop", async () => {
  it("sets loop_status to 'paused'", async () => {
    const goal = await saveGoal({ id: "g1", loop_status: "running" });
    await orchestrator.pauseNodeLoop(goal.id);
    const updated = await stateManager.loadGoal("g1");
    expect(updated?.loop_status).toBe("paused");
  });

  it("is a no-op for non-existent goal", async () => {
    await expect(orchestrator.pauseNodeLoop("nonexistent")).resolves.not.toThrow();
  });

  it("updates updated_at timestamp on pause", async () => {
    const before = new Date().toISOString();
    await saveGoal({ id: "g1", loop_status: "running" });
    await orchestrator.pauseNodeLoop("g1");
    const updated = await stateManager.loadGoal("g1");
    expect(updated?.updated_at >= before).toBe(true);
  });

  it("can pause an idle node too", async () => {
    await saveGoal({ id: "g1", loop_status: "idle" });
    await orchestrator.pauseNodeLoop("g1");
    const updated = await stateManager.loadGoal("g1");
    expect(updated?.loop_status).toBe("paused");
  });

  it("paused node is not selected by selectNextNode", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "root" });

    await orchestrator.pauseNodeLoop("c1");

    orchestrator["config"] = { ...DEFAULT_CONFIG, parallel_loop_limit: 1 };
    const result = await orchestrator.selectNextNode("root");
    expect(result).toBe("c2");
  });
});

describe("resumeNodeLoop", async () => {
  it("sets loop_status to 'running'", async () => {
    const goal = await saveGoal({ id: "g1", loop_status: "paused" });
    await orchestrator.resumeNodeLoop(goal.id);
    const updated = await stateManager.loadGoal("g1");
    expect(updated?.loop_status).toBe("running");
  });

  it("is a no-op for non-existent goal", async () => {
    await expect(orchestrator.resumeNodeLoop("nonexistent")).resolves.not.toThrow();
  });

  it("updates updated_at timestamp on resume", async () => {
    const before = new Date().toISOString();
    await saveGoal({ id: "g1", loop_status: "paused" });
    await orchestrator.resumeNodeLoop("g1");
    const updated = await stateManager.loadGoal("g1");
    expect(updated?.updated_at >= before).toBe(true);
  });

  it("resumed node is counted toward active_loops", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", loop_status: "paused" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", loop_status: "idle" });

    await orchestrator.resumeNodeLoop("c1"); // c1 now running

    // With limit=1, c1 is running → c2 cannot be selected
    orchestrator["config"] = { ...DEFAULT_CONFIG, parallel_loop_limit: 1 };
    const result = await orchestrator.selectNextNode("root");
    expect(result).toBeNull();
  });

  it("pause then resume restores idle→running flow correctly", async () => {
    await saveGoal({ id: "g1", loop_status: "idle" });
    await orchestrator.pauseNodeLoop("g1");
    expect((await stateManager.loadGoal("g1"))?.loop_status).toBe("paused");
    await orchestrator.resumeNodeLoop("g1");
    expect((await stateManager.loadGoal("g1"))?.loop_status).toBe("running");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. EDGE CASES (~15 tests)
// ═══════════════════════════════════════════════════════════════════

describe("edge cases", async () => {
  it("empty tree (root not found) returns null from selectNextNode", async () => {
    expect(await orchestrator.selectNextNode("does-not-exist")).toBeNull();
  });

  it("single leaf node: selects it and marks running", async () => {
    await saveGoal({ id: "only-leaf", node_type: "leaf" });
    const result = await orchestrator.selectNextNode("only-leaf");
    expect(result).toBe("only-leaf");
    expect((await stateManager.loadGoal("only-leaf"))?.loop_status).toBe("running");
  });

  it("all nodes completed — returns null", async () => {
    await saveGoal({ id: "root", status: "completed", children_ids: ["c1"] });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", status: "completed" });
    expect(await orchestrator.selectNextNode("root")).toBeNull();
  });

  it("deep tree (5 levels): selects deepest leaf first", async () => {
    await saveGoal({ id: "l0", node_type: "goal", children_ids: ["l1"] });
    await saveGoal({ id: "l1", node_type: "subgoal", parent_id: "l0", decomposition_depth: 1, children_ids: ["l2"] });
    await saveGoal({ id: "l2", node_type: "subgoal", parent_id: "l1", decomposition_depth: 2, children_ids: ["l3"] });
    await saveGoal({ id: "l3", node_type: "subgoal", parent_id: "l2", decomposition_depth: 3, children_ids: ["l4"] });
    await saveGoal({ id: "l4", node_type: "leaf", parent_id: "l3", decomposition_depth: 4 });

    const result = await orchestrator.selectNextNode("l0");
    expect(result).toBe("l4");
  });

  it("root with no children (non-leaf): root itself is selected", async () => {
    await saveGoal({ id: "root", node_type: "goal" });
    const result = await orchestrator.selectNextNode("root");
    expect(result).toBe("root");
  });

  it("startTreeExecution resets all node loop_status to idle", async () => {
    await saveGoal({ id: "root", children_ids: ["c1", "c2"] });
    await saveGoal({ id: "c1", parent_id: "root", loop_status: "running" });
    await saveGoal({ id: "c2", parent_id: "root", loop_status: "paused" });

    await orchestrator.startTreeExecution("root", DEFAULT_CONFIG);

    expect((await stateManager.loadGoal("c1"))?.loop_status).toBe("idle");
    expect((await stateManager.loadGoal("c2"))?.loop_status).toBe("idle");
  });

  it("startTreeExecution saves config used by selectNextNode", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "root" });

    await orchestrator.startTreeExecution("root", { ...DEFAULT_CONFIG, parallel_loop_limit: 1 });

    const first = await orchestrator.selectNextNode("root");
    expect(first).not.toBeNull();

    // Second call should return null since limit=1 already reached
    const second = await orchestrator.selectNextNode("root");
    expect(second).toBeNull();
  });

  it("startTreeExecution on non-existent root is safe (no throw)", async () => {
    await expect(
      orchestrator.startTreeExecution("no-such-root", DEFAULT_CONFIG)
    ).resolves.not.toThrow();
  });

  it("tree with cancelled and waiting nodes: only active idle selected", async () => {
    await saveGoal({
      id: "root",
      node_type: "goal",
      children_ids: ["c1", "c2", "c3"],
    });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", status: "cancelled" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", status: "waiting" });
    await saveGoal({ id: "c3", node_type: "leaf", parent_id: "root", status: "active" });

    const result = await orchestrator.selectNextNode("root");
    expect(result).toBe("c3");
  });

  it("3-sibling tree: two complete, one remaining — root not completed yet", async () => {
    await saveGoal({ id: "root", status: "active", children_ids: ["c1", "c2", "c3"] });
    await saveGoal({ id: "c1", node_type: "leaf", parent_id: "root", status: "completed" });
    await saveGoal({ id: "c2", node_type: "leaf", parent_id: "root", status: "completed" });
    await saveGoal({ id: "c3", node_type: "leaf", parent_id: "root", status: "active", loop_status: "running" });

    orchestrator.onNodeCompleted("c2"); // c2 was already completed but we call it
    const root = await stateManager.loadGoal("root");
    // c3 is still active → root not completed
    expect(root?.status).not.toBe("completed");
  });

  it("completing a leaf with no parent: no aggregation, no crash", async () => {
    await saveGoal({ id: "orphan", node_type: "leaf", parent_id: null, loop_status: "running" });
    await expect(orchestrator.onNodeCompleted("orphan")).resolves.not.toThrow();
    expect((await stateManager.loadGoal("orphan"))?.loop_status).toBe("idle");
  });

  it("multiple consecutive completions: each resets loop_status to idle", async () => {
    await saveGoal({ id: "g1", node_type: "leaf", loop_status: "running" });
    await saveGoal({ id: "g2", node_type: "leaf", loop_status: "running" });

    await orchestrator.onNodeCompleted("g1");
    await orchestrator.onNodeCompleted("g2");

    expect((await stateManager.loadGoal("g1"))?.loop_status).toBe("idle");
    expect((await stateManager.loadGoal("g2"))?.loop_status).toBe("idle");
  });

  it("two branches: completing one branch does not affect the other", async () => {
    await saveGoal({ id: "root", status: "active", children_ids: ["branch1", "branch2"] });
    await saveGoal({ id: "branch1", parent_id: "root", status: "active", children_ids: ["leaf1"] });
    await saveGoal({ id: "branch2", parent_id: "root", status: "active", children_ids: ["leaf2"] });
    await saveGoal({ id: "leaf1", node_type: "leaf", parent_id: "branch1", status: "active", loop_status: "running" });
    await saveGoal({ id: "leaf2", node_type: "leaf", parent_id: "branch2", status: "active" });

    await stateManager.saveGoal({ ...await stateManager.loadGoal("leaf1")!, status: "completed" });
    await orchestrator.onNodeCompleted("leaf1");

    // branch1 completed, but branch2 and root should not be
    expect((await stateManager.loadGoal("branch1"))?.status).toBe("completed");
    expect((await stateManager.loadGoal("branch2"))?.status).not.toBe("completed");
    expect((await stateManager.loadGoal("root"))?.status).not.toBe("completed");
  });

  it("does not select nodes from unrelated trees", async () => {
    // Tree A
    await saveGoal({ id: "rootA", children_ids: ["leafA"] });
    await saveGoal({ id: "leafA", node_type: "leaf", parent_id: "rootA" });

    // Tree B (separate)
    await saveGoal({ id: "rootB", children_ids: ["leafB"] });
    await saveGoal({ id: "leafB", node_type: "leaf", parent_id: "rootB" });

    const resultA = await orchestrator.selectNextNode("rootA");
    const resultB = await orchestrator.selectNextNode("rootB");

    // Each call should select from its own tree
    expect(resultA).toBe("leafA");
    expect(resultB).toBe("leafB");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. GOAL REFINER INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════════════

describe("ensureGoalRefined — GoalRefiner integration", () => {
  it("calls refiner.refine() when GoalRefiner is provided and goal has no children or validated dimensions", async () => {
    const mockRefiner = {
      refine: vi.fn().mockResolvedValue({ goal: {}, leaf: true, children: null, feasibility: null, tokensUsed: 0, reason: "measurable" }),
      reRefineLeaf: vi.fn(),
    } as unknown as GoalRefiner;

    const orchestratorWithRefiner = new TreeLoopOrchestrator(
      stateManager,
      goalTreeManager,
      stateAggregator,
      satisficingJudge,
      mockRefiner
    );

    // Goal with manual dimension (not validated) and no children
    const goal = await saveGoal({
      id: "unrefined-goal",
      node_type: "goal",
      children_ids: [],
      dimensions: [{
        name: "score",
        label: "Score",
        current_value: null,
        threshold: { type: "min", value: 100 },
        confidence: 0.5,
        observation_method: {
          type: "manual",
          source: "manual",
          schedule: null,
          endpoint: null,
          confidence_tier: "self_report",
        },
        last_updated: new Date().toISOString(),
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
        state_integrity: "ok",
        dimension_mapping: null,
      }],
    });

    await orchestratorWithRefiner.ensureGoalRefined(goal.id);

    expect(mockRefiner.refine).toHaveBeenCalledOnce();
    expect(mockRefiner.refine).toHaveBeenCalledWith(goal.id);
  });

  it("does NOT call refiner.refine() when goal already has children", async () => {
    const mockRefiner = {
      refine: vi.fn(),
      reRefineLeaf: vi.fn(),
    } as unknown as GoalRefiner;

    const orchestratorWithRefiner = new TreeLoopOrchestrator(
      stateManager,
      goalTreeManager,
      stateAggregator,
      satisficingJudge,
      mockRefiner
    );

    await saveGoal({ id: "child-1", node_type: "leaf" });
    await saveGoal({ id: "parent-goal", node_type: "goal", children_ids: ["child-1"] });

    await orchestratorWithRefiner.ensureGoalRefined("parent-goal");

    expect(mockRefiner.refine).not.toHaveBeenCalled();
  });

  it("does NOT call refiner.refine() when goal already has validated dimensions", async () => {
    const mockRefiner = {
      refine: vi.fn(),
      reRefineLeaf: vi.fn(),
    } as unknown as GoalRefiner;

    const orchestratorWithRefiner = new TreeLoopOrchestrator(
      stateManager,
      goalTreeManager,
      stateAggregator,
      satisficingJudge,
      mockRefiner
    );

    // Goal with mechanical (validated) dimension
    await saveGoal({
      id: "validated-goal",
      node_type: "goal",
      children_ids: [],
      dimensions: [makeDimension({
        observation_method: {
          type: "mechanical",
          source: "shell",
          schedule: null,
          endpoint: "npm test",
          confidence_tier: "mechanical",
        },
      })],
    });

    await orchestratorWithRefiner.ensureGoalRefined("validated-goal");

    expect(mockRefiner.refine).not.toHaveBeenCalled();
  });

  it("falls back to goalTreeManager.decomposeGoal() when GoalRefiner is NOT provided", async () => {
    // orchestrator without refiner (default in beforeEach)
    const decompSpy = vi.spyOn(goalTreeManager, "decomposeGoal").mockResolvedValue({
      parent_id: "unrefined-fallback",
      children: [],
      depth: 1,
      specificity_scores: {},
      reasoning: "mock decomposition",
    });

    await saveGoal({
      id: "unrefined-fallback",
      node_type: "goal",
      children_ids: [],
      dimensions: [makeDimension({
        observation_method: {
          type: "manual",
          source: "manual",
          schedule: null,
          endpoint: null,
          confidence_tier: "self_report",
        },
      })],
    });

    await orchestrator.ensureGoalRefined("unrefined-fallback");

    expect(decompSpy).toHaveBeenCalledOnce();
    expect(decompSpy).toHaveBeenCalledWith("unrefined-fallback", expect.any(Object));

    decompSpy.mockRestore();
  });

  it("falls back to decomposeGoal() when refiner.refine() throws", async () => {
    const mockRefiner = {
      refine: vi.fn().mockRejectedValue(new Error("refiner failure")),
      reRefineLeaf: vi.fn(),
    } as unknown as GoalRefiner;

    const orchestratorWithRefiner = new TreeLoopOrchestrator(
      stateManager,
      goalTreeManager,
      stateAggregator,
      satisficingJudge,
      mockRefiner
    );

    const decompSpy = vi.spyOn(goalTreeManager, "decomposeGoal").mockResolvedValue({
      parent_id: "fallback-on-error",
      children: [],
      depth: 1,
      specificity_scores: {},
      reasoning: "fallback mock",
    });

    await saveGoal({
      id: "fallback-on-error",
      node_type: "goal",
      children_ids: [],
      dimensions: [makeDimension({
        observation_method: {
          type: "manual",
          source: "manual",
          schedule: null,
          endpoint: null,
          confidence_tier: "self_report",
        },
      })],
    });

    // Should not throw even when refiner errors
    await expect(orchestratorWithRefiner.ensureGoalRefined("fallback-on-error")).resolves.toBeUndefined();
    expect(decompSpy).toHaveBeenCalledOnce();

    decompSpy.mockRestore();
  });

  it("is a no-op for a nonexistent goal", async () => {
    const mockRefiner = {
      refine: vi.fn(),
      reRefineLeaf: vi.fn(),
    } as unknown as GoalRefiner;

    const orchestratorWithRefiner = new TreeLoopOrchestrator(
      stateManager,
      goalTreeManager,
      stateAggregator,
      satisficingJudge,
      mockRefiner
    );

    await expect(orchestratorWithRefiner.ensureGoalRefined("does-not-exist")).resolves.toBeUndefined();
    expect(mockRefiner.refine).not.toHaveBeenCalled();
  });
});
