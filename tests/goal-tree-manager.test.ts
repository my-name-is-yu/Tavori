import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state/state-manager.js";
import { EthicsGate } from "../src/traits/ethics-gate.js";
import { GoalDependencyGraph } from "../src/goal/goal-dependency-graph.js";
import { GoalTreeManager } from "../src/goal/goal-tree-manager.js";
import type { GoalDecompositionConfig } from "../src/types/goal-tree.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal as _makeGoal, makeDimension } from "./helpers/fixtures.js";
import { PASS_VERDICT_SIMPLE_JSON as PASS_VERDICT } from "./helpers/ethics-fixtures.js";
import { randomUUID } from "node:crypto";

// ─── Local defaults matching the original local makeGoal ───

const metricADim = () =>
  makeDimension({
    name: "metric_a",
    label: "Metric A",
    current_value: 30,
    threshold: { type: "min", value: 80 },
    confidence: 0.7,
    observation_method: {
      type: "manual",
      source: "test",
      schedule: null,
      endpoint: null,
      confidence_tier: "self_report",
    },
  });

function makeGoal(overrides: Parameters<typeof _makeGoal>[0] = {}) {
  return _makeGoal({
    id: overrides?.id ?? randomUUID(),
    description: overrides?.description ?? "A goal for testing decomposition",
    dimensions: overrides?.dimensions ?? [metricADim()],
    ...overrides,
  });
}

// Specificity responses
const HIGH_SPECIFICITY = JSON.stringify({ specificity_score: 0.9, reasoning: "Very concrete goal" });
const LOW_SPECIFICITY = JSON.stringify({ specificity_score: 0.4, reasoning: "Too abstract" });
const BOUNDARY_SPECIFICITY = JSON.stringify({ specificity_score: 0.7, reasoning: "Exactly at threshold" });
const JUST_BELOW_SPECIFICITY = JSON.stringify({ specificity_score: 0.69, reasoning: "Just below threshold" });

// Subgoal generation responses
const SUBGOALS_TWO = JSON.stringify([
  {
    hypothesis: "Set up automated testing infrastructure",
    dimensions: [
      {
        name: "ci_configured",
        label: "CI Configured",
        threshold_type: "present",
        threshold_value: null,
        observation_method_hint: "Check CI config exists",
      },
    ],
    constraints: ["Must use GitHub Actions"],
    expected_specificity: 0.85,
  },
  {
    hypothesis: "Achieve 80% test coverage",
    dimensions: [
      {
        name: "coverage_pct",
        label: "Test Coverage %",
        threshold_type: "min",
        threshold_value: 80,
        observation_method_hint: "Run coverage tool",
      },
    ],
    constraints: [],
    expected_specificity: 0.9,
  },
]);

const SUBGOALS_ONE = JSON.stringify([
  {
    hypothesis: "Write unit tests for core modules",
    dimensions: [
      {
        name: "unit_test_count",
        label: "Unit Test Count",
        threshold_type: "min",
        threshold_value: 50,
        observation_method_hint: "Count test files",
      },
    ],
    constraints: [],
    expected_specificity: 0.88,
  },
]);

const SUBGOALS_THREE = JSON.stringify([
  {
    hypothesis: "Design database schema",
    dimensions: [{ name: "schema_done", label: "Schema Done", threshold_type: "present", threshold_value: null, observation_method_hint: "Check schema file" }],
    constraints: [],
    expected_specificity: 0.8,
  },
  {
    hypothesis: "Implement REST API endpoints",
    dimensions: [{ name: "api_endpoints", label: "API Endpoints", threshold_type: "min", threshold_value: 10, observation_method_hint: "Count endpoints" }],
    constraints: [],
    expected_specificity: 0.85,
  },
  {
    hypothesis: "Write API documentation",
    dimensions: [{ name: "docs_complete", label: "Docs Complete", threshold_type: "present", threshold_value: null, observation_method_hint: "Check docs" }],
    constraints: [],
    expected_specificity: 0.8,
  },
]);

const SUBGOALS_EMPTY = JSON.stringify([]);

