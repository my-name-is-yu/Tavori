/**
 * Milestone 7 E2E Tests: 再帰的Goal Tree + 横断ポートフォリオ Phase 2
 *
 * Group 1: GoalTreeManager — decompose, prune, concreteness, quality
 * Group 2: CrossGoalPortfolio — priority, allocation, momentum, dependency schedule
 * Group 3: LearningPipeline — structural feedback, aggregation, cross-goal patterns
 * Group 4: Integration — TreeLoopOrchestrator + StateAggregator + cascade completion
 *
 * All LLM and embedding calls are mocked. No real API calls.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { StateManager } from "../../src/state-manager.js";
import { GoalTreeManager } from "../../src/goal/goal-tree-manager.js";
import { scoreConcreteness, evaluateDecompositionQuality } from "../../src/goal/goal-tree-quality.js";
import { GoalDependencyGraph } from "../../src/goal/goal-dependency-graph.js";
import { EthicsGate } from "../../src/traits/ethics-gate.js";
import { CrossGoalPortfolio } from "../../src/strategy/cross-goal-portfolio.js";
import { LearningPipeline } from "../../src/knowledge/learning-pipeline.js";
import { KnowledgeTransfer } from "../../src/knowledge/knowledge-transfer.js";
import { StrategyTemplateRegistry } from "../../src/strategy/strategy-template-registry.js";
import { TreeLoopOrchestrator } from "../../src/goal/tree-loop-orchestrator.js";
import { StateAggregator } from "../../src/goal/state-aggregator.js";
import { VectorIndex } from "../../src/knowledge/vector-index.js";
import { MockEmbeddingClient } from "../../src/knowledge/embedding-client.js";
import { SatisficingJudge } from "../../src/drive/satisficing-judge.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../src/llm/llm-client.js";
import type { ZodSchema } from "zod";
import type { Goal } from "../../src/types/goal.js";
import { makeTempDir } from "../helpers/temp-dir.js";

// ─── Helpers ───

function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function extractJSON(text: string): string {
  const jsonBlock = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlock) return jsonBlock[1]!.trim();
  const genericBlock = text.match(/```\s*([\s\S]*?)```/);
  if (genericBlock) return genericBlock[1]!.trim();
  return text.trim();
}

function createSequentialMockLLMClient(responses: string[]): ILLMClient & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async sendMessage(_: LLMMessage[], __?: LLMRequestOptions): Promise<LLMResponse> {
      const index = callCount++;
      if (index >= responses.length) {
        throw new Error(`MockLLMClient: no response at index ${index} (only ${responses.length} configured)`);
      }
      const content = responses[index]!;
      return { content, usage: { input_tokens: 10, output_tokens: content.length }, stop_reason: "end_turn" };
    },
    parseJSON<T>(content: string, schema: ZodSchema<T>): T {
      return schema.parse(JSON.parse(extractJSON(content)));
    },
  };
}

function makeGoal(id: string, title: string, overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id,
    parent_id: null,
    node_type: "goal",
    title,
    description: `Goal: ${title}`,
    status: "active",
    dimensions: [{
      name: "quality_score",
      label: "Quality Score",
      current_value: 0.4,
      threshold: { type: "min", value: 0.8 },
      confidence: 0.6,
      observation_method: { type: "llm_review", source: "llm", schedule: null, endpoint: null, confidence_tier: "independent_review" },
      last_updated: now,
      history: [],
      weight: 1.0,
      uncertainty_weight: null,
      state_integrity: "ok",
      dimension_mapping: null,
    }],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: null,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: 0,
    specificity_score: null,
    loop_status: "idle",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ─── Group 1: GoalTreeManager ───

describe("Milestone 7 — Group 1: GoalTreeManager", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  // ── Test 1.1: Root goal with low specificity decomposes into 2 subgoals at depth 1 ──

  it("decomposeGoal: root goal with low specificity decomposes into 2 subgoals at depth 1", async () => {
    const stateManager = new StateManager(tempDir);

    // LLM call sequence for decomposeGoal with 2 children (no concretenesThreshold):
    // Call 0: evaluateSpecificity(root) → low score → needs decomposition
    // Call 1: generateSubgoals(root) → 2 child specs
    // Call 2: validateDecomposition coverage check → covers_parent: true
    // Call 3: evaluateSpecificity(child1) → high score → leaf (stops recursion)
    // Call 4: evaluateSpecificity(child2) → high score → leaf (stops recursion)
    const lowSpecificity = JSON.stringify({ specificity_score: 0.3, reasoning: "Goal is too abstract to act on directly" });
    const twoSubgoals = JSON.stringify([
      {
        hypothesis: "Improve documentation completeness to >= 80%",
        dimensions: [{ name: "doc_completeness", label: "Documentation Completeness", threshold_type: "min", threshold_value: 0.8, observation_method_hint: "count documented sections" }],
        constraints: [],
        expected_specificity: 0.8,
      },
      {
        hypothesis: "Add usage examples to README within 1 week",
        dimensions: [{ name: "examples_present", label: "Examples Present", threshold_type: "present", threshold_value: true, observation_method_hint: "check README for code blocks" }],
        constraints: [],
        expected_specificity: 0.85,
      },
    ]);
    const coversParent = JSON.stringify({ covers_parent: true, missing_dimensions: [], reasoning: "Subgoals cover all parent dimensions" });
    const highSpecificity1 = JSON.stringify({ specificity_score: 0.85, reasoning: "Goal has measurable threshold" });
    const highSpecificity2 = JSON.stringify({ specificity_score: 0.82, reasoning: "Goal has clear observable outcome" });

    const mockLLM = createSequentialMockLLMClient([
      lowSpecificity,  // Call 0: evaluateSpecificity(root)
      twoSubgoals,     // Call 1: generateSubgoals(root)
      coversParent,    // Call 2: validateDecomposition
      highSpecificity1, // Call 3: evaluateSpecificity(child1) → leaf
      highSpecificity2, // Call 4: evaluateSpecificity(child2) → leaf
    ]);

    const ethicsLLM = createSequentialMockLLMClient([
      JSON.stringify({ verdict: "approve", reasoning: "fine", concerns: [] }),
    ]);
    const ethicsGate = new EthicsGate(stateManager, ethicsLLM);
    const depGraph = new GoalDependencyGraph(stateManager);
    const goalTreeManager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, depGraph);

    // Save the root goal
    const root = makeGoal("root-decompose-1", "Improve PulSeed documentation quality");
    await stateManager.saveGoal(root);

    const config = {
      max_depth: 3,
      min_specificity: 0.7,
      auto_prune_threshold: 0.3,
      parallel_loop_limit: 3,
    };

    const result = await goalTreeManager.decomposeGoal("root-decompose-1", config);

    // Assert: result has 2 children
    expect(result.children.length).toBe(2);
    expect(result.parent_id).toBe("root-decompose-1");

    // Assert: parent's children_ids updated in StateManager
    const savedParent = await stateManager.loadGoal("root-decompose-1");
    expect(savedParent).not.toBeNull();
    expect(savedParent!.children_ids.length).toBe(2);

    // Assert: children saved to StateManager
    for (const child of result.children) {
      const savedChild = await stateManager.loadGoal(child.id);
      expect(savedChild).not.toBeNull();
      expect(savedChild!.parent_id).toBe("root-decompose-1");
      expect(savedChild!.decomposition_depth).toBe(1);
    }

    // Assert: all 5 LLM calls were consumed
    expect(mockLLM.callCount).toBe(5);
  });

  // ── Test 1.2: scoreConcreteness scores a concrete description ──

  it("scoreConcreteness: concrete description (3/4 dimensions true) returns score 0.75", async () => {
    const concreteResponse = JSON.stringify({
      hasQuantitativeThreshold: true,
      hasObservableOutcome: true,
      hasTimebound: false,
      hasClearScope: true,
      reason: "Has clear quantitative threshold, observable outcome, and clear scope. Missing timebound.",
    });

    const mockLLM = createSequentialMockLLMClient([concreteResponse]);

    const description = "Achieve >= 80% documentation coverage with observable section presence, clearly scoped to public API docs";
    const result = await scoreConcreteness(description, { llmClient: mockLLM });

    // 3 true dimensions × 0.25 each = 0.75
    expect(result.score).toBe(0.75);
    expect(result.dimensions.hasQuantitativeThreshold).toBe(true);
    expect(result.dimensions.hasObservableOutcome).toBe(true);
    expect(result.dimensions.hasTimebound).toBe(false);
    expect(result.dimensions.hasClearScope).toBe(true);
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  // ── Test 1.3: evaluateDecompositionQuality returns metrics with correct structure ──

  it("evaluateDecompositionQuality: returns metrics object with expected structure and computed depthEfficiency", async () => {
    // Mock LLM returns coverage=0.8, overlap=0.1, actionability=0.7
    // depthEfficiency = 1 - overlap * 0.5 = 1 - 0.1 * 0.5 = 0.95
    const qualityResponse = JSON.stringify({
      coverage: 0.8,
      overlap: 0.1,
      actionability: 0.7,
      reasoning: "Good decomposition with high coverage and low overlap",
    });

    const mockLLM = createSequentialMockLLMClient([qualityResponse]);

    const parentDescription = "Improve overall documentation quality";
    const subgoalDescriptions = [
      "Improve documentation completeness to >= 80%",
      "Add usage examples to README within 1 week",
    ];

    const metrics = await evaluateDecompositionQuality(parentDescription, subgoalDescriptions, { llmClient: mockLLM });

    // Assert: individual metric values
    expect(metrics.coverage).toBe(0.8);
    expect(metrics.overlap).toBe(0.1);
    expect(metrics.actionability).toBe(0.7);

    // Assert: depthEfficiency computed as 1 - overlap * 0.5 = 1 - 0.05 = 0.95
    expect(metrics.depthEfficiency).toBeCloseTo(0.95, 5);

    // Assert: metrics object has all expected keys
    expect(typeof metrics.coverage).toBe("number");
    expect(typeof metrics.overlap).toBe("number");
    expect(typeof metrics.actionability).toBe("number");
    expect(typeof metrics.depthEfficiency).toBe("number");
  });
});

// ─── Group 2: CrossGoalPortfolio ───

describe("Group 2: CrossGoalPortfolio — Priorities + Allocation + Momentum", () => {
  let tempDir: string;
  let stateManager: StateManager;
  let depGraph: GoalDependencyGraph;
  let vectorIndex: VectorIndex;
  let embeddingClient: MockEmbeddingClient;
  let portfolio: CrossGoalPortfolio;

  beforeEach(() => {
    tempDir = makeTempDir();
    stateManager = new StateManager(tempDir);
    depGraph = new GoalDependencyGraph(stateManager);
    embeddingClient = new MockEmbeddingClient(64);
    vectorIndex = new VectorIndex(
      path.join(tempDir, "vector-index.json"),
      embeddingClient
    );
    portfolio = new CrossGoalPortfolio(
      stateManager,
      depGraph,
      vectorIndex,
      embeddingClient
    );
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  // ── Test 2.1: calculateGoalPriorities ranks deadline-urgent goal higher ──

  it("calculateGoalPriorities ranks deadline-urgent goal higher than goal with no deadline", async () => {
    // goalA: near deadline (1 day away) with a gap
    const deadlineSoon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const goalA = makeGoal("cgp-goal-a", "Urgent deadline goal", {
      deadline: deadlineSoon,
      dimensions: [
        {
          name: "quality_score",
          label: "Quality Score",
          current_value: 0.2,
          threshold: { type: "min", value: 0.9 },
          confidence: 0.7,
          observation_method: {
            type: "llm_review",
            source: "llm",
            schedule: null,
            endpoint: null,
            confidence_tier: "independent_review",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });

    // goalB: no deadline, smaller gap
    const goalB = makeGoal("cgp-goal-b", "No deadline goal", {
      deadline: null,
      dimensions: [
        {
          name: "quality_score",
          label: "Quality Score",
          current_value: 0.6,
          threshold: { type: "min", value: 0.8 },
          confidence: 0.7,
          observation_method: {
            type: "llm_review",
            source: "llm",
            schedule: null,
            endpoint: null,
            confidence_tier: "independent_review",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });

    await stateManager.saveGoal(goalA);
    await stateManager.saveGoal(goalB);

    const priorities = await portfolio.calculateGoalPriorities([goalA.id, goalB.id]);

    expect(priorities.length).toBe(2);
    // Sorted descending — goalA (deadline urgent) must be first
    expect(priorities[0]!.goal_id).toBe(goalA.id);
    expect(priorities[0]!.computed_priority).toBeGreaterThan(
      priorities[1]!.computed_priority
    );
    // deadline_urgency for goalA should be > 0
    expect(priorities[0]!.deadline_urgency).toBeGreaterThan(0);
    // goalB has no deadline → urgency === 0
    expect(priorities.find((p) => p.goal_id === goalB.id)!.deadline_urgency).toBe(0);
  });

  // ── Test 2.2: allocateResources — single goal gets 100%, two goals split proportionally ──

  it("allocateResources gives sole goal 100% share; two goals split proportionally summing to 1.0", async () => {
    const goalA = makeGoal("alloc-goal-a", "Allocation Goal A");
    const goalB = makeGoal("alloc-goal-b", "Allocation Goal B");
    await stateManager.saveGoal(goalA);
    await stateManager.saveGoal(goalB);

    // Single-goal case
    const singlePriorities = await portfolio.calculateGoalPriorities([goalA.id]);
    const singleAllocations = portfolio.allocateResources(singlePriorities, {
      type: "priority",
    });
    expect(singleAllocations.length).toBe(1);
    expect(singleAllocations[0]!.resource_share).toBe(1.0);

    // Two-goal case
    const twoPriorities = await portfolio.calculateGoalPriorities([goalA.id, goalB.id]);
    const twoAllocations = portfolio.allocateResources(twoPriorities, {
      type: "priority",
    });
    expect(twoAllocations.length).toBe(2);
    const totalShare = twoAllocations.reduce((s, a) => s + a.resource_share, 0);
    expect(totalShare).toBeCloseTo(1.0, 5);
    for (const alloc of twoAllocations) {
      expect(alloc.resource_share).toBeGreaterThan(0);
    }
  });

  // ── Test 2.3: calculateMomentum returns correct trend ──

  it("calculateMomentum returns 'stalled' for flat snapshots and 'accelerating' for increasing snapshots", () => {
    // Stalled: all values equal → velocity ≈ 0
    const stalledInfo = portfolio.calculateMomentum("mom-goal-stalled", [
      0.4, 0.4, 0.4, 0.4,
    ]);
    expect(stalledInfo.trend).toBe("stalled");
    expect(Math.abs(stalledInfo.velocity)).toBeLessThan(0.005);

    // Accelerating: later deltas clearly larger than earlier deltas
    // Deltas: 0.01, 0.01, 0.08, 0.10 — late avg > early avg + threshold
    const accelInfo = portfolio.calculateMomentum("mom-goal-accel", [
      0.0, 0.01, 0.02, 0.1, 0.2,
    ]);
    // Deltas: 0.01, 0.01, 0.08, 0.10
    // mid = 2; earlyAvg = (0.01+0.01)/2 = 0.01; lateAvg = (0.08+0.10)/2 = 0.09
    // lateAvg > earlyAvg + 0.002 → accelerating
    expect(accelInfo.trend).toBe("accelerating");
    expect(accelInfo.recentProgress).toBeCloseTo(0.2, 5);
  });

  // ── Test 2.4: rebalanceOnStall redistributes from stalled to progressing ──

  it("rebalanceOnStall increases progressing goal share and zeroes stalled goal share", () => {
    const stalledAlloc = {
      goal_id: "stall-goal-stalled",
      priority: 0.5,
      resource_share: 0.4,
      adjustment_reason: "initial",
    };
    const progressingAlloc = {
      goal_id: "stall-goal-progressing",
      priority: 0.6,
      resource_share: 0.6,
      adjustment_reason: "initial",
    };

    const currentAllocations = [stalledAlloc, progressingAlloc];

    const stalledMomentum = portfolio.calculateMomentum("stall-goal-stalled", [
      0.5, 0.5, 0.5, 0.5,
    ]);
    const progressingMomentum = portfolio.calculateMomentum(
      "stall-goal-progressing",
      [0.1, 0.2, 0.3, 0.5]
    );

    const momentumMap = new Map([
      ["stall-goal-stalled", stalledMomentum],
      ["stall-goal-progressing", progressingMomentum],
    ]);

    const actions = portfolio.rebalanceOnStall(currentAllocations, momentumMap);

    expect(actions.length).toBeGreaterThanOrEqual(2);

    const stalledAction = actions.find(
      (a) => a.goalId === "stall-goal-stalled"
    );
    const progressingAction = actions.find(
      (a) => a.goalId === "stall-goal-progressing"
    );

    expect(stalledAction).toBeDefined();
    expect(stalledAction!.action).toBe("reduce");
    expect(stalledAction!.newShare).toBe(0);

    expect(progressingAction).toBeDefined();
    expect(progressingAction!.action).toBe("increase");
    expect(progressingAction!.newShare).toBeGreaterThan(progressingAlloc.resource_share);
  });
});

// ─── Group 3: LearningPipeline ───

describe("Group 3: LearningPipeline — Structural Feedback + Cross-Goal Patterns", () => {
  let tempDir: string;
  let stateManager: StateManager;
  let pipeline: LearningPipeline;

  function makeStructuralFeedback(
    goalId: string,
    feedbackType: "observation_accuracy" | "strategy_selection" | "scope_sizing" | "task_generation",
    delta: number,
    idSuffix: string
  ) {
    return {
      id: `sf-${idSuffix}`,
      goalId,
      iterationId: `iter-${idSuffix}`,
      feedbackType,
      expected: "expected outcome",
      actual: "actual outcome",
      delta,
      timestamp: new Date().toISOString(),
      context: {},
    };
  }

  beforeEach(() => {
    tempDir = makeTempDir();
    stateManager = new StateManager(tempDir);
    pipeline = new LearningPipeline(
      createSequentialMockLLMClient([]),
      null,
      stateManager
    );
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  // ── Test 3.1: recordStructuralFeedback + aggregateFeedback ──

  it("recordStructuralFeedback persists entries; aggregateFeedback computes averageDelta and totalCount", async () => {
    const goalId = "lp-goal-feedback";
    const deltas = [-0.2, -0.1, -0.3];

    for (let i = 0; i < deltas.length; i++) {
      await pipeline.recordStructuralFeedback(
        makeStructuralFeedback(goalId, "scope_sizing", deltas[i]!, `scope-${i}`)
      );
    }

    const aggregations = await pipeline.aggregateFeedback(goalId, "scope_sizing");

    expect(aggregations.length).toBe(1);
    const agg = aggregations[0]!;
    expect(agg.feedbackType).toBe("scope_sizing");
    expect(agg.totalCount).toBe(3);
    // averageDelta = (-0.2 + -0.1 + -0.3) / 3 = -0.2
    expect(agg.averageDelta).toBeCloseTo(-0.2, 5);
  });

  // ── Test 3.2: autoTuneParameters suggests adjustment with >= 5 consistent entries ──

  it("autoTuneParameters returns suggestions when >= 5 consistent negative-delta entries exist", async () => {
    const goalId = "lp-goal-autotune";

    // Record 5 "strategy_selection" entries all with negative delta
    for (let i = 0; i < 5; i++) {
      await pipeline.recordStructuralFeedback(
        makeStructuralFeedback(goalId, "strategy_selection", -0.2, `strat-${i}`)
      );
    }

    const suggestions = await pipeline.autoTuneParameters(goalId);

    expect(suggestions.length).toBeGreaterThanOrEqual(1);

    const strategySuggestion = suggestions.find(
      (s) => s.feedbackType === "strategy_selection"
    );
    expect(strategySuggestion).toBeDefined();
    // Negative avgDelta → suggestedValue = 0.3 (increase exploration)
    expect(strategySuggestion!.parameterName).toBe("strategy_exploitation_weight");
    expect(strategySuggestion!.suggestedValue).toBe(0.3);
    expect(strategySuggestion!.basedOnFeedbackCount).toBe(5);
  });

  // ── Test 3.3: extractCrossGoalPatterns clusters across goals ──

  it("extractCrossGoalPatterns identifies a cross-goal cluster when 2 goals share similar feedbackType+delta", async () => {
    const goalAId = "lp-extract-goal-a";
    const goalBId = "lp-extract-goal-b";

    // Goal A: 2 "scope_sizing" entries with delta=-0.2
    for (let i = 0; i < 2; i++) {
      await pipeline.recordStructuralFeedback(
        makeStructuralFeedback(goalAId, "scope_sizing", -0.2, `a-scope-${i}`)
      );
    }

    // Goal B: 2 "scope_sizing" entries with delta=-0.25 (within ±0.2 of -0.2)
    for (let i = 0; i < 2; i++) {
      await pipeline.recordStructuralFeedback(
        makeStructuralFeedback(goalBId, "scope_sizing", -0.25, `b-scope-${i}`)
      );
    }

    const patterns = await pipeline.extractCrossGoalPatterns([goalAId, goalBId]);

    expect(patterns.length).toBeGreaterThanOrEqual(1);

    const scopePattern = patterns.find((p) => p.feedbackType === "scope_sizing");
    expect(scopePattern).toBeDefined();
    // avgDelta ≈ -0.225 < -0.05 → patternType === "success"
    expect(scopePattern!.patternType).toBe("success");
    expect(scopePattern!.sourceGoalIds).toContain(goalAId);
    expect(scopePattern!.sourceGoalIds).toContain(goalBId);
  });

  // ── Test 3.4: sharePatternsAcrossGoals injects into target goals ──

  it("sharePatternsAcrossGoals injects synthetic structural feedback into target goals", async () => {
    const goalAId = "lp-share-goal-a";
    const goalBId = "lp-share-goal-b";
    const goalCId = "lp-share-goal-c";

    // Set up patterns the same way as Test 3.3
    for (let i = 0; i < 2; i++) {
      await pipeline.recordStructuralFeedback(
        makeStructuralFeedback(goalAId, "scope_sizing", -0.2, `share-a-${i}`)
      );
    }
    for (let i = 0; i < 2; i++) {
      await pipeline.recordStructuralFeedback(
        makeStructuralFeedback(goalBId, "scope_sizing", -0.25, `share-b-${i}`)
      );
    }

    const patterns = await pipeline.extractCrossGoalPatterns([goalAId, goalBId]);
    expect(patterns.length).toBeGreaterThanOrEqual(1);

    // goalC starts with no feedback
    expect((await pipeline.getStructuralFeedback(goalCId)).length).toBe(0);

    // Share patterns to goalC
    // Patterns have empty applicableConditions (context was {}) → conditionsMatch = true
    const result = await pipeline.sharePatternsAcrossGoals(patterns, [goalCId]);

    // goalC should now have structural feedback injected
    const goalCFeedback = await pipeline.getStructuralFeedback(goalCId);
    expect(goalCFeedback.length).toBeGreaterThanOrEqual(1);

    // Verify the sharing result metadata
    expect(result.patternsShared).toBeGreaterThanOrEqual(1);
    expect(result.targetGoalIds).toContain(goalCId);
  });
});

// ─── Group 4: Integration — TreeLoopOrchestrator ───

describe("Milestone 7 — Group 4: Integration — TreeLoopOrchestrator", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  // ── Test 4.1: selectNextNode picks deepest leaf first ──

  it("selectNextNode: returns deepest leaf node (grandchild) first when 3-level tree exists", async () => {
    const stateManager = new StateManager(tempDir);
    // No LLM calls needed for TreeLoopOrchestrator
    const mockLLM = createSequentialMockLLMClient([]);
    const ethicsLLM = createSequentialMockLLMClient([]);
    const ethicsGate = new EthicsGate(stateManager, ethicsLLM);
    const depGraph = new GoalDependencyGraph(stateManager);
    const goalTreeManager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, depGraph);
    const satisficingJudge = new SatisficingJudge(stateManager);
    const stateAggregator = new StateAggregator(stateManager, satisficingJudge);
    const orchestrator = new TreeLoopOrchestrator(stateManager, goalTreeManager, stateAggregator, satisficingJudge);

    // Build 3-node tree: root → child (depth=1) → grandchild (depth=2)
    // grandchild is a leaf node, child is NOT a leaf (has children)
    const root = makeGoal("root-orch-1", "Root goal", {
      node_type: "goal",
      children_ids: ["child-orch-1"],
      decomposition_depth: 0,
      loop_status: "idle",
    });
    const child = makeGoal("child-orch-1", "Child goal (depth 1)", {
      parent_id: "root-orch-1",
      node_type: "goal",  // non-leaf: has children
      children_ids: ["grandchild-orch-1"],
      decomposition_depth: 1,
      loop_status: "idle",
    });
    const grandchild = makeGoal("grandchild-orch-1", "Grandchild goal (depth 2)", {
      parent_id: "child-orch-1",
      node_type: "leaf",  // leaf: no children
      children_ids: [],
      decomposition_depth: 2,
      loop_status: "idle",
    });

    await stateManager.saveGoal(root);
    await stateManager.saveGoal(child);
    await stateManager.saveGoal(grandchild);

    const config = {
      max_depth: 5,
      min_specificity: 0.7,
      auto_prune_threshold: 0.3,
      parallel_loop_limit: 3,
    };

    // startTreeExecution resets all nodes to idle (they already are)
    await orchestrator.startTreeExecution("root-orch-1", config);

    // selectNextNode should pick the deepest leaf first
    const selectedId = await orchestrator.selectNextNode("root-orch-1");

    // Assert: returns grandchild.id (depth=2 preferred over depth=1)
    expect(selectedId).toBe("grandchild-orch-1");

    // Assert: selected node's loop_status is now "running"
    const selectedGoal = await stateManager.loadGoal("grandchild-orch-1");
    expect(selectedGoal).not.toBeNull();
    expect(selectedGoal!.loop_status).toBe("running");
  });

  // ── Test 4.2: onNodeCompleted triggers cascade completion of parent ──

  it("onNodeCompleted: triggers cascade completion when all sibling leaves are done", async () => {
    const stateManager = new StateManager(tempDir);
    const mockLLM = createSequentialMockLLMClient([]);
    const ethicsLLM = createSequentialMockLLMClient([]);
    const ethicsGate = new EthicsGate(stateManager, ethicsLLM);
    const depGraph = new GoalDependencyGraph(stateManager);
    const goalTreeManager = new GoalTreeManager(stateManager, mockLLM, ethicsGate, depGraph);
    const satisficingJudge = new SatisficingJudge(stateManager);
    const stateAggregator = new StateAggregator(stateManager, satisficingJudge);
    const orchestrator = new TreeLoopOrchestrator(stateManager, goalTreeManager, stateAggregator, satisficingJudge);

    // Build: parent with 2 leaf children (both need to complete)
    const parent = makeGoal("parent-cascade-1", "Parent goal for cascade test", {
      node_type: "goal",
      children_ids: ["leaf-cascade-a", "leaf-cascade-b"],
      decomposition_depth: 0,
      loop_status: "idle",
      status: "active",
    });

    // Leaf A: already marked as completed (it finished before this test call)
    const leafA = makeGoal("leaf-cascade-a", "Leaf A (already completed)", {
      parent_id: "parent-cascade-1",
      node_type: "leaf",
      children_ids: [],
      decomposition_depth: 1,
      loop_status: "idle",
      status: "completed",  // already done
    });

    // Leaf B: still active — this is the one we will call onNodeCompleted on
    const leafB = makeGoal("leaf-cascade-b", "Leaf B (completing now)", {
      parent_id: "parent-cascade-1",
      node_type: "leaf",
      children_ids: [],
      decomposition_depth: 1,
      loop_status: "running",  // currently running
      status: "active",
    });

    await stateManager.saveGoal(parent);
    await stateManager.saveGoal(leafA);
    await stateManager.saveGoal(leafB);

    // Mark leaf B as completed in state before calling onNodeCompleted
    // (simulating SatisficingJudge completing the goal)
    await stateManager.saveGoal({ ...leafB, status: "completed", loop_status: "idle" });

    // Call onNodeCompleted on leaf B
    await orchestrator.onNodeCompleted("leaf-cascade-b");

    // Assert: parent's status has been updated to "completed" via cascade
    const updatedParent = await stateManager.loadGoal("parent-cascade-1");
    expect(updatedParent).not.toBeNull();
    expect(updatedParent!.status).toBe("completed");

    // Assert: leaf B's loop_status reset to "idle" by onNodeCompleted
    const updatedLeafB = await stateManager.loadGoal("leaf-cascade-b");
    expect(updatedLeafB).not.toBeNull();
    // onNodeCompleted resets to idle first, but then the status was already persisted as completed
    // The loop_status should be idle after onNodeCompleted's Step 1
    expect(updatedLeafB!.loop_status).toBe("idle");
  });
});
