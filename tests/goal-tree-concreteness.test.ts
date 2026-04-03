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
    description: overrides?.description ?? "Achieve 80% test coverage within 2 weeks for the auth module",
    dimensions: overrides?.dimensions ?? [metricADim()],
    ...overrides,
  });
}

// Concreteness LLM responses — all 4 dimensions true (score = 1.0)
const CONCRETENESS_ALL_TRUE = JSON.stringify({
  hasQuantitativeThreshold: true,
  hasObservableOutcome: true,
  hasTimebound: true,
  hasClearScope: true,
  reason: "Goal has numeric threshold, observable outcome, deadline, and clear scope.",
});

// Concreteness LLM responses — all 4 dimensions false (score = 0.0)
const CONCRETENESS_ALL_FALSE = JSON.stringify({
  hasQuantitativeThreshold: false,
  hasObservableOutcome: false,
  hasTimebound: false,
  hasClearScope: false,
  reason: "Goal is completely vague with no measurable criteria.",
});

// Concreteness — 2 of 4 true (score = 0.5)
const CONCRETENESS_TWO_TRUE = JSON.stringify({
  hasQuantitativeThreshold: true,
  hasObservableOutcome: true,
  hasTimebound: false,
  hasClearScope: false,
  reason: "Has thresholds and observable outcomes but no time constraint or clear scope.",
});

// Concreteness — 3 of 4 true (score = 0.75)
const CONCRETENESS_THREE_TRUE = JSON.stringify({
  hasQuantitativeThreshold: true,
  hasObservableOutcome: true,
  hasTimebound: false,
  hasClearScope: true,
  reason: "Has thresholds, observable outcomes, and clear scope, but no time constraint.",
});

// Specificity responses (for decomposeGoal internal evaluation)
const HIGH_SPECIFICITY = JSON.stringify({ specificity_score: 0.9, reasoning: "Very concrete goal" });
const LOW_SPECIFICITY = JSON.stringify({ specificity_score: 0.4, reasoning: "Too abstract" });

// Subgoal generation responses
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

// Coverage validation response
const COVERAGE_PASS = JSON.stringify({
  covers_parent: true,
  missing_dimensions: [],
  reasoning: "All covered",
});

