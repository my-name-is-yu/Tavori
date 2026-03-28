import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LearningPipeline } from "../src/knowledge/learning-pipeline.js";
import { KnowledgeTransfer } from "../src/knowledge/knowledge-transfer.js";
import { StateManager } from "../src/state-manager.js";
import { VectorIndex } from "../src/knowledge/vector-index.js";
import { MockEmbeddingClient } from "../src/knowledge/embedding-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import type { StructuralFeedback, CrossGoalPattern } from "../src/types/learning.js";
import { CrossGoalPatternSchema } from "../src/types/learning.js";

// ─── Helpers ───

function makeFeedback(
  goalId: string,
  feedbackType: StructuralFeedback["feedbackType"],
  delta: number,
  contextKeys: string[] = [],
  iterationId?: string
): StructuralFeedback {
  const ctx: Record<string, unknown> = {};
  for (const k of contextKeys) {
    ctx[k] = true;
  }
  return {
    id: `sf_${Math.random().toString(36).slice(2)}`,
    goalId,
    iterationId: iterationId ?? `iter_${Math.random().toString(36).slice(2)}`,
    feedbackType,
    expected: "expected_value",
    actual: "actual_value",
    delta,
    timestamp: new Date().toISOString(),
    context: ctx,
  };
}

function makeCrossGoalPattern(
  overrides: Partial<CrossGoalPattern> = {}
): CrossGoalPattern {
  return CrossGoalPatternSchema.parse({
    id: `cgp_test_${Math.random().toString(36).slice(2)}`,
    patternType: "success",
    description: "Test cross-goal pattern",
    sourceGoalIds: ["goal-A", "goal-B"],
    feedbackType: "scope_sizing",
    confidence: 0.8,
    applicableConditions: [],
    suggestedAction: "Reduce task scope to smaller units",
    occurrenceCount: 4,
    lastObserved: new Date().toISOString(),
    ...overrides,
  });
}

// ─── Tests ───