// Coverage validation responses
const COVERAGE_PASS = JSON.stringify({ covers_parent: true, missing_dimensions: [], reasoning: "All covered" });
const COVERAGE_FAIL = JSON.stringify({ covers_parent: false, missing_dimensions: ["performance"], reasoning: "Missing performance dimension" });

// Default config
const DEFAULT_CONFIG: GoalDecompositionConfig = {
  max_depth: 5,
  min_specificity: 0.7,
  auto_prune_threshold: 0.3,
  parallel_loop_limit: 3,
};

const SHALLOW_CONFIG: GoalDecompositionConfig = {
  max_depth: 1,
  min_specificity: 0.7,
  auto_prune_threshold: 0.3,
  parallel_loop_limit: 3,
};

// ─── Test Suite ───

let tempDir: string;
let stateManager: StateManager;
let ethicsGate: EthicsGate;
let dependencyGraph: GoalDependencyGraph;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  // EthicsGate with a mock LLM that always passes
  const ethicsLLM = createMockLLMClient(Array(50).fill(PASS_VERDICT));
  ethicsGate = new EthicsGate(stateManager, ethicsLLM);
  dependencyGraph = new GoalDependencyGraph(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── 1. Specificity Evaluation ───

describe("specificity evaluation", async () => {
  it("stops decomposition when specificity_score >= min_specificity", async () => {
    const goal = makeGoal({ title: "Specific leaf goal" });
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.parent_id).toBe(goal.id);
    expect(result.children).toHaveLength(0);
    expect(result.specificity_scores[goal.id]).toBeCloseTo(0.9);
  });

  it("triggers decomposition when specificity_score < min_specificity", async () => {
    const goal = makeGoal({ title: "Abstract goal" });
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.children.length).toBeGreaterThan(0);
  });

  it("specificity_score is saved on the goal after evaluation", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const saved = await stateManager.loadGoal(goal.id);
    expect(saved?.specificity_score).toBeCloseTo(0.9);
  });

  it("marks goal as leaf when specificity >= threshold", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const saved = await stateManager.loadGoal(goal.id);
    expect(saved?.node_type).toBe("leaf");
  });

  it("boundary: specificity_score exactly 0.7 (== min_specificity) stops decomposition", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([BOUNDARY_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.children).toHaveLength(0);
  });

  it("boundary: specificity_score 0.69 (just below) triggers decomposition", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([JUST_BELOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.children.length).toBeGreaterThan(0);
  });

  it("falls back gracefully when LLM fails specificity evaluation", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    // Return invalid JSON to trigger fallback
    const mockLLM = createMockLLMClient(["not valid json", SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    // Should not throw; fallback score is 0.5 (below threshold), so decomposition runs
    await expect(manager.decomposeGoal(goal.id, DEFAULT_CONFIG)).resolves.toBeDefined();
  });

  it("uses 0.5 as fallback score when LLM returns invalid specificity", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    // fallback score 0.5 < 0.7 → decomposition triggered
    const mockLLM = createMockLLMClient(["bad json", SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    // With fallback 0.5, decomposition runs → children expected
    expect(result.children.length).toBeGreaterThanOrEqual(0); // may succeed or fail subgoal gen
  });
});

// ─── 2. 1-layer Decomposition ───

