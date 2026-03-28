import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LearningPipeline } from "../src/knowledge/learning-pipeline.js";
import { StateManager } from "../src/state-manager.js";
import { VectorIndex } from "../src/knowledge/vector-index.js";
import { MockEmbeddingClient } from "../src/knowledge/embedding-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import type { LearnedPattern, FeedbackEntry } from "../src/types/learning.js";

// ─── Fixtures ───

const TRIPLETS_RESPONSE = JSON.stringify({
  triplets: [
    {
      state_context: "3 failing tests blocking CI",
      action_taken: "reduced task scope to 3 steps",
      outcome: "CI passed after scope reduction",
      gap_delta: -0.3,
    },
    {
      state_context: "4 failing tests blocking CI",
      action_taken: "reduced task scope to 3 steps",
      outcome: "CI passed after scope reduction",
      gap_delta: -0.25,
    },
    {
      state_context: "2 failing tests blocking CI",
      action_taken: "reduced task scope to 3 steps",
      outcome: "CI passed after scope reduction",
      gap_delta: -0.2,
    },
  ],
});

const PATTERNS_RESPONSE = JSON.stringify({
  patterns: [
    {
      description: "When CI is blocked by failing tests, reduce task scope to 3 steps to unblock",
      pattern_type: "scope_sizing",
      action_group: "scope reduction",
      applicable_domains: ["ci", "testing"],
      occurrence_count: 3,
      consistent_count: 3,
      total_count: 3,
      is_specific: true,
    },
  ],
});

const PATTERNS_RESPONSE_OBSERVATION = JSON.stringify({
  patterns: [
    {
      description: "Increase observation confidence when test results are deterministic",
      pattern_type: "observation_accuracy",
      action_group: "confidence adjustment",
      applicable_domains: ["testing"],
      occurrence_count: 2,
      consistent_count: 2,
      total_count: 3,
      is_specific: true,
    },
  ],
});

const PATTERNS_RESPONSE_STRATEGY = JSON.stringify({
  patterns: [
    {
      description: "Use incremental strategy when dealing with complex refactors",
      pattern_type: "strategy_selection",
      action_group: "incremental approach",
      applicable_domains: ["refactoring"],
      occurrence_count: 2,
      consistent_count: 2,
      total_count: 3,
      is_specific: true,
    },
  ],
});

const PATTERNS_RESPONSE_TASK_GEN = JSON.stringify({
  patterns: [
    {
      description: "Add prerequisite check at the start of every task",
      pattern_type: "task_generation",
      action_group: "prerequisite checking",
      applicable_domains: ["general"],
      occurrence_count: 2,
      consistent_count: 2,
      total_count: 3,
      is_specific: true,
    },
  ],
});

/** Write a logs file for a goal so analyzeLogs has data to work with */
async function writeLogs(stateManager: StateManager, goalId: string, data: unknown = [{ task: "test" }]): Promise<void> {
  await stateManager.writeRaw(`learning/${goalId}_logs.json`, data);
}

// ─── Tests ───