describe("LearningPipeline — extractCrossGoalPatterns", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let pipeline: LearningPipeline;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulseed-cross-goal-test-")
    );
    stateManager = new StateManager(tmpDir);
    const mockEmbeddingClient = new MockEmbeddingClient(4);
    const vectorIndex = new VectorIndex(
      path.join(tmpDir, "vector-index.json"),
      mockEmbeddingClient
    );
    const llm = createMockLLMClient([]);
    pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should identify patterns across 2+ goals with similar delta values", async () => {
    // Two goals both show scope_sizing negative delta (improvement)
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-A", "scope_sizing", -0.3, ["ci"])
    );
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-B", "scope_sizing", -0.25, ["ci"])
    );

    const patterns = await pipeline.extractCrossGoalPatterns(["goal-A", "goal-B"]);

    expect(patterns.length).toBeGreaterThan(0);
    const pattern = patterns[0]!;
    expect(pattern.feedbackType).toBe("scope_sizing");
    expect(pattern.sourceGoalIds).toContain("goal-A");
    expect(pattern.sourceGoalIds).toContain("goal-B");
    expect(pattern.occurrenceCount).toBe(2);
  });

  it("should correctly calculate confidence as confirming goals / total goals", async () => {
    // 2 goals confirm the pattern out of 3 total
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-A", "strategy_selection", -0.2)
    );
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-B", "strategy_selection", -0.15)
    );
    // goal-C has a different delta (positive) — different cluster
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-C", "strategy_selection", 0.5)
    );

    const patterns = await pipeline.extractCrossGoalPatterns([
      "goal-A",
      "goal-B",
      "goal-C",
    ]);

    const negativePattern = patterns.find(
      (p) => p.feedbackType === "strategy_selection" && p.patternType === "success"
    );
    expect(negativePattern).toBeDefined();
    // confidence = 2 confirming goals / 3 total goals ≈ 0.667
    expect(negativePattern!.confidence).toBeCloseTo(2 / 3, 5);
  });

  it("should return no patterns for single-goal input", async () => {
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-A", "scope_sizing", -0.3)
    );

    const patterns = await pipeline.extractCrossGoalPatterns(["goal-A"]);

    expect(patterns).toHaveLength(0);
  });

  it("should return no patterns when only one goal has data for a feedbackType", async () => {
    // Only goal-A has scope_sizing feedback; goal-B has none
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-A", "scope_sizing", -0.3)
    );

    const patterns = await pipeline.extractCrossGoalPatterns(["goal-A", "goal-B"]);

    // scope_sizing only in goal-A → no cross-goal pattern
    const scopePatterns = patterns.filter(
      (p) => p.feedbackType === "scope_sizing"
    );
    expect(scopePatterns).toHaveLength(0);
  });

  it("should classify patternType as 'success' when avgDelta < -0.05", async () => {
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-A", "task_generation", -0.4)
    );
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-B", "task_generation", -0.35)
    );

    const patterns = await pipeline.extractCrossGoalPatterns(["goal-A", "goal-B"]);

    expect(patterns[0]!.patternType).toBe("success");
  });

  it("should classify patternType as 'failure' when avgDelta > 0.05", async () => {
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-A", "observation_accuracy", 0.3)
    );
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-B", "observation_accuracy", 0.25)
    );

    const patterns = await pipeline.extractCrossGoalPatterns(["goal-A", "goal-B"]);

    expect(patterns[0]!.patternType).toBe("failure");
  });

  it("should classify patternType as 'optimization' when avgDelta is near 0", async () => {
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-A", "scope_sizing", 0.02)
    );
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-B", "scope_sizing", -0.02)
    );

    const patterns = await pipeline.extractCrossGoalPatterns(["goal-A", "goal-B"]);

    expect(patterns[0]!.patternType).toBe("optimization");
  });

  it("should not produce a pattern when all deltas differ by more than ±0.2", async () => {
    // goal-A: -0.8, goal-B: +0.8 — very different clusters, each only 1 goal
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-A", "scope_sizing", -0.8)
    );
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-B", "scope_sizing", 0.8)
    );

    const patterns = await pipeline.extractCrossGoalPatterns(["goal-A", "goal-B"]);

    expect(patterns).toHaveLength(0);
  });

  it("should handle no feedback data gracefully (empty result)", async () => {
    const patterns = await pipeline.extractCrossGoalPatterns(["goal-A", "goal-B"]);
    expect(patterns).toHaveLength(0);
  });

  it("should include applicableConditions derived from context keys", async () => {
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-A", "scope_sizing", -0.3, ["ci", "environment"])
    );
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-B", "scope_sizing", -0.25, ["ci"])
    );

    const patterns = await pipeline.extractCrossGoalPatterns(["goal-A", "goal-B"]);

    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0]!.applicableConditions).toContain("ci");
  });

  it("should detect multiple patterns for different feedbackTypes", async () => {
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-A", "scope_sizing", -0.3)
    );
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-B", "scope_sizing", -0.25)
    );
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-A", "task_generation", 0.4)
    );
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-B", "task_generation", 0.35)
    );

    const patterns = await pipeline.extractCrossGoalPatterns(["goal-A", "goal-B"]);

    const types = new Set(patterns.map((p) => p.feedbackType));
    expect(types.has("scope_sizing")).toBe(true);
    expect(types.has("task_generation")).toBe(true);
  });
});