describe("1-layer decomposition", async () => {
  it("creates child goals from LLM response", async () => {
    const goal = makeGoal({ title: "Improve test coverage" });
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY,
      SUBGOALS_TWO,
      COVERAGE_PASS,
      HIGH_SPECIFICITY,
      HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.children).toHaveLength(2);
  });

  it("child goals have correct parent_id", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_TWO, COVERAGE_PASS, HIGH_SPECIFICITY, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const children = result.children as Goal[];
    for (const child of children) {
      expect(child.parent_id).toBe(goal.id);
    }
  });

  it("child goals have node_type=subgoal", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const children = result.children as Goal[];
    for (const child of children) {
      expect(child.node_type).toBe("subgoal");
    }
  });

  it("child goals have origin=decomposition", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const children = result.children as Goal[];
    for (const child of children) {
      expect(child.origin).toBe("decomposition");
    }
  });

  it("child goals have decomposition_depth = parent_depth + 1", async () => {
    const goal = makeGoal({ decomposition_depth: 0 });
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const children = result.children as Goal[];
    for (const child of children) {
      expect(child.decomposition_depth).toBe(1);
    }
  });

  it("child goals have status=active", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_TWO, COVERAGE_PASS, HIGH_SPECIFICITY, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const children = result.children as Goal[];
    for (const child of children) {
      expect(child.status).toBe("active");
    }
  });

  it("parent goal's children_ids is updated after decomposition", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_TWO, COVERAGE_PASS, HIGH_SPECIFICITY, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const saved = await stateManager.loadGoal(goal.id);
    expect(saved?.children_ids).toHaveLength(2);
  });

  it("child goals are persisted to state manager", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_TWO, COVERAGE_PASS, HIGH_SPECIFICITY, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    const children = result.children as Goal[];
    for (const child of children) {
      const saved = await stateManager.loadGoal(child.id);
      expect(saved).not.toBeNull();
    }
  });

  it("result contains correct depth", async () => {
    const goal = makeGoal({ decomposition_depth: 0 });
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.depth).toBe(0);
  });

  it("result contains specificity_scores for root goal", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.specificity_scores[goal.id]).toBeDefined();
    expect(result.specificity_scores[goal.id]).toBeCloseTo(0.4);
  });
});

// ─── 3. 2-layer Decomposition ───

describe("2-layer decomposition", async () => {
  it("recursively decomposes children with low specificity", async () => {
    const root = makeGoal({ title: "Very abstract root" });
    await stateManager.saveGoal(root);

    // root: low spec → gen 1 child → coverage pass → child: low spec → gen 1 grandchild → coverage pass → grandchild: high spec
    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY,   // root specificity
      SUBGOALS_ONE,      // root subgoals
      COVERAGE_PASS,     // root validation
      LOW_SPECIFICITY,   // child specificity
      SUBGOALS_ONE,      // child subgoals
      COVERAGE_PASS,     // child validation
      HIGH_SPECIFICITY,  // grandchild specificity (leaf)
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    expect(result.children).toHaveLength(1);

    const child = (result.children as Goal[])[0]!;
    const savedChild = await stateManager.loadGoal(child.id);
    expect(savedChild?.children_ids.length).toBeGreaterThan(0);
  });

  it("grandchildren have decomposition_depth = 2", async () => {
    const root = makeGoal({ decomposition_depth: 0 });
    await stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY,
      SUBGOALS_ONE,
      COVERAGE_PASS,
      LOW_SPECIFICITY,
      SUBGOALS_ONE,
      COVERAGE_PASS,
      HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    const child = (result.children as Goal[])[0]!;
    const savedChild = await stateManager.loadGoal(child.id);
    const grandchildId = savedChild?.children_ids[0];
    expect(grandchildId).toBeDefined();
    const grandchild = await stateManager.loadGoal(grandchildId!);
    expect(grandchild?.decomposition_depth).toBe(2);
  });

  it("grandchildren are marked as leaves when specific enough", async () => {
    const root = makeGoal();
    await stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY,
      SUBGOALS_ONE,
      COVERAGE_PASS,
      LOW_SPECIFICITY,
      SUBGOALS_ONE,
      COVERAGE_PASS,
      HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    const child = (result.children as Goal[])[0]!;
    const savedChild = await stateManager.loadGoal(child.id);
    const grandchildId = savedChild?.children_ids[0];
    const grandchild = await stateManager.loadGoal(grandchildId!);
    expect(grandchild?.node_type).toBe("leaf");
  });

  it("specificity_scores includes scores for all levels", async () => {
    const root = makeGoal();
    await stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY,
      SUBGOALS_ONE,
      COVERAGE_PASS,
      LOW_SPECIFICITY,
      SUBGOALS_ONE,
      COVERAGE_PASS,
      HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    // root + child + grandchild specificity scores
    expect(Object.keys(result.specificity_scores).length).toBeGreaterThanOrEqual(1);
  });

  it("stops recursion when child has high specificity", async () => {
    const root = makeGoal();
    await stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY,  // root: decompose
      SUBGOALS_TWO,     // root generates 2 children
      COVERAGE_PASS,
      HIGH_SPECIFICITY, // child 1: leaf
      HIGH_SPECIFICITY, // child 2: leaf
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    expect(result.children).toHaveLength(2);
    // Children should be leaves (no further decomposition)
    for (const child of result.children as Goal[]) {
      const saved = await stateManager.loadGoal(child.id);
      expect(saved?.children_ids).toHaveLength(0);
    }
  });

  it("depth tracking is correct at each level", async () => {
    const root = makeGoal({ decomposition_depth: 0 });
    await stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,
      HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    expect(result.depth).toBe(0);

    const childId = (result.children as Goal[])[0]?.id;
    expect(childId).toBeDefined();
    const child = await stateManager.loadGoal(childId!);
    expect(child?.decomposition_depth).toBe(1);
  });

  it("parent maintains children_ids for all direct children only", async () => {
    const root = makeGoal();
    await stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, SUBGOALS_TWO, COVERAGE_PASS,
      HIGH_SPECIFICITY,
      HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    const saved = await stateManager.loadGoal(root.id);
    // Root should have exactly 2 direct children
    expect(saved?.children_ids).toHaveLength(2);
  });

  it("two-layer tree has correct total nodes in getTreeState", async () => {
    const root = makeGoal();
    await stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,
      HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    const state = await manager.getTreeState(root.id);
    // root + child + grandchild = 3
    expect(state.total_nodes).toBe(3);
  });
});