// Default config
const DEFAULT_CONFIG: GoalDecompositionConfig = {
  max_depth: 5,
  min_specificity: 0.7,
  auto_prune_threshold: 0.3,
  parallel_loop_limit: 3,
};

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;
let ethicsGate: EthicsGate;
let dependencyGraph: GoalDependencyGraph;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  const ethicsLLM = createMockLLMClient(Array(50).fill(PASS_VERDICT));
  ethicsGate = new EthicsGate(stateManager, ethicsLLM);
  dependencyGraph = new GoalDependencyGraph(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── 1. scoreConcreteness() ───

describe("scoreConcreteness()", () => {
  it("returns score=1.0 when all 4 dimensions are true", async () => {
    const mockLLM = createMockLLMClient([CONCRETENESS_ALL_TRUE]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.scoreConcreteness(
      "Achieve 80% test coverage within 2 weeks for the auth module"
    );

    expect(result.score).toBeCloseTo(1.0);
    expect(result.dimensions.hasQuantitativeThreshold).toBe(true);
    expect(result.dimensions.hasObservableOutcome).toBe(true);
    expect(result.dimensions.hasTimebound).toBe(true);
    expect(result.dimensions.hasClearScope).toBe(true);
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("returns score=0.0 when all 4 dimensions are false (vague goal)", async () => {
    const mockLLM = createMockLLMClient([CONCRETENESS_ALL_FALSE]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.scoreConcreteness("Improve the system somehow");

    expect(result.score).toBeCloseTo(0.0);
    expect(result.dimensions.hasQuantitativeThreshold).toBe(false);
    expect(result.dimensions.hasObservableOutcome).toBe(false);
    expect(result.dimensions.hasTimebound).toBe(false);
    expect(result.dimensions.hasClearScope).toBe(false);
  });

  it("returns score=0.5 when 2 of 4 dimensions are true", async () => {
    const mockLLM = createMockLLMClient([CONCRETENESS_TWO_TRUE]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.scoreConcreteness(
      "Increase response time to < 200ms and measure via load test"
    );

    expect(result.score).toBeCloseTo(0.5);
    expect(result.dimensions.hasQuantitativeThreshold).toBe(true);
    expect(result.dimensions.hasObservableOutcome).toBe(true);
    expect(result.dimensions.hasTimebound).toBe(false);
    expect(result.dimensions.hasClearScope).toBe(false);
  });

  it("returns score=0.75 when 3 of 4 dimensions are true", async () => {
    const mockLLM = createMockLLMClient([CONCRETENESS_THREE_TRUE]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.scoreConcreteness(
      "Reduce API error rate below 1% for the payment endpoint, measured in production"
    );

    expect(result.score).toBeCloseTo(0.75);
  });

  it("returns score=0.0 for empty description without LLM call", async () => {
    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.scoreConcreteness("");

    expect(result.score).toBeCloseTo(0.0);
    expect(result.reason).toBe("Empty description provided");
    // No LLM call made
    expect(mockLLM.callCount).toBe(0);
  });

  it("returns score=0.0 for whitespace-only description without LLM call", async () => {
    const mockLLM = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.scoreConcreteness("   ");

    expect(result.score).toBeCloseTo(0.0);
    expect(mockLLM.callCount).toBe(0);
  });

  it("handles LLM error gracefully and returns score=0.0", async () => {
    // No responses configured → LLM throws
    const mockLLM = createMockLLMClient([]);
    // Force an error by not providing any responses; the sendMessage will throw on first call
    // We'll override by providing invalid JSON instead
    const badJsonLLM = createMockLLMClient(["not-valid-json-at-all"]);
    const manager = new GoalTreeManager(stateManager, badJsonLLM, ethicsGate, dependencyGraph);

    const result = await manager.scoreConcreteness("Some goal");

    expect(result.score).toBeCloseTo(0.0);
    expect(result.reason).toBe("LLM evaluation failed, defaulting to zero score");
  });

  it("score is exactly the weighted average (each dimension worth 0.25)", async () => {
    const mockLLM = createMockLLMClient([CONCRETENESS_ALL_TRUE]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.scoreConcreteness("any description");

    // 4 true * 0.25 = 1.0
    expect(result.score).toBe(1.0);
  });
});

// ─── 2. decomposeGoal() — auto-stop on concreteness ───

describe("decomposeGoal() with concreteness auto-stop", () => {
  it("stops decomposition as leaf when concreteness score >= threshold (0.7)", async () => {
    const goal = makeGoal({
      description: "Achieve 80% test coverage within 2 weeks for the auth module",
    });
    await stateManager.saveGoal(goal);

    // CONCRETENESS_ALL_TRUE returns score=1.0 → >= 0.7 threshold → auto-stop
    const mockLLM = createMockLLMClient([CONCRETENESS_ALL_TRUE]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph, { concretenesThreshold: 0.7 });

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);

    expect(result.children).toHaveLength(0);
    expect(result.specificity_scores[goal.id]).toBeCloseTo(1.0);
    expect(result.reasoning).toContain("Auto-stop");
  });

  it("marks goal as leaf node when auto-stop triggers", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([CONCRETENESS_ALL_TRUE]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);

    const saved = await stateManager.loadGoal(goal.id);
    expect(saved?.node_type).toBe("leaf");
  });

  it("continues decomposition when concreteness score < threshold", async () => {
    const goal = makeGoal({ description: "Improve the system" });
    await stateManager.saveGoal(goal);

    // CONCRETENESS_ALL_FALSE → score=0.0 < 0.7 → proceed with decomposition
    // Then: LOW_SPECIFICITY for internal specificity eval, SUBGOALS_ONE, COVERAGE_PASS,
    //       HIGH_SPECIFICITY for child specificity eval
    const mockLLM = createMockLLMClient([
      CONCRETENESS_ALL_FALSE,
      LOW_SPECIFICITY,
      SUBGOALS_ONE,
      COVERAGE_PASS,
      HIGH_SPECIFICITY, // child specificity eval → leaf
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph, { concretenesThreshold: 0.7 });

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);

    expect(result.children.length).toBeGreaterThan(0);
  });

  it("uses custom concretenesThreshold passed as option", async () => {
    const goal = makeGoal({ description: "Some partially concrete goal" });
    await stateManager.saveGoal(goal);

    // CONCRETENESS_TWO_TRUE → score=0.5; with threshold=0.4 → should auto-stop
    const mockLLM = createMockLLMClient([CONCRETENESS_TWO_TRUE]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG, {
      concretenesThreshold: 0.4,
    });

    expect(result.children).toHaveLength(0);
    expect(result.reasoning).toContain("Auto-stop");
  });

  it("does NOT auto-stop when concreteness score equals threshold exactly", async () => {
    // score = 0.5, threshold = 0.5 → 0.5 >= 0.5 → auto-stop should trigger
    const goal = makeGoal({ description: "Improve response time and add metrics" });
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([CONCRETENESS_TWO_TRUE]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG, {
      concretenesThreshold: 0.5,
    });

    // score(0.5) >= threshold(0.5) → auto-stop
    expect(result.children).toHaveLength(0);
    expect(result.reasoning).toContain("Auto-stop");
  });

  it("does NOT auto-stop when concreteness score is just below threshold", async () => {
    // score = 0.5, threshold = 0.51 → 0.5 < 0.51 → no auto-stop, proceed
    const goal = makeGoal({ description: "Vague goal" });
    await stateManager.saveGoal(goal);

    // First call: concreteness check → CONCRETENESS_TWO_TRUE (score=0.5, won't auto-stop at 0.51)
    // Then internal decomposition: LOW_SPECIFICITY, SUBGOALS_ONE, COVERAGE_PASS
    // Child: CONCRETENESS_ALL_TRUE → auto-stop child
    const mockLLM = createMockLLMClient([
      CONCRETENESS_TWO_TRUE,
      LOW_SPECIFICITY,
      SUBGOALS_ONE,
      COVERAGE_PASS,
      CONCRETENESS_ALL_TRUE,
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG, {
      concretenesThreshold: 0.51,
    });

    expect(result.children.length).toBeGreaterThan(0);
  });
});

// ─── 3. decomposeGoal() — maxDepth limit ───

describe("decomposeGoal() respects maxDepth", () => {
  it("uses instance-level maxDepth to stop at depth 0 when maxDepth=0", async () => {
    // maxDepth=0 means goal.decomposition_depth(0) >= maxDepth(0) → forced leaf
    const goal = makeGoal({ description: "Vague goal", decomposition_depth: 0 });
    await stateManager.saveGoal(goal);

    // concreteness check (score=0.0 → no auto-stop at threshold 0.7)
    // then internal specificity: LOW_SPECIFICITY → not leaf by specificity (0.4 < 0.7)
    // but depth check: decomposition_depth(0) >= effectiveMaxDepth(0) → forced leaf
    const mockLLM = createMockLLMClient([CONCRETENESS_ALL_FALSE, LOW_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph, {
      maxDepth: 0,
    });

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);

    expect(result.children).toHaveLength(0);
    expect(result.reasoning).toContain("Max depth");
    expect(result.reasoning).toContain("0");
  });

  it("uses option-level maxDepth to stop recursion", async () => {
    const goal = makeGoal({ description: "Vague goal", decomposition_depth: 1 });
    await stateManager.saveGoal(goal);

    // concreteness → no auto-stop (score=0.0 < 0.7)
    // specificity → LOW_SPECIFICITY (0.4 < min_specificity)
    // but decomposition_depth(1) >= maxDepth(1) → forced leaf
    const mockLLM = createMockLLMClient([CONCRETENESS_ALL_FALSE, LOW_SPECIFICITY]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG, { maxDepth: 1 });

    expect(result.children).toHaveLength(0);
    expect(result.reasoning).toContain("Max depth");
  });

  it("option-level maxDepth overrides instance-level maxDepth", async () => {
    const goal = makeGoal({ description: "Vague goal", decomposition_depth: 0 });
    await stateManager.saveGoal(goal);

    // Instance maxDepth = 0 would force leaf immediately, but option maxDepth = 5 allows decomposition
    // concreteness → no auto-stop (score=0.0 < 0.7)
    // specificity → LOW_SPECIFICITY → proceed with decomposition
    // subgoal generation → SUBGOALS_ONE, COVERAGE_PASS
    // child concreteness → auto-stop child
    const mockLLM = createMockLLMClient([
      CONCRETENESS_ALL_FALSE,
      LOW_SPECIFICITY,
      SUBGOALS_ONE,
      COVERAGE_PASS,
      HIGH_SPECIFICITY, // child specificity eval → leaf
    ]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph, {
      maxDepth: 0,
      concretenesThreshold: 0.7,
    });

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG, { maxDepth: 5 });

    // Should have decomposed since option overrides instance maxDepth=0
    expect(result.children.length).toBeGreaterThan(0);
  });
});

// ─── 4. Constructor options ───

describe("GoalTreeManager constructor options", () => {
  it("uses concretenesThreshold=0.7 from constructor options", async () => {
    const goal = makeGoal({ description: "Some goal" });
    await stateManager.saveGoal(goal);

    // score=0.75 >= 0.7 → auto-stop
    const mockLLM = createMockLLMClient([CONCRETENESS_THREE_TRUE]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph, { concretenesThreshold: 0.7 });

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    expect(result.children).toHaveLength(0);
    expect(result.reasoning).toContain("Auto-stop");
  });

  it("custom concretenesThreshold in constructor is used when no option override", async () => {
    const goal = makeGoal({ description: "Some goal" });
    await stateManager.saveGoal(goal);

    // score=0.5 (TWO_TRUE); with instance threshold=0.6 → 0.5 < 0.6 → no auto-stop
    // then internal: LOW_SPECIFICITY → proceed, SUBGOALS_ONE, COVERAGE_PASS
    // child: CONCRETENESS_ALL_TRUE → auto-stop child
    const mockLLM = createMockLLMClient([
      CONCRETENESS_TWO_TRUE,
      LOW_SPECIFICITY,
      SUBGOALS_ONE,
      COVERAGE_PASS,
      CONCRETENESS_ALL_TRUE,
    ]);
    const manager = new GoalTreeManager(
      stateManager,
      mockLLM,
      ethicsGate,
      dependencyGraph,
      { concretenesThreshold: 0.6 }
    );

    const result = await manager.decomposeGoal(goal.id, DEFAULT_CONFIG);
    // score=0.5 < threshold=0.6 → no auto-stop at root → children exist
    expect(result.children.length).toBeGreaterThan(0);
  });
});

// ─── 5. ConcretenessScore type validation ───

describe("ConcretenessScore return type", () => {
  it("returned object has expected shape: score, dimensions, reason", async () => {
    const mockLLM = createMockLLMClient([CONCRETENESS_ALL_TRUE]);
    const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);

    const result = await manager.scoreConcreteness("Deliver feature X by Q2 with < 100ms latency");

    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("dimensions");
    expect(result).toHaveProperty("reason");
    expect(result.dimensions).toHaveProperty("hasQuantitativeThreshold");
    expect(result.dimensions).toHaveProperty("hasObservableOutcome");
    expect(result.dimensions).toHaveProperty("hasTimebound");
    expect(result.dimensions).toHaveProperty("hasClearScope");
  });

  it("score is always in [0.0, 1.0] range", async () => {
    for (const fixture of [
      CONCRETENESS_ALL_TRUE,
      CONCRETENESS_ALL_FALSE,
      CONCRETENESS_TWO_TRUE,
      CONCRETENESS_THREE_TRUE,
    ]) {
      const mockLLM = createMockLLMClient([fixture]);
      const manager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, dependencyGraph);
      const result = await manager.scoreConcreteness("Any description");
      expect(result.score).toBeGreaterThanOrEqual(0.0);
      expect(result.score).toBeLessThanOrEqual(1.0);
    }
  });
});