describe("LearningPipeline — sharePatternsAcrossGoals", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let pipeline: LearningPipeline;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulseed-share-patterns-test-")
    );
    stateManager = new StateManager(tmpDir);
    const llm = createMockLLMClient([]);
    pipeline = new LearningPipeline(llm, null, stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should apply matching patterns to target goals", async () => {
    // Target goal has context key "ci"
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-target", "scope_sizing", 0, ["ci"])
    );

    const patterns = [
      makeCrossGoalPattern({
        feedbackType: "scope_sizing",
        applicableConditions: ["ci"],
        sourceGoalIds: ["goal-A", "goal-B"],
      }),
    ];

    const result = await pipeline.sharePatternsAcrossGoals(patterns, ["goal-target"]);

    expect(result.patternsExtracted).toBe(1);
    expect(result.patternsShared).toBe(1);
    expect(result.targetGoalIds).toContain("goal-target");
    expect(result.newPatterns).toHaveLength(1);
  });

  it("should skip patterns whose applicableConditions do not match", async () => {
    // Target goal has no "database" context key
    await pipeline.recordStructuralFeedback(
      makeFeedback("goal-target", "scope_sizing", 0, ["ci"])
    );

    const patterns = [
      makeCrossGoalPattern({
        applicableConditions: ["database"],
        sourceGoalIds: ["goal-A", "goal-B"],
      }),
    ];

    const result = await pipeline.sharePatternsAcrossGoals(patterns, ["goal-target"]);

    expect(result.patternsShared).toBe(0);
    expect(result.targetGoalIds).toHaveLength(0);
  });

  it("should apply patterns with no applicableConditions to all target goals (universal)", async () => {
    const patterns = [
      makeCrossGoalPattern({
        applicableConditions: [],
        sourceGoalIds: ["goal-A", "goal-B"],
      }),
    ];

    const result = await pipeline.sharePatternsAcrossGoals(patterns, [
      "goal-target-1",
      "goal-target-2",
    ]);

    expect(result.patternsShared).toBe(2);
    expect(result.targetGoalIds).toContain("goal-target-1");
    expect(result.targetGoalIds).toContain("goal-target-2");
  });

  it("should skip pattern if target goal is already a source goal", async () => {
    const patterns = [
      makeCrossGoalPattern({
        applicableConditions: [],
        sourceGoalIds: ["goal-target", "goal-B"],
      }),
    ];

    const result = await pipeline.sharePatternsAcrossGoals(patterns, ["goal-target"]);

    expect(result.patternsShared).toBe(0);
  });

  it("should record synthetic structural feedback for shared patterns", async () => {
    const patterns = [
      makeCrossGoalPattern({
        feedbackType: "task_generation",
        applicableConditions: [],
        sourceGoalIds: ["goal-A", "goal-B"],
      }),
    ];

    await pipeline.sharePatternsAcrossGoals(patterns, ["goal-target"]);

    const recorded = await pipeline.getStructuralFeedback("goal-target");
    expect(recorded.length).toBeGreaterThan(0);
    const shared = recorded.find((f) =>
      f.iterationId.startsWith("shared_from_cross_goal_pattern_")
    );
    expect(shared).toBeDefined();
    expect(shared!.feedbackType).toBe("task_generation");
  });

  it("should handle empty patterns array gracefully", async () => {
    const result = await pipeline.sharePatternsAcrossGoals([], ["goal-target"]);

    expect(result.patternsExtracted).toBe(0);
    expect(result.patternsShared).toBe(0);
    expect(result.newPatterns).toHaveLength(0);
  });

  it("should handle empty targetGoalIds gracefully", async () => {
    const patterns = [makeCrossGoalPattern()];
    const result = await pipeline.sharePatternsAcrossGoals(patterns, []);

    expect(result.patternsShared).toBe(0);
    expect(result.targetGoalIds).toHaveLength(0);
  });
});

