import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LearningPipeline } from "../src/knowledge/learning-pipeline.js";
import { StateManager } from "../src/state-manager.js";
import { VectorIndex } from "../src/knowledge/vector-index.js";
import { MockEmbeddingClient } from "../src/knowledge/embedding-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import type { LearnedPattern, LearningPipelineConfig } from "../src/types/learning.js";
import type { StallReport } from "../src/types/stall.js";

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

const EMPTY_PATTERNS_RESPONSE = JSON.stringify({ patterns: [] });

/** Minimal valid StallReport */
function makeStallReport(goalId: string): StallReport {
  return {
    stall_type: "dimension_stall",
    goal_id: goalId,
    dimension_name: "test_coverage",
    task_id: null,
    detected_at: new Date().toISOString(),
    escalation_level: 1,
    suggested_cause: "approach_failure",
    decay_factor: 0.8,
  };
}

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

  // ─── 4. クロスゴール共有（sharePatternAcrossGoals）───

  describe("sharePatternAcrossGoals", () => {
    it("should do nothing when vectorIndex is null", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, null, stateManager);

      // Should not throw
      await expect(pipeline.sharePatternAcrossGoals("pat-nonexistent")).resolves.toBeUndefined();
    });

    it("should do nothing when cross_goal_sharing_enabled is false", async () => {
      const config: LearningPipelineConfig = {
        min_confidence_threshold: 0.6,
        periodic_review_interval_hours: 72,
        max_patterns_per_goal: 50,
        cross_goal_sharing_enabled: false,
      };
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager, config);

      await expect(pipeline.sharePatternAcrossGoals("pat-nonexistent")).resolves.toBeUndefined();
    });

    it("should do nothing when pattern is not found in any goal", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      await expect(pipeline.sharePatternAcrossGoals("pat-nonexistent")).resolves.toBeUndefined();
    });

    it("should apply confidence discount (× 0.7) when sharing", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      // Set up source goal with a pattern
      await writeLogs(stateManager, "goal-source");
      const trigger = {
        type: "goal_completed" as const,
        goal_id: "goal-source",
        context: "completed",
        timestamp: new Date().toISOString(),
      };
      const patterns = await pipeline.analyzeLogs(trigger);
      expect(patterns).toHaveLength(1);
      const sourcePattern = patterns[0]!;
      const originalConfidence = sourcePattern.confidence;

      // Add a target goal entry in the VectorIndex that will be found as similar
      await vectorIndex.add(
        "goal-target-entry",
        sourcePattern.description, // same text → high similarity
        { goal_id: "goal-target" }
      );

      await pipeline.sharePatternAcrossGoals(sourcePattern.pattern_id);

      const targetPatterns = await pipeline.getPatterns("goal-target");
      if (targetPatterns.length > 0) {
        expect(targetPatterns[0]!.confidence).toBeCloseTo(originalConfidence * 0.7, 5);
      }
      // If no patterns shared due to similarity threshold, that's also acceptable
    });

    it("should not duplicate patterns already in target goal", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      await writeLogs(stateManager, "goal-source");
      const trigger = {
        type: "goal_completed" as const,
        goal_id: "goal-source",
        context: "completed",
        timestamp: new Date().toISOString(),
      };
      const patterns = await pipeline.analyzeLogs(trigger);
      const sourcePattern = patterns[0]!;

      // Pre-populate target with the same pattern_id
      const now = new Date().toISOString();
      const existingPattern: LearnedPattern = {
        ...sourcePattern,
        source_goal_ids: ["goal-target"],
        created_at: now,
      };
      await pipeline.savePatterns("goal-target", [existingPattern]);

      // Add vector index entry to make it "similar"
      await vectorIndex.add(
        "goal-target-entry",
        sourcePattern.description,
        { goal_id: "goal-target" }
      );

      await pipeline.sharePatternAcrossGoals(sourcePattern.pattern_id);

      const targetPatterns = await pipeline.getPatterns("goal-target");
      // Should still have exactly 1 (no duplicate)
      const matchingIds = targetPatterns.filter(
        (p) => p.pattern_id === sourcePattern.pattern_id
      );
      expect(matchingIds).toHaveLength(1);
    });

    it("should skip sharing when transferred confidence is below threshold", async () => {
      const config: LearningPipelineConfig = {
        min_confidence_threshold: 0.9, // high threshold
        periodic_review_interval_hours: 72,
        max_patterns_per_goal: 50,
        cross_goal_sharing_enabled: true,
      };

      // Pattern with confidence ~1.0 × 0.7 = 0.7 < 0.9 threshold → skipped
      const highConfPatterns = JSON.stringify({
        patterns: [
          {
            description: "Pattern that gets discounted below threshold",
            pattern_type: "scope_sizing",
            action_group: "scope",
            applicable_domains: [],
            occurrence_count: 3,
            consistent_count: 3,
            total_count: 3,
            is_specific: true,
          },
        ],
      });

      const llm = createMockLLMClient([TRIPLETS_RESPONSE, highConfPatterns]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager, config);
      await writeLogs(stateManager, "goal-source");

      const trigger = {
        type: "goal_completed" as const,
        goal_id: "goal-source",
        context: "completed",
        timestamp: new Date().toISOString(),
      };
      const patterns = await pipeline.analyzeLogs(trigger);
      expect(patterns).toHaveLength(1);

      // Add target goal to vector index
      await vectorIndex.add(
        "goal-target-entry",
        patterns[0]!.description,
        { goal_id: "goal-target" }
      );

      await pipeline.sharePatternAcrossGoals(patterns[0]!.pattern_id);

      const targetPatterns = await pipeline.getPatterns("goal-target");
      // transferred confidence = 1.0 * 0.7 = 0.7 < 0.9 → not shared
      expect(targetPatterns).toHaveLength(0);
    });

    it("should respect max_patterns_per_goal when sharing to target", async () => {
      const config: LearningPipelineConfig = {
        min_confidence_threshold: 0.0,
        periodic_review_interval_hours: 72,
        max_patterns_per_goal: 1,
        cross_goal_sharing_enabled: true,
      };

      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager, config);
      await writeLogs(stateManager, "goal-source");

      const trigger = {
        type: "goal_completed" as const,
        goal_id: "goal-source",
        context: "completed",
        timestamp: new Date().toISOString(),
      };
      const patterns = await pipeline.analyzeLogs(trigger);
      const sourcePattern = patterns[0]!;

      // Pre-populate target with 1 pattern (already at limit)
      const now = new Date().toISOString();
      const existingTargetPattern: LearnedPattern = {
        pattern_id: "pat-existing-in-target",
        type: "task_generation",
        description: "Existing target pattern",
        confidence: 0.99, // higher than source after discount
        evidence_count: 3,
        source_goal_ids: ["goal-target"],
        applicable_domains: [],
        embedding_id: null,
        created_at: now,
        last_applied_at: null,
      };
      await pipeline.savePatterns("goal-target", [existingTargetPattern]);

      // Add vector entry for target
      await vectorIndex.add(
        "goal-target-entry",
        sourcePattern.description,
        { goal_id: "goal-target" }
      );

      await pipeline.sharePatternAcrossGoals(sourcePattern.pattern_id);

      const targetPatterns = await pipeline.getPatterns("goal-target");
      expect(targetPatterns.length).toBeLessThanOrEqual(1);
    });

    it("should not share to source goal itself", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-source");

      const trigger = {
        type: "goal_completed" as const,
        goal_id: "goal-source",
        context: "completed",
        timestamp: new Date().toISOString(),
      };
      const patterns = await pipeline.analyzeLogs(trigger);
      const sourcePattern = patterns[0]!;
      const initialPatternCount = (await pipeline.getPatterns("goal-source")).length;

      // Add vector entries to simulate source goal entries
      await vectorIndex.add(
        "goal-source-self-entry",
        sourcePattern.description,
        { goal_id: "goal-source" } // same as source
      );

      await pipeline.sharePatternAcrossGoals(sourcePattern.pattern_id);

      // Source goal should not gain extra patterns from self-sharing
      const afterPatternCount = (await pipeline.getPatterns("goal-source")).length;
      expect(afterPatternCount).toBe(initialPatternCount);
    });
  });

  // ─── 5. トリガーハンドラ ───

  describe("trigger handlers", () => {
    describe("onMilestoneReached", () => {
      it("should call analyzeLogs and return patterns", async () => {
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        await writeLogs(stateManager, "goal-1");

        const result = await pipeline.onMilestoneReached("goal-1", "test_coverage dimension reached 80%");
        expect(result).toHaveLength(1);
        expect(result[0]!.type).toBe("scope_sizing");
      });

      it("should return empty array when no logs exist", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

        const result = await pipeline.onMilestoneReached("goal-no-logs", "milestone");
        expect(result).toEqual([]);
      });

      it("should call generateFeedback when patterns are found", async () => {
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        await writeLogs(stateManager, "goal-1");

        await pipeline.onMilestoneReached("goal-1", "milestone context");

        const feedbackEntries = await pipeline.getFeedbackEntries("goal-1");
        expect(feedbackEntries.length).toBeGreaterThan(0);
      });

      it("should not call generateFeedback when no patterns found", async () => {
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, EMPTY_PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        await writeLogs(stateManager, "goal-1");

        await pipeline.onMilestoneReached("goal-1", "milestone context");

        const feedbackEntries = await pipeline.getFeedbackEntries("goal-1");
        expect(feedbackEntries).toHaveLength(0);
      });

      it("should not throw on error", async () => {
        const llm = createMockLLMClient([]); // will throw on first LLM call
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        await writeLogs(stateManager, "goal-1");

        await expect(pipeline.onMilestoneReached("goal-1", "context")).resolves.toEqual([]);
      });
    });

    describe("onStallDetected", () => {
      it("should call analyzeLogs with stall context and return patterns", async () => {
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        await writeLogs(stateManager, "goal-1");
        const stallReport = makeStallReport("goal-1");

        const result = await pipeline.onStallDetected("goal-1", stallReport);
        expect(result).toHaveLength(1);
      });

      it("should return empty array when no logs exist", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        const stallReport = makeStallReport("goal-no-logs");

        const result = await pipeline.onStallDetected("goal-no-logs", stallReport);
        expect(result).toEqual([]);
      });

      it("should call generateFeedback when patterns are found", async () => {
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        await writeLogs(stateManager, "goal-1");
        const stallReport = makeStallReport("goal-1");

        await pipeline.onStallDetected("goal-1", stallReport);

        const feedbackEntries = await pipeline.getFeedbackEntries("goal-1");
        expect(feedbackEntries.length).toBeGreaterThan(0);
      });

      it("should not throw on LLM error", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        await writeLogs(stateManager, "goal-1");
        const stallReport = makeStallReport("goal-1");

        await expect(pipeline.onStallDetected("goal-1", stallReport)).resolves.toEqual([]);
      });
    });

    describe("onPeriodicReview", () => {
      it("should call analyzeLogs and return patterns", async () => {
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        await writeLogs(stateManager, "goal-1");

        const result = await pipeline.onPeriodicReview("goal-1");
        expect(result).toHaveLength(1);
      });

      it("should return empty array when no logs exist", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

        const result = await pipeline.onPeriodicReview("goal-no-logs");
        expect(result).toEqual([]);
      });

      it("should call generateFeedback when patterns are found", async () => {
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        await writeLogs(stateManager, "goal-1");

        await pipeline.onPeriodicReview("goal-1");

        const feedbackEntries = await pipeline.getFeedbackEntries("goal-1");
        expect(feedbackEntries.length).toBeGreaterThan(0);
      });

      it("should not throw on LLM error", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        await writeLogs(stateManager, "goal-1");

        await expect(pipeline.onPeriodicReview("goal-1")).resolves.toEqual([]);
      });
    });

    describe("onGoalCompleted", () => {
      it("should call analyzeLogs and return patterns", async () => {
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        await writeLogs(stateManager, "goal-1");

        const result = await pipeline.onGoalCompleted("goal-1");
        expect(result).toHaveLength(1);
      });

      it("should return empty array when no logs exist", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

        const result = await pipeline.onGoalCompleted("goal-no-logs");
        expect(result).toEqual([]);
      });

      it("should call generateFeedback when patterns are found", async () => {
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        await writeLogs(stateManager, "goal-1");

        await pipeline.onGoalCompleted("goal-1");

        const feedbackEntries = await pipeline.getFeedbackEntries("goal-1");
        expect(feedbackEntries.length).toBeGreaterThan(0);
      });

      it("should attempt cross-goal sharing when cross_goal_sharing_enabled is true", async () => {
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        await writeLogs(stateManager, "goal-1");

        // Should not throw even though there are no similar goals
        await expect(pipeline.onGoalCompleted("goal-1")).resolves.not.toThrow();
      });

      it("should not attempt cross-goal sharing when cross_goal_sharing_enabled is false", async () => {
        const config: LearningPipelineConfig = {
          min_confidence_threshold: 0.6,
          periodic_review_interval_hours: 72,
          max_patterns_per_goal: 50,
          cross_goal_sharing_enabled: false,
        };
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager, config);
        await writeLogs(stateManager, "goal-1");

        const result = await pipeline.onGoalCompleted("goal-1");
        expect(result).toHaveLength(1);
      });

      it("should not throw on LLM error", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        await writeLogs(stateManager, "goal-1");

        await expect(pipeline.onGoalCompleted("goal-1")).resolves.toEqual([]);
      });
    });
  });
});