describe("LearningPipeline", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let mockEmbeddingClient: MockEmbeddingClient;
  let vectorIndex: VectorIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-learning-test-"));
    stateManager = new StateManager(tmpDir);
    mockEmbeddingClient = new MockEmbeddingClient(4); // tiny 4-dim vectors for speed
    vectorIndex = new VectorIndex(
      path.join(tmpDir, "vector-index.json"),
      mockEmbeddingClient
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── 2. フィードバック生成（generateFeedback）───

  describe("generateFeedback", () => {
    it("should return empty array for empty patterns list", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      const result = await pipeline.generateFeedback([]);
      expect(result).toEqual([]);
    });

    it("should map observation_accuracy pattern to target_step=observation", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE_OBSERVATION]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const patterns = await pipeline.analyzeLogs(trigger);
      const feedback = await pipeline.generateFeedback(patterns);

      expect(feedback[0]!.target_step).toBe("observation");
    });

    it("should map strategy_selection pattern to target_step=strategy", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE_STRATEGY]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const patterns = await pipeline.analyzeLogs(trigger);
      const feedback = await pipeline.generateFeedback(patterns);

      expect(feedback[0]!.target_step).toBe("strategy");
    });

    it("should map scope_sizing pattern to target_step=task", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const patterns = await pipeline.analyzeLogs(trigger);
      const feedback = await pipeline.generateFeedback(patterns);

      expect(feedback[0]!.target_step).toBe("task");
    });

    it("should map task_generation pattern to target_step=task", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE_TASK_GEN]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const patterns = await pipeline.analyzeLogs(trigger);
      const feedback = await pipeline.generateFeedback(patterns);

      expect(feedback[0]!.target_step).toBe("task");
    });

    it("should set adjustment to pattern description", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const patterns = await pipeline.analyzeLogs(trigger);
      const feedback = await pipeline.generateFeedback(patterns);

      expect(feedback[0]!.adjustment).toBe(patterns[0]!.description);
    });

    it("should produce unique feedback_ids for multiple patterns", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      const now = new Date().toISOString();
      const patterns: LearnedPattern[] = [
        {
          pattern_id: "pat-a",
          type: "scope_sizing",
          description: "Pattern A description",
          confidence: 0.9,
          evidence_count: 3,
          source_goal_ids: ["goal-1"],
          applicable_domains: [],
          embedding_id: null,
          created_at: now,
          last_applied_at: null,
        },
        {
          pattern_id: "pat-b",
          type: "task_generation",
          description: "Pattern B description",
          confidence: 0.8,
          evidence_count: 2,
          source_goal_ids: ["goal-1"],
          applicable_domains: [],
          embedding_id: null,
          created_at: now,
          last_applied_at: null,
        },
      ];

      const feedback = await pipeline.generateFeedback(patterns);
      expect(feedback).toHaveLength(2);
      const ids = feedback.map((f) => f.feedback_id);
      expect(new Set(ids).size).toBe(2);
    });

    it("should persist feedback entries to state manager", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const patterns = await pipeline.analyzeLogs(trigger);
      await pipeline.generateFeedback(patterns);

      const saved = await pipeline.getFeedbackEntries("goal-1");
      expect(saved.length).toBeGreaterThan(0);
    });

    it("should set effect_observed to null on creation", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      const now = new Date().toISOString();
      const patterns: LearnedPattern[] = [
        {
          pattern_id: "pat-a",
          type: "scope_sizing",
          description: "Reduce scope",
          confidence: 0.9,
          evidence_count: 3,
          source_goal_ids: ["goal-1"],
          applicable_domains: [],
          embedding_id: null,
          created_at: now,
          last_applied_at: null,
        },
      ];

      const feedback = await pipeline.generateFeedback(patterns);
      expect(feedback[0]!.effect_observed).toBeNull();
    });

    it("should handle patterns from multiple source goals correctly", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      const now = new Date().toISOString();
      const patterns: LearnedPattern[] = [
        {
          pattern_id: "pat-a",
          type: "scope_sizing",
          description: "Pattern for goal-1",
          confidence: 0.9,
          evidence_count: 3,
          source_goal_ids: ["goal-1"],
          applicable_domains: [],
          embedding_id: null,
          created_at: now,
          last_applied_at: null,
        },
        {
          pattern_id: "pat-b",
          type: "strategy_selection",
          description: "Pattern for goal-2",
          confidence: 0.8,
          evidence_count: 2,
          source_goal_ids: ["goal-2"],
          applicable_domains: [],
          embedding_id: null,
          created_at: now,
          last_applied_at: null,
        },
      ];

      await pipeline.generateFeedback(patterns);

      const goal1Feedback = await pipeline.getFeedbackEntries("goal-1");
      const goal2Feedback = await pipeline.getFeedbackEntries("goal-2");
      expect(goal1Feedback).toHaveLength(1);
      expect(goal2Feedback).toHaveLength(1);
    });

    it("should skip patterns with empty source_goal_ids", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      const now = new Date().toISOString();
      const patterns: LearnedPattern[] = [
        {
          pattern_id: "pat-a",
          type: "scope_sizing",
          description: "Pattern with no source",
          confidence: 0.9,
          evidence_count: 3,
          source_goal_ids: [], // empty → skipped in byGoal grouping
          applicable_domains: [],
          embedding_id: null,
          created_at: now,
          last_applied_at: null,
        },
      ];

      const feedback = await pipeline.generateFeedback(patterns);
      // Returns entries but no feedback is saved to any goal
      expect(feedback).toHaveLength(1);
    });
  });

  // ─── 3. フィードバック適用（applyFeedback）───

  describe("applyFeedback", () => {
    async function makePatternAndFeedback(
      pipeline: LearningPipeline,
      goalId: string,
      step: "observation" | "strategy" | "task",
      description: string,
      confidence: number
    ): Promise<void> {
      const now = new Date().toISOString();
      const patternId = `pat-${Math.random().toString(36).slice(2)}`;
      const pattern: LearnedPattern = {
        pattern_id: patternId,
        type: step === "observation" ? "observation_accuracy" : step === "strategy" ? "strategy_selection" : "scope_sizing",
        description,
        confidence,
        evidence_count: 2,
        source_goal_ids: [goalId],
        applicable_domains: [],
        embedding_id: null,
        created_at: now,
        last_applied_at: null,
      };
      const existing = await pipeline.getPatterns(goalId);
      await pipeline.savePatterns(goalId, [...existing, pattern]);
      await pipeline.generateFeedback([pattern]);
    }

    it("should return empty array for goal with no feedback entries", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      const result = await pipeline.applyFeedback("goal-nonexistent", "observation");
      expect(result).toEqual([]);
    });

    it("should return empty array when no feedback entries match the step", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await makePatternAndFeedback(pipeline, "goal-1", "strategy", "Use incremental approach", 0.9);

      const result = await pipeline.applyFeedback("goal-1", "observation"); // different step
      expect(result).toEqual([]);
    });

    it("should return only feedback entries matching the requested step", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await makePatternAndFeedback(pipeline, "goal-1", "observation", "Observation feedback", 0.9);
      await makePatternAndFeedback(pipeline, "goal-1", "strategy", "Strategy feedback", 0.8);

      const result = await pipeline.applyFeedback("goal-1", "observation");
      expect(result).toHaveLength(1);
      expect(result[0]).toBe("Observation feedback");
    });

    it("should sort feedback by pattern confidence descending", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await makePatternAndFeedback(pipeline, "goal-1", "task", "Low confidence pattern", 0.65);
      await makePatternAndFeedback(pipeline, "goal-1", "task", "High confidence pattern", 0.95);
      await makePatternAndFeedback(pipeline, "goal-1", "task", "Medium confidence pattern", 0.8);

      const result = await pipeline.applyFeedback("goal-1", "task");
      expect(result[0]).toBe("High confidence pattern");
      expect(result[1]).toBe("Medium confidence pattern");
      expect(result[2]).toBe("Low confidence pattern");
    });

    it("should return at most 3 feedback entries", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      // Add 5 feedback entries for the same step
      for (let i = 0; i < 5; i++) {
        await makePatternAndFeedback(pipeline, "goal-1", "task", `Pattern ${i}`, 0.7 + i * 0.01);
      }

      const result = await pipeline.applyFeedback("goal-1", "task");
      expect(result).toHaveLength(3);
    });

    it("should return adjustment strings (not FeedbackEntry objects)", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await makePatternAndFeedback(pipeline, "goal-1", "strategy", "Use incremental approach", 0.9);

      const result = await pipeline.applyFeedback("goal-1", "strategy");
      expect(typeof result[0]).toBe("string");
      expect(result[0]).toBe("Use incremental approach");
    });

    it("should use pattern confidence for sorting (not feedback order)", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      // Add patterns with known confidences in reverse order
      await makePatternAndFeedback(pipeline, "goal-1", "task", "Third", 0.7);
      await makePatternAndFeedback(pipeline, "goal-1", "task", "First", 0.95);
      await makePatternAndFeedback(pipeline, "goal-1", "task", "Second", 0.85);

      const result = await pipeline.applyFeedback("goal-1", "task");
      expect(result).toEqual(["First", "Second", "Third"]);
    });

    it("should return all entries if 3 or fewer exist", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await makePatternAndFeedback(pipeline, "goal-1", "observation", "Feedback A", 0.9);
      await makePatternAndFeedback(pipeline, "goal-1", "observation", "Feedback B", 0.8);

      const result = await pipeline.applyFeedback("goal-1", "observation");
      expect(result).toHaveLength(2);
    });

    it("should use 0 confidence for patterns not found in pattern list", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      // Manually save a feedback entry without a corresponding pattern
      const now = new Date().toISOString();
      const orphanFeedback: FeedbackEntry = {
        feedback_id: "fb-orphan",
        pattern_id: "pat-nonexistent",
        target_step: "task",
        adjustment: "Orphan feedback",
        applied_at: now,
        effect_observed: null,
      };
      await pipeline.saveFeedbackEntries("goal-1", [orphanFeedback]);

      const result = await pipeline.applyFeedback("goal-1", "task");
      expect(result).toContain("Orphan feedback");
    });
  });
});