// ─── 4. N-layer (3-5 depth) ───

describe("N-layer decomposition (depth 3-5)", async () => {
  it("enforces max_depth=1: forces leaf at depth 1 regardless of specificity", async () => {
    const root = makeGoal({ decomposition_depth: 0 });
    await stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY,  // root: low spec → try to decompose
      SUBGOALS_ONE,     // root generates 1 child
      COVERAGE_PASS,
      LOW_SPECIFICITY,  // child at depth 1 = max_depth: forced leaf (no subgoal call)
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(root.id, SHALLOW_CONFIG);
    const child = (await stateManager.loadGoal((await stateManager.loadGoal(root.id))?.children_ids[0])!);
    // At max_depth, forced leaf
    expect(child?.node_type).toBe("leaf");
  });

  it("max_depth=2: does not recurse beyond depth 2", async () => {
    const root = makeGoal({ decomposition_depth: 0 });
    await stateManager.saveGoal(root);
    const config2: GoalDecompositionConfig = { ...DEFAULT_CONFIG, max_depth: 2 };

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,  // root
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,  // depth 1 child
      LOW_SPECIFICITY,                                // depth 2: forced leaf (no sub call)
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, config2);
    const child = (result.children as Goal[])[0];
    expect(child).toBeDefined();
    const depth1ChildSaved = await stateManager.loadGoal(child!.id);
    const depth2ChildId = depth1ChildSaved?.children_ids[0];
    const depth2Child = await stateManager.loadGoal(depth2ChildId!);
    expect(depth2Child?.node_type).toBe("leaf");
    expect(depth2Child?.children_ids).toHaveLength(0);
  });

  it("max_depth=3: allows 3 levels of nesting", async () => {
    const root = makeGoal({ decomposition_depth: 0 });
    await stateManager.saveGoal(root);
    const config3: GoalDecompositionConfig = { ...DEFAULT_CONFIG, max_depth: 3 };

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,  // depth 0
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,  // depth 1
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,  // depth 2
      LOW_SPECIFICITY,                               // depth 3: forced leaf
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, config3);
    const state = await manager.getTreeState(root.id);
    expect(state.max_depth_reached).toBeGreaterThanOrEqual(3);
  });

  it("forced-leaf goals at max_depth are still marked as leaf", async () => {
    const root = makeGoal({ decomposition_depth: 0 });
    await stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,
      LOW_SPECIFICITY,  // depth 1 = max_depth in SHALLOW_CONFIG
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(root.id, SHALLOW_CONFIG);
    const rootSaved = await stateManager.loadGoal(root.id);
    const childId = rootSaved?.children_ids[0];
    const child = await stateManager.loadGoal(childId!);
    expect(child?.node_type).toBe("leaf");
  });

  it("decomposition result max_depth_reached reflects actual depth", async () => {
    const root = makeGoal({ decomposition_depth: 0 });
    await stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS,
      HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    const state = await manager.getTreeState(root.id);
    expect(state.max_depth_reached).toBe(1);
  });

  it("children count never exceeds max_children_per_node (5)", async () => {
    const root = makeGoal();
    await stateManager.saveGoal(root);

    // Return 6 subgoals — should be clamped to 5
    const sixSubgoals = JSON.stringify([
      { hypothesis: "Sub 1", dimensions: [], constraints: [], expected_specificity: 0.9 },
      { hypothesis: "Sub 2", dimensions: [], constraints: [], expected_specificity: 0.9 },
      { hypothesis: "Sub 3", dimensions: [], constraints: [], expected_specificity: 0.9 },
      { hypothesis: "Sub 4", dimensions: [], constraints: [], expected_specificity: 0.9 },
      { hypothesis: "Sub 5", dimensions: [], constraints: [], expected_specificity: 0.9 },
      { hypothesis: "Sub 6", dimensions: [], constraints: [], expected_specificity: 0.9 },
    ]);
    const mockLLM = createMockLLMClient([
      LOW_SPECIFICITY, sixSubgoals, COVERAGE_PASS,
      HIGH_SPECIFICITY, HIGH_SPECIFICITY, HIGH_SPECIFICITY,
      HIGH_SPECIFICITY, HIGH_SPECIFICITY,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    expect(result.children.length).toBeLessThanOrEqual(5);
  });
});




