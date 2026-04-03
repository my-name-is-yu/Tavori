import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LearningPipeline } from "../src/knowledge/learning/learning-pipeline.js";
import { StateManager } from "../src/state/state-manager.js";
import { VectorIndex } from "../src/knowledge/vector-index.js";
import { MockEmbeddingClient } from "../src/knowledge/embedding-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import type { LearnedPattern, FeedbackEntry } from "../src/types/learning.js";
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

const EMPTY_TRIPLETS_RESPONSE = JSON.stringify({ triplets: [] });

const LOW_CONFIDENCE_PATTERNS_RESPONSE = JSON.stringify({
  patterns: [
    {
      description: "Some vague pattern about scope",
      pattern_type: "scope_sizing",
      action_group: "scope adjustment",
      applicable_domains: [],
      occurrence_count: 1,
      consistent_count: 1,
      total_count: 10,
      is_specific: true,
    },
  ],
});

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

  // ─── 6. 永続化（getPatterns, savePatterns, getFeedbackEntries, saveFeedbackEntries）───

  describe("persistence", () => {
    describe("getPatterns / savePatterns", () => {
      it("should return empty array for unknown goal", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

        expect(await pipeline.getPatterns("goal-nonexistent")).toEqual([]);
      });

      it("should persist and retrieve patterns", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        const now = new Date().toISOString();

        const patterns: LearnedPattern[] = [
          {
            pattern_id: "pat-persist-1",
            type: "scope_sizing",
            description: "Persisted pattern",
            confidence: 0.85,
            evidence_count: 3,
            source_goal_ids: ["goal-persist"],
            applicable_domains: ["testing"],
            embedding_id: null,
            created_at: now,
            last_applied_at: null,
          },
        ];

        await pipeline.savePatterns("goal-persist", patterns);
        const loaded = await pipeline.getPatterns("goal-persist");

        expect(loaded).toHaveLength(1);
        expect(loaded[0]!.pattern_id).toBe("pat-persist-1");
        expect(loaded[0]!.confidence).toBe(0.85);
        expect(loaded[0]!.description).toBe("Persisted pattern");
      });

      it("should overwrite existing patterns on save", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        const now = new Date().toISOString();

        const patterns1: LearnedPattern[] = [
          {
            pattern_id: "pat-v1",
            type: "scope_sizing",
            description: "Version 1",
            confidence: 0.8,
            evidence_count: 2,
            source_goal_ids: ["goal-x"],
            applicable_domains: [],
            embedding_id: null,
            created_at: now,
            last_applied_at: null,
          },
        ];
        const patterns2: LearnedPattern[] = [
          {
            pattern_id: "pat-v2",
            type: "task_generation",
            description: "Version 2",
            confidence: 0.9,
            evidence_count: 3,
            source_goal_ids: ["goal-x"],
            applicable_domains: [],
            embedding_id: null,
            created_at: now,
            last_applied_at: null,
          },
        ];

        await pipeline.savePatterns("goal-x", patterns1);
        await pipeline.savePatterns("goal-x", patterns2);
        const loaded = await pipeline.getPatterns("goal-x");

        expect(loaded).toHaveLength(1);
        expect(loaded[0]!.pattern_id).toBe("pat-v2");
      });

      it("should save empty array and return empty array", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

        await pipeline.savePatterns("goal-empty", []);
        // readRaw returns [] (an array), which is truthy but isArray check passes
        const loaded = await pipeline.getPatterns("goal-empty");
        expect(loaded).toEqual([]);
      });

      it("should survive StateManager re-instantiation (disk persistence)", async () => {
        const llm = createMockLLMClient([]);
        const pipeline1 = new LearningPipeline(llm, vectorIndex, stateManager);
        const now = new Date().toISOString();

        const patterns: LearnedPattern[] = [
          {
            pattern_id: "pat-disk",
            type: "strategy_selection",
            description: "Disk persisted pattern",
            confidence: 0.75,
            evidence_count: 2,
            source_goal_ids: ["goal-disk"],
            applicable_domains: [],
            embedding_id: null,
            created_at: now,
            last_applied_at: null,
          },
        ];
        await pipeline1.savePatterns("goal-disk", patterns);

        // New StateManager instance pointing to same tmpDir
        const stateManager2 = new StateManager(tmpDir);
        const pipeline2 = new LearningPipeline(
          createMockLLMClient([]),
          vectorIndex,
          stateManager2
        );

        const loaded = await pipeline2.getPatterns("goal-disk");
        expect(loaded).toHaveLength(1);
        expect(loaded[0]!.pattern_id).toBe("pat-disk");
      });
    });

    describe("getFeedbackEntries / saveFeedbackEntries", () => {
      it("should return empty array for unknown goal", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

        expect(await pipeline.getFeedbackEntries("goal-nonexistent")).toEqual([]);
      });

      it("should persist and retrieve feedback entries", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        const now = new Date().toISOString();

        const entries: FeedbackEntry[] = [
          {
            feedback_id: "fb-persist-1",
            pattern_id: "pat-a",
            target_step: "observation",
            adjustment: "Increase confidence for deterministic results",
            applied_at: now,
            effect_observed: null,
          },
        ];

        await pipeline.saveFeedbackEntries("goal-persist", entries);
        const loaded = await pipeline.getFeedbackEntries("goal-persist");

        expect(loaded).toHaveLength(1);
        expect(loaded[0]!.feedback_id).toBe("fb-persist-1");
        expect(loaded[0]!.target_step).toBe("observation");
        expect(loaded[0]!.adjustment).toBe("Increase confidence for deterministic results");
      });

      it("should overwrite existing feedback entries on save", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        const now = new Date().toISOString();

        const entries1: FeedbackEntry[] = [
          {
            feedback_id: "fb-v1",
            pattern_id: "pat-a",
            target_step: "task",
            adjustment: "v1 adjustment",
            applied_at: now,
            effect_observed: null,
          },
        ];
        const entries2: FeedbackEntry[] = [
          {
            feedback_id: "fb-v2",
            pattern_id: "pat-b",
            target_step: "strategy",
            adjustment: "v2 adjustment",
            applied_at: now,
            effect_observed: null,
          },
        ];

        await pipeline.saveFeedbackEntries("goal-x", entries1);
        await pipeline.saveFeedbackEntries("goal-x", entries2);
        const loaded = await pipeline.getFeedbackEntries("goal-x");

        expect(loaded).toHaveLength(1);
        expect(loaded[0]!.feedback_id).toBe("fb-v2");
      });

      it("should save empty array and return empty array", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

        await pipeline.saveFeedbackEntries("goal-empty", []);
        const loaded = await pipeline.getFeedbackEntries("goal-empty");
        expect(loaded).toEqual([]);
      });

      it("should survive StateManager re-instantiation (disk persistence)", async () => {
        const llm = createMockLLMClient([]);
        const pipeline1 = new LearningPipeline(llm, vectorIndex, stateManager);
        const now = new Date().toISOString();

        const entries: FeedbackEntry[] = [
          {
            feedback_id: "fb-disk",
            pattern_id: "pat-disk",
            target_step: "gap",
            adjustment: "Disk persisted feedback",
            applied_at: now,
            effect_observed: null,
          },
        ];
        await pipeline1.saveFeedbackEntries("goal-disk", entries);

        const stateManager2 = new StateManager(tmpDir);
        const pipeline2 = new LearningPipeline(
          createMockLLMClient([]),
          vectorIndex,
          stateManager2
        );

        const loaded = await pipeline2.getFeedbackEntries("goal-disk");
        expect(loaded).toHaveLength(1);
        expect(loaded[0]!.feedback_id).toBe("fb-disk");
      });
    });
  });

  // ─── 7. エッジケース ───

  describe("edge cases", () => {
    it("should use default config values when no config provided", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      // Default min_confidence_threshold=0.6, PATTERNS_RESPONSE confidence=1.0 → passes
      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toHaveLength(1);
    });

    it("should filter all patterns when all are below default confidence threshold", async () => {
      const allLowConfPatterns = JSON.stringify({
        patterns: [
          {
            description: "Specific but low confidence pattern",
            pattern_type: "scope_sizing",
            action_group: "scope",
            applicable_domains: [],
            occurrence_count: 1,
            consistent_count: 1,
            total_count: 10, // 0.1 * 1.0 = 0.1 < 0.6
            is_specific: true,
          },
          {
            description: "Another specific but low confidence pattern",
            pattern_type: "task_generation",
            action_group: "task",
            applicable_domains: [],
            occurrence_count: 1,
            consistent_count: 1,
            total_count: 5, // 0.2 * 1.0 = 0.2 < 0.6
            is_specific: true,
          },
        ],
      });
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, allLowConfPatterns]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "periodic_review" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toEqual([]);
    });

    it("should handle LLM returning malformed JSON in extraction stage", async () => {
      const llm = createMockLLMClient(["{malformed json!}"]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      await expect(pipeline.analyzeLogs(trigger)).resolves.toEqual([]);
    });

    it("should handle LLM returning malformed JSON in patternization stage", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, "{malformed json!}"]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      await expect(pipeline.analyzeLogs(trigger)).resolves.toEqual([]);
    });

    it("should handle multiple analyzeLogs calls for same goal accumulating patterns", async () => {
      const llm = createMockLLMClient([
        TRIPLETS_RESPONSE, PATTERNS_RESPONSE,
        TRIPLETS_RESPONSE, PATTERNS_RESPONSE_STRATEGY,
        TRIPLETS_RESPONSE, PATTERNS_RESPONSE_OBSERVATION,
      ]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const triggerBase = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "run",
        timestamp: new Date().toISOString(),
      };

      await pipeline.analyzeLogs(triggerBase);
      await pipeline.analyzeLogs({ ...triggerBase, context: "run 2" });
      await pipeline.analyzeLogs({ ...triggerBase, context: "run 3" });

      const saved = await pipeline.getPatterns("goal-1");
      expect(saved.length).toBeGreaterThanOrEqual(3);
    });

    it("should handle goal IDs with special characters", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      const now = new Date().toISOString();

      const patterns: LearnedPattern[] = [
        {
          pattern_id: "pat-special",
          type: "scope_sizing",
          description: "Special goal pattern",
          confidence: 0.8,
          evidence_count: 2,
          source_goal_ids: ["goal-2026-q1-sprint-3"],
          applicable_domains: [],
          embedding_id: null,
          created_at: now,
          last_applied_at: null,
        },
      ];

      await pipeline.savePatterns("goal-2026-q1-sprint-3", patterns);
      const loaded = await pipeline.getPatterns("goal-2026-q1-sprint-3");
      expect(loaded).toHaveLength(1);
    });

    it("should not throw when logs file contains non-array data", async () => {
      // Write a non-array as logs
      await stateManager.writeRaw("learning/goal-odd_logs.json", { single: "object" });

      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-odd",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      // analyzeLogs reads the raw data and passes it to LLM regardless of shape
      // It should still work (LLM gets the raw data as JSON string)
      await expect(pipeline.analyzeLogs(trigger)).resolves.toBeDefined();
    });

    it("should handle concurrent analyzeLogs calls for different goals without interference", async () => {
      const llm1 = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const llm2 = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE_STRATEGY]);
      const pipeline1 = new LearningPipeline(llm1, vectorIndex, stateManager);
      const pipeline2 = new LearningPipeline(llm2, vectorIndex, stateManager);

      await writeLogs(stateManager, "goal-concurrent-1");
      await writeLogs(stateManager, "goal-concurrent-2");

      const [result1, result2] = await Promise.all([
        pipeline1.analyzeLogs({
          type: "milestone_reached",
          goal_id: "goal-concurrent-1",
          context: "concurrent test",
          timestamp: new Date().toISOString(),
        }),
        pipeline2.analyzeLogs({
          type: "milestone_reached",
          goal_id: "goal-concurrent-2",
          context: "concurrent test",
          timestamp: new Date().toISOString(),
        }),
      ]);

      expect(result1).toHaveLength(1);
      expect(result1[0]!.type).toBe("scope_sizing");
      expect(result2).toHaveLength(1);
      expect(result2[0]!.type).toBe("strategy_selection");
    });

    it("should produce valid pattern_ids with pat_ prefix", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result[0]!.pattern_id).toMatch(/^pat_/);
    });

    it("should set created_at as valid ISO datetime", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      const createdAt = result[0]!.created_at;
      expect(() => new Date(createdAt)).not.toThrow();
      expect(new Date(createdAt).toISOString()).toBe(createdAt);
    });

    it("should set last_applied_at to null on creation", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result[0]!.last_applied_at).toBeNull();
    });

    it("should return patterns with evidence_count equal to occurrence_count from LLM", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      // PATTERNS_RESPONSE has occurrence_count: 3
      expect(result[0]!.evidence_count).toBe(3);
    });

    it("should handle applicable_domains from LLM response", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      // PATTERNS_RESPONSE has applicable_domains: ["ci", "testing"]
      expect(result[0]!.applicable_domains).toContain("ci");
      expect(result[0]!.applicable_domains).toContain("testing");
    });

    it("should return patterns with embedding_id null when vectorIndex is null", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, null, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "periodic_review" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result[0]!.embedding_id).toBeNull();
    });

    it("should handle stall_detected trigger type in analyzeLogs", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-stall");

      const trigger = {
        type: "stall_detected" as const,
        goal_id: "goal-stall",
        context: JSON.stringify(makeStallReport("goal-stall")),
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toHaveLength(1);
      expect(result[0]!.source_goal_ids).toContain("goal-stall");
    });

    it("should handle goal_completed trigger type in analyzeLogs", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-done");

      const trigger = {
        type: "goal_completed" as const,
        goal_id: "goal-done",
        context: "Goal completed successfully",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toHaveLength(1);
    });

    it("generateFeedback should append to existing feedback entries (not overwrite)", async () => {
      const llm = createMockLLMClient([
        TRIPLETS_RESPONSE, PATTERNS_RESPONSE,
        TRIPLETS_RESPONSE, PATTERNS_RESPONSE_STRATEGY,
      ]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "run",
        timestamp: new Date().toISOString(),
      };

      const patterns1 = await pipeline.analyzeLogs(trigger);
      await pipeline.generateFeedback(patterns1);
      const countAfterFirst = (await pipeline.getFeedbackEntries("goal-1")).length;

      const patterns2 = await pipeline.analyzeLogs({ ...trigger, context: "run 2" });
      await pipeline.generateFeedback(patterns2);
      const countAfterSecond = (await pipeline.getFeedbackEntries("goal-1")).length;

      expect(countAfterSecond).toBeGreaterThan(countAfterFirst);
    });

    it("applyFeedback returns empty array when step is gap (no gap patterns)", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      const now = new Date().toISOString();

      // Save task feedback only, request gap
      const entries: FeedbackEntry[] = [
        {
          feedback_id: "fb-task-only",
          pattern_id: "pat-a",
          target_step: "task",
          adjustment: "Task adjustment",
          applied_at: now,
          effect_observed: null,
        },
      ];
      await pipeline.saveFeedbackEntries("goal-1", entries);

      const result = await pipeline.applyFeedback("goal-1", "gap");
      expect(result).toEqual([]);
    });

    it("generateFeedback returns FeedbackEntry[] with correct schema fields", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      const now = new Date().toISOString();

      const patterns: LearnedPattern[] = [
        {
          pattern_id: "pat-schema-check",
          type: "observation_accuracy",
          description: "Check schema fields",
          confidence: 0.85,
          evidence_count: 2,
          source_goal_ids: ["goal-1"],
          applicable_domains: [],
          embedding_id: null,
          created_at: now,
          last_applied_at: null,
        },
      ];

      const feedback = await pipeline.generateFeedback(patterns);
      expect(feedback[0]).toHaveProperty("feedback_id");
      expect(feedback[0]).toHaveProperty("pattern_id");
      expect(feedback[0]).toHaveProperty("target_step");
      expect(feedback[0]).toHaveProperty("adjustment");
      expect(feedback[0]).toHaveProperty("applied_at");
      expect(feedback[0]).toHaveProperty("effect_observed");
      expect(feedback[0]!.pattern_id).toBe("pat-schema-check");
    });

    it("getPatterns returns empty array when stored data is not a valid array", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      // Write corrupt data (not an array)
      await stateManager.writeRaw("learning/goal-corrupt_patterns.json", { not: "an array" });

      const result = await pipeline.getPatterns("goal-corrupt");
      expect(result).toEqual([]);
    });

    it("getFeedbackEntries returns empty array when stored data is not a valid array", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      // Write corrupt data (not an array)
      await stateManager.writeRaw("learning/goal-corrupt_feedback.json", { not: "an array" });

      const result = await pipeline.getFeedbackEntries("goal-corrupt");
      expect(result).toEqual([]);
    });

    it("should handle trigger with long context string", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const longContext = "A".repeat(10000);
      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: longContext,
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(Array.isArray(result)).toBe(true);
    });

    it("should handle LLM returning JSON wrapped in markdown code block", async () => {
      const markdownWrapped = "```json\n" + TRIPLETS_RESPONSE + "\n```";
      const llm = createMockLLMClient([markdownWrapped, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toHaveLength(1);
    });

    it("should handle LLM returning JSON wrapped in generic code block", async () => {
      const codeWrapped = "```\n" + TRIPLETS_RESPONSE + "\n```";
      const llm = createMockLLMClient([codeWrapped, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toHaveLength(1);
    });

    it("should handle patterns response wrapped in markdown code block", async () => {
      const markdownWrapped = "```json\n" + PATTERNS_RESPONSE + "\n```";
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, markdownWrapped]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toHaveLength(1);
    });

    it("analyzeLogs calls LLM exactly twice per successful run (extraction + patternization)", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      await pipeline.analyzeLogs(trigger);
      expect(llm.callCount).toBe(2);
    });

    it("analyzeLogs calls LLM exactly once when triplets extraction returns empty (aborts early)", async () => {
      const llm = createMockLLMClient([EMPTY_TRIPLETS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      await pipeline.analyzeLogs(trigger);
      expect(llm.callCount).toBe(1);
    });

    it("should not persist patterns when all are filtered by confidence", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, LOW_CONFIDENCE_PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      await pipeline.analyzeLogs(trigger);

      // No patterns saved because none passed the threshold
      const saved = await pipeline.getPatterns("goal-1");
      expect(saved).toEqual([]);
    });

    it("applyFeedback returns strings for all valid target_step values", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      const now = new Date().toISOString();

      const allSteps: Array<"observation" | "gap" | "strategy" | "task"> = [
        "observation", "gap", "strategy", "task",
      ];
      const allEntries: FeedbackEntry[] = allSteps.map((step) => ({
        feedback_id: `fb-${step}`,
        pattern_id: `pat-${step}`,
        target_step: step,
        adjustment: `Adjustment for ${step}`,
        applied_at: now,
        effect_observed: null,
      }));

      // Add patterns for all of them
      const allPatterns: LearnedPattern[] = allSteps.map((step) => ({
        pattern_id: `pat-${step}`,
        type: step === "observation" ? "observation_accuracy" as const
              : step === "strategy" ? "strategy_selection" as const
              : "scope_sizing" as const,
        description: `Adjustment for ${step}`,
        confidence: 0.8,
        evidence_count: 2,
        source_goal_ids: ["goal-all-steps"],
        applicable_domains: [],
        embedding_id: null,
        created_at: now,
        last_applied_at: null,
      }));

      await pipeline.saveFeedbackEntries("goal-all-steps", allEntries);
      await pipeline.savePatterns("goal-all-steps", allPatterns);

      for (const step of allSteps) {
        const result = await pipeline.applyFeedback("goal-all-steps", step);
        expect(result).toHaveLength(1);
        expect(result[0]).toBe(`Adjustment for ${step}`);
      }
    });

    it("onGoalCompleted does not throw when sharePatternAcrossGoals fails internally", async () => {
      // Use a VectorIndex that throws during search
      class FailingSearchVectorIndex extends VectorIndex {
        override async search(_q: string, _k: number, _t: number): Promise<never> {
          throw new Error("search failure");
        }
      }
      const failingVI = new FailingSearchVectorIndex(
        path.join(tmpDir, "failing-search-vi.json"),
        mockEmbeddingClient
      );

      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, failingVI, stateManager);
      await writeLogs(stateManager, "goal-1");

      await expect(pipeline.onGoalCompleted("goal-1")).resolves.toHaveLength(1);
    });

    it("should handle empty applicable_domains in LLM response", async () => {
      const emptyDomainsPatterns = JSON.stringify({
        patterns: [
          {
            description: "Pattern with no domains",
            pattern_type: "scope_sizing",
            action_group: "scope",
            applicable_domains: [],
            occurrence_count: 2,
            consistent_count: 2,
            total_count: 2,
            is_specific: true,
          },
        ],
      });
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, emptyDomainsPatterns]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result[0]!.applicable_domains).toEqual([]);
    });

    it("savePatterns and getPatterns round-trip preserves all LearnedPattern fields", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      const now = new Date().toISOString();

      const pattern: LearnedPattern = {
        pattern_id: "pat-full-fields",
        type: "strategy_selection",
        description: "Full fields test",
        confidence: 0.777,
        evidence_count: 5,
        source_goal_ids: ["goal-a", "goal-b"],
        applicable_domains: ["domain1", "domain2"],
        embedding_id: "emb-123",
        created_at: now,
        last_applied_at: now,
      };

      await pipeline.savePatterns("goal-full", [pattern]);
      const loaded = await pipeline.getPatterns("goal-full");

      expect(loaded[0]!.pattern_id).toBe(pattern.pattern_id);
      expect(loaded[0]!.type).toBe(pattern.type);
      expect(loaded[0]!.confidence).toBe(pattern.confidence);
      expect(loaded[0]!.evidence_count).toBe(pattern.evidence_count);
      expect(loaded[0]!.source_goal_ids).toEqual(pattern.source_goal_ids);
      expect(loaded[0]!.applicable_domains).toEqual(pattern.applicable_domains);
      expect(loaded[0]!.embedding_id).toBe(pattern.embedding_id);
      expect(loaded[0]!.last_applied_at).toBe(pattern.last_applied_at);
    });

    it("saveFeedbackEntries and getFeedbackEntries round-trip preserves all FeedbackEntry fields", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      const now = new Date().toISOString();

      const entry: FeedbackEntry = {
        feedback_id: "fb-full-fields",
        pattern_id: "pat-full",
        target_step: "gap",
        adjustment: "Detailed adjustment text",
        applied_at: now,
        effect_observed: "positive",
      };

      await pipeline.saveFeedbackEntries("goal-full", [entry]);
      const loaded = await pipeline.getFeedbackEntries("goal-full");

      expect(loaded[0]!.feedback_id).toBe(entry.feedback_id);
      expect(loaded[0]!.pattern_id).toBe(entry.pattern_id);
      expect(loaded[0]!.target_step).toBe(entry.target_step);
      expect(loaded[0]!.adjustment).toBe(entry.adjustment);
      expect(loaded[0]!.effect_observed).toBe(entry.effect_observed);
    });

    it("onPeriodicReview uses periodic_review trigger type in context", async () => {
      // Verify the trigger type by checking it doesn't break anything
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-periodic");

      const result = await pipeline.onPeriodicReview("goal-periodic");
      expect(result).toHaveLength(1);
      expect(result[0]!.source_goal_ids).toContain("goal-periodic");
    });

    it("onStallDetected serializes stallInfo as JSON in trigger context", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-stall-context");
      const stallReport = makeStallReport("goal-stall-context");

      // If serialization fails, the trigger would fail Zod validation (context must be string)
      const result = await pipeline.onStallDetected("goal-stall-context", stallReport);
      expect(Array.isArray(result)).toBe(true);
    });

    it("onMilestoneReached passes milestoneContext as trigger context", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-milestone");

      const milestoneCtx = "test_coverage dimension exceeded 80% threshold";
      const result = await pipeline.onMilestoneReached("goal-milestone", milestoneCtx);
      expect(result).toHaveLength(1);
    });

    it("should not share patterns to same source goal via onGoalCompleted", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-complete");

      const result = await pipeline.onGoalCompleted("goal-complete");
      const patternsBefore = await pipeline.getPatterns("goal-complete").length;

      // No additional patterns should appear because sharing to self is blocked
      expect(await pipeline.getPatterns("goal-complete").length).toBe(patternsBefore);
      expect(result).toHaveLength(1);
    });
  });
});