describe("KnowledgeTransfer — storePattern / retrievePatterns", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let knowledgeTransfer: KnowledgeTransfer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulseed-kt-pattern-test-")
    );
    stateManager = new StateManager(tmpDir);

    const mockEmbeddingClient = new MockEmbeddingClient(4);
    const vectorIndex = new VectorIndex(
      path.join(tmpDir, "vector-index.json"),
      mockEmbeddingClient
    );
    const llm = createMockLLMClient([]);
    const pipeline = new LearningPipeline(llm, null, stateManager);

    // Use minimal mocks for dependencies not under test
    const mockKnowledgeManager = {
      searchRelated: async () => [],
      addEntry: async () => ({ id: "mock" }),
    } as unknown as import("../src/knowledge/knowledge-manager.js").KnowledgeManager;

    const mockEthicsGate = {
      check: async () => ({ verdict: "allow" as const, reasoning: "" }),
    } as unknown as import("../src/ethics-gate.js").EthicsGate;

    knowledgeTransfer = new KnowledgeTransfer({
      llmClient: llm,
      knowledgeManager: mockKnowledgeManager,
      vectorIndex,
      learningPipeline: pipeline,
      ethicsGate: mockEthicsGate,
      stateManager,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should roundtrip: stored pattern is returned by retrievePatterns", () => {
    const pattern = makeCrossGoalPattern({
      feedbackType: "scope_sizing",
      patternType: "success",
    });

    knowledgeTransfer.storePattern(pattern);
    const retrieved = knowledgeTransfer.retrievePatterns();

    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]!.id).toBe(pattern.id);
    expect(retrieved[0]!.feedbackType).toBe("scope_sizing");
  });

  it("should store multiple patterns and retrieve all", () => {
    const p1 = makeCrossGoalPattern({ feedbackType: "scope_sizing" });
    const p2 = makeCrossGoalPattern({ feedbackType: "task_generation" });
    const p3 = makeCrossGoalPattern({ feedbackType: "strategy_selection" });

    knowledgeTransfer.storePattern(p1);
    knowledgeTransfer.storePattern(p2);
    knowledgeTransfer.storePattern(p3);

    const all = knowledgeTransfer.retrievePatterns();
    expect(all).toHaveLength(3);
  });

  it("should filter by feedbackType", () => {
    const p1 = makeCrossGoalPattern({ feedbackType: "scope_sizing" });
    const p2 = makeCrossGoalPattern({ feedbackType: "task_generation" });
    const p3 = makeCrossGoalPattern({ feedbackType: "scope_sizing" });

    knowledgeTransfer.storePattern(p1);
    knowledgeTransfer.storePattern(p2);
    knowledgeTransfer.storePattern(p3);

    const filtered = knowledgeTransfer.retrievePatterns({
      feedbackType: "scope_sizing",
    });
    expect(filtered).toHaveLength(2);
    for (const p of filtered) {
      expect(p.feedbackType).toBe("scope_sizing");
    }
  });

  it("should filter by patternType", () => {
    const p1 = makeCrossGoalPattern({ patternType: "success" });
    const p2 = makeCrossGoalPattern({ patternType: "failure" });
    const p3 = makeCrossGoalPattern({ patternType: "success" });

    knowledgeTransfer.storePattern(p1);
    knowledgeTransfer.storePattern(p2);
    knowledgeTransfer.storePattern(p3);

    const successes = knowledgeTransfer.retrievePatterns({
      patternType: "success",
    });
    expect(successes).toHaveLength(2);
    for (const p of successes) {
      expect(p.patternType).toBe("success");
    }
  });

  it("should filter by both feedbackType and patternType", () => {
    const p1 = makeCrossGoalPattern({
      feedbackType: "scope_sizing",
      patternType: "success",
    });
    const p2 = makeCrossGoalPattern({
      feedbackType: "scope_sizing",
      patternType: "failure",
    });
    const p3 = makeCrossGoalPattern({
      feedbackType: "task_generation",
      patternType: "success",
    });

    knowledgeTransfer.storePattern(p1);
    knowledgeTransfer.storePattern(p2);
    knowledgeTransfer.storePattern(p3);

    const result = knowledgeTransfer.retrievePatterns({
      feedbackType: "scope_sizing",
      patternType: "success",
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(p1.id);
  });

  it("should return empty array when no patterns stored", () => {
    const result = knowledgeTransfer.retrievePatterns();
    expect(result).toHaveLength(0);
  });

  it("should return empty array when filter matches nothing", () => {
    const p = makeCrossGoalPattern({ feedbackType: "scope_sizing" });
    knowledgeTransfer.storePattern(p);

    const result = knowledgeTransfer.retrievePatterns({
      feedbackType: "observation_accuracy",
    });
    expect(result).toHaveLength(0);
  });

  it("should overwrite a pattern when the same id is stored again", () => {
    const original = makeCrossGoalPattern({
      feedbackType: "scope_sizing",
      confidence: 0.5,
    });
    const updated = CrossGoalPatternSchema.parse({
      ...original,
      confidence: 0.9,
    });

    knowledgeTransfer.storePattern(original);
    knowledgeTransfer.storePattern(updated);

    const result = knowledgeTransfer.retrievePatterns();
    expect(result).toHaveLength(1);
    expect(result[0]!.confidence).toBe(0.9);
  });
});