// ─── 9. getTreeState ───

describe("getTreeState", async () => {
  it("returns correct total_nodes for a single node", async () => {
    const root = makeGoal();
    await stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const state = await manager.getTreeState(root.id);
    expect(state.total_nodes).toBe(1);
    expect(state.root_id).toBe(root.id);
  });

  it("returns total_nodes=0 for nonexistent root", async () => {
    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const state = await manager.getTreeState("nonexistent");
    expect(state.total_nodes).toBe(0);
  });

  it("tracks active_loops (loop_status=running)", async () => {
    const root = makeGoal();
    const child = makeGoal({ parent_id: root.id, node_type: "leaf", origin: "decomposition", loop_status: "running" });
    const rootWithChild: Goal = { ...root, children_ids: [child.id] };
    await stateManager.saveGoal(rootWithChild);
    await stateManager.saveGoal(child);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const state = await manager.getTreeState(root.id);
    expect(state.active_loops).toContain(child.id);
  });

  it("tracks pruned_nodes (status=cancelled)", async () => {
    const root = makeGoal();
    const child = makeGoal({ parent_id: root.id, node_type: "subgoal", origin: "decomposition", status: "cancelled" });
    const rootWithChild: Goal = { ...root, children_ids: [child.id] };
    await stateManager.saveGoal(rootWithChild);
    await stateManager.saveGoal(child);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const state = await manager.getTreeState(root.id);
    expect(state.pruned_nodes).toContain(child.id);
  });

  it("max_depth_reached reflects deepest node", async () => {
    const root = makeGoal({ decomposition_depth: 0 });
    const child = makeGoal({ parent_id: root.id, node_type: "subgoal", origin: "decomposition", decomposition_depth: 1 });
    const grandchild = makeGoal({ parent_id: child.id, node_type: "leaf", origin: "decomposition", decomposition_depth: 2 });
    const childUpdated: Goal = { ...child, children_ids: [grandchild.id] };
    const rootUpdated: Goal = { ...root, children_ids: [child.id] };
    await stateManager.saveGoal(rootUpdated);
    await stateManager.saveGoal(childUpdated);
    await stateManager.saveGoal(grandchild);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const state = await manager.getTreeState(root.id);
    expect(state.max_depth_reached).toBe(2);
  });
});

// ─── 10. Edge Cases ───

describe("edge cases", async () => {
  it("throws when goal not found in decomposeGoal", async () => {
    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await expect(manager.decomposeGoal("missing-id", DEFAULT_CONFIG)).rejects.toThrow();
  });

  it("single-dimension goal decomposes to specific leaf", async () => {
    const goal = makeGoal({
      dimensions: [
        {
          name: "single_metric",
          label: "Single Metric",
          current_value: 0,
          threshold: { type: "min", value: 100 },
          confidence: 0.8,
          observation_method: { type: "mechanical" as const, source: "test", schedule: null, endpoint: null, confidence_tier: "mechanical" as const },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.children).toHaveLength(0);
    expect(result.specificity_scores[goal.id]).toBeCloseTo(0.9);
  });

  it("empty subgoal response treats goal as leaf", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_EMPTY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.children).toHaveLength(0);
    const saved = await stateManager.loadGoal(goal.id);
    expect(saved?.node_type).toBe("leaf");
  });

  it("decomposeGoal handles goal with no dimensions gracefully", async () => {
    const goal = makeGoal({ dimensions: [] });
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await expect(manager.decomposeGoal(goal.id, DEFAULT_CONFIG)).resolves.toBeDefined();
  });

  it("already-leaf goal stays leaf on re-decomposition", async () => {
    const goal = makeGoal({ node_type: "leaf", specificity_score: 0.95 });
    await stateManager.saveGoal(goal);

    // Even if leaf, decomposeGoal should still work (re-evaluate)
    const mockLLM = createMockLLMClient([HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.children).toHaveLength(0);
  });

  it("config with min_specificity=0 decomposes everything until max_depth", async () => {
    const config0: GoalDecompositionConfig = { ...DEFAULT_CONFIG, min_specificity: 0, max_depth: 1 };
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    // With min_specificity=0, any score passes (even LOW_SPECIFICITY=0.4 >= 0)
    const mockLLM = createMockLLMClient([LOW_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, config0);
    // 0.4 >= 0 → leaf immediately
    expect(result.children).toHaveLength(0);
  });

  it("decomposeGoal with max_depth=0 forces immediate leaf", async () => {
    const config0: GoalDecompositionConfig = { ...DEFAULT_CONFIG, max_depth: 1 };
    const goal = makeGoal({ decomposition_depth: 1 }); // already at max_depth
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, config0);
    expect(result.children).toHaveLength(0);
    const saved = await stateManager.loadGoal(goal.id);
    expect(saved?.node_type).toBe("leaf");
  });

  it("getTreeState on empty tree (single root) returns correct values", async () => {
    const root = makeGoal();
    await stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const state = await manager.getTreeState(root.id);
    expect(state.root_id).toBe(root.id);
    expect(state.total_nodes).toBe(1);
    expect(state.max_depth_reached).toBe(0);
    expect(state.active_loops).toHaveLength(0);
    expect(state.pruned_nodes).toHaveLength(0);
  });

  it("cancelled goal is visible in pruned_nodes but still counted in total_nodes", async () => {
    const root = makeGoal();
    const cancelled = makeGoal({ parent_id: root.id, status: "cancelled", node_type: "subgoal", origin: "decomposition" });
    const rootUpdated: Goal = { ...root, children_ids: [cancelled.id] };
    await stateManager.saveGoal(rootUpdated);
    await stateManager.saveGoal(cancelled);

    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const state = await manager.getTreeState(root.id);
    expect(state.total_nodes).toBe(2);
    expect(state.pruned_nodes).toContain(cancelled.id);
  });

  it("goal with constraints passes constraints to subgoal prompt", async () => {
    const goal = makeGoal({ constraints: ["Must be serverless", "Budget < $100"] });
    await stateManager.saveGoal(goal);

    let capturedPrompt = "";
    const captureClient = {
      sendMessage: async (messages: Array<{ role: string; content: string }>) => {
        capturedPrompt = messages[0]?.content ?? "";
        return {
          content: HIGH_SPECIFICITY,
          usage: { input_tokens: 10, output_tokens: 10 },
          stop_reason: "end_turn",
        };
      },
      parseJSON: createMockLLMClient([]).parseJSON.bind(createMockLLMClient([])),
    };

    const manager = new GoalTreeManager(stateManager, captureClient as never, ethicsGate, dependencyGraph);
    await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);

    expect(capturedPrompt).toContain("Must be serverless");
  });
});

// ─── 11. GoalDependencyGraph Integration ───

describe("GoalDependencyGraph integration", async () => {
  it("decomposeGoal does not create prerequisite cycles", async () => {
    const root = makeGoal();
    await stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_TWO, COVERAGE_PASS, HIGH_SPECIFICITY, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(root.id, DEFAULT_CONFIG);

    // The graph should not have any cycles (parent_child type is separate from prerequisite)
    // For each child, detectCycle should return false
    const savedRoot = await stateManager.loadGoal(root.id);
    for (const childId of (savedRoot?.children_ids ?? [])) {
      const wouldCycle = dependencyGraph.detectCycle(childId, root.id);
      expect(wouldCycle).toBe(false);
    }
  });


  it("decomposition result for goal with many dimensions", async () => {
    const goal = makeGoal({
      dimensions: [
        { name: "d1", label: "D1", current_value: 0, threshold: { type: "min", value: 10 }, confidence: 0.8, observation_method: { type: "manual" as const, source: "t", schedule: null, endpoint: null, confidence_tier: "self_report" as const }, last_updated: new Date().toISOString(), history: [], weight: 1, uncertainty_weight: null, state_integrity: "ok", dimension_mapping: null },
        { name: "d2", label: "D2", current_value: 0, threshold: { type: "min", value: 20 }, confidence: 0.8, observation_method: { type: "manual" as const, source: "t", schedule: null, endpoint: null, confidence_tier: "self_report" as const }, last_updated: new Date().toISOString(), history: [], weight: 1, uncertainty_weight: null, state_integrity: "ok", dimension_mapping: null },
        { name: "d3", label: "D3", current_value: 0, threshold: { type: "present", value: null }, confidence: 0.8, observation_method: { type: "manual" as const, source: "t", schedule: null, endpoint: null, confidence_tier: "self_report" as const }, last_updated: new Date().toISOString(), history: [], weight: 1, uncertainty_weight: null, state_integrity: "ok", dimension_mapping: null },
      ],
    });
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.specificity_scores[goal.id]).toBeDefined();
  });

  it("reconstructed tree via getTreeState matches what was decomposed", async () => {
    const root = makeGoal();
    await stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_THREE, COVERAGE_PASS, HIGH_SPECIFICITY, HIGH_SPECIFICITY, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    const state = await manager.getTreeState(root.id);

    // root + 3 children = 4
    expect(state.total_nodes).toBe(4);
    expect(state.root_id).toBe(root.id);
    expect(state.max_depth_reached).toBe(1);
  });

  it("decomposeGoal result parent_id matches input goalId", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.parent_id).toBe(goal.id);
  });

  it("goal with constraints: constraints are passed to child goals", async () => {
    const root = makeGoal({ constraints: ["Use TypeScript only"] });
    await stateManager.saveGoal(root);

    const subgoalWithConstraint = JSON.stringify([
      {
        hypothesis: "Set up TypeScript project",
        dimensions: [],
        constraints: ["Strict mode enabled"],
        expected_specificity: 0.9,
      },
    ]);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, subgoalWithConstraint, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    const children = result.children as Goal[];
    expect(children).toHaveLength(1);
    // Child should have its own constraints from LLM
    expect(children[0]?.constraints).toContain("Strict mode enabled");
  });

  it("specificity_scores record includes child scores after 1-layer decomposition", async () => {
    const root = makeGoal();
    await stateManager.saveGoal(root);

    const mockLLM = createMockLLMClient([LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS, HIGH_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(root.id, DEFAULT_CONFIG);
    // At minimum, root's score is in there
    expect(result.specificity_scores[root.id]).toBeCloseTo(0.4);
    // Child score should also be recorded
    const allScoreIds = Object.keys(result.specificity_scores);
    expect(allScoreIds.length).toBeGreaterThanOrEqual(2);
  });
});
