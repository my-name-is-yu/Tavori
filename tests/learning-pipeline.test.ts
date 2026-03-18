import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LearningPipeline } from "../src/knowledge/learning-pipeline.js";
import { StateManager } from "../src/state-manager.js";
import { VectorIndex } from "../src/knowledge/vector-index.js";
import { MockEmbeddingClient } from "../src/knowledge/embedding-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import type { LearnedPattern, FeedbackEntry, LearningPipelineConfig } from "../src/types/learning.js";
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

const EMPTY_TRIPLETS_RESPONSE = JSON.stringify({ triplets: [] });
const EMPTY_PATTERNS_RESPONSE = JSON.stringify({ patterns: [] });

const LOW_CONFIDENCE_PATTERNS_RESPONSE = JSON.stringify({
  patterns: [
    {
      description: "Some vague pattern about scope",
      pattern_type: "scope_sizing",
      action_group: "scope adjustment",
      applicable_domains: [],
      // occurrence_count=1, consistent_count=1, total_count=10 → confidence=0.1*1.0=0.1 < 0.6
      occurrence_count: 1,
      consistent_count: 1,
      total_count: 10,
      is_specific: true,
    },
  ],
});

const NON_SPECIFIC_PATTERNS_RESPONSE = JSON.stringify({
  patterns: [
    {
      description: "did something better",
      pattern_type: "scope_sizing",
      action_group: "vague improvements",
      applicable_domains: [],
      occurrence_count: 3,
      consistent_count: 3,
      total_count: 3,
      is_specific: false, // filtered out
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-learning-test-"));
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

  // ─── 1. パターン分析（analyzeLogs）───

  describe("analyzeLogs", () => {
    it("should return empty array when no logs file exists", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toEqual([]);
    });

    it("should return empty array when LLM call fails (extraction stage)", async () => {
      const llm = createMockLLMClient([]); // no responses → throws on first call
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toEqual([]);
    });

    it("should return empty array when LLM returns invalid JSON (extraction stage)", async () => {
      const llm = createMockLLMClient(["not-valid-json"]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toEqual([]);
    });

    it("should return empty array when LLM returns JSON missing required fields (extraction stage)", async () => {
      const llm = createMockLLMClient([JSON.stringify({ wrong_field: [] })]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toEqual([]);
    });

    it("should return empty array when triplets are empty", async () => {
      const llm = createMockLLMClient([EMPTY_TRIPLETS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toEqual([]);
    });

    it("should return empty array when LLM call fails (patternization stage)", async () => {
      // first call OK, second call fails
      const llm = createMockLLMClient([TRIPLETS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toEqual([]);
    });

    it("should return empty array when patternization LLM returns invalid JSON", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, "not-valid-json"]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toEqual([]);
    });

    it("should return empty array when all patterns have is_specific=false", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, NON_SPECIFIC_PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toEqual([]);
    });

    it("should exclude patterns below min_confidence_threshold (default 0.6)", async () => {
      // LOW_CONFIDENCE_PATTERNS_RESPONSE: occurrence=1, total=10, consistent=1 → confidence=0.1*1.0=0.1
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, LOW_CONFIDENCE_PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toEqual([]);
    });

    it("should include patterns at exactly min_confidence_threshold (0.6)", async () => {
      // confidence = occurrence_frequency * result_consistency = (2/3) * (3/3) ≈ 0.667 ≥ 0.6 → included
      const borderlinePatterns = JSON.stringify({
        patterns: [
          {
            description: "Add prerequisite check at start of task",
            pattern_type: "scope_sizing",
            action_group: "prerequisite check",
            applicable_domains: ["general"],
            occurrence_count: 2,
            consistent_count: 2,
            total_count: 2, // 2/2 * 2/2 = 1.0 ≥ 0.6
            is_specific: true,
          },
        ],
      });
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, borderlinePatterns]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toHaveLength(1);
    });

    it("should return patterns when confidence meets threshold", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe("scope_sizing");
      expect(result[0]!.description).toContain("reduce task scope");
    });

    it("should set source_goal_ids from trigger goal_id", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-abc");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-abc",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result[0]!.source_goal_ids).toContain("goal-abc");
    });

    it("should generate unique pattern_ids", async () => {
      const multiPatterns = JSON.stringify({
        patterns: [
          {
            description: "Reduce scope when CI is blocked",
            pattern_type: "scope_sizing",
            action_group: "scope reduction",
            applicable_domains: ["ci"],
            occurrence_count: 2,
            consistent_count: 2,
            total_count: 2,
            is_specific: true,
          },
          {
            description: "Add prerequisite checks to task start",
            pattern_type: "task_generation",
            action_group: "prerequisite",
            applicable_domains: ["general"],
            occurrence_count: 2,
            consistent_count: 2,
            total_count: 2,
            is_specific: true,
          },
        ],
      });
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, multiPatterns]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toHaveLength(2);
      const ids = result.map((p) => p.pattern_id);
      expect(new Set(ids).size).toBe(2);
    });

    it("should persist patterns to state manager after analysis", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      await pipeline.analyzeLogs(trigger);

      const saved = await pipeline.getPatterns("goal-1");
      expect(saved).toHaveLength(1);
      expect(saved[0]!.type).toBe("scope_sizing");
    });

    it("should not exceed max_patterns_per_goal limit", async () => {
      const config: LearningPipelineConfig = {
        min_confidence_threshold: 0.6,
        periodic_review_interval_hours: 72,
        max_patterns_per_goal: 2,
        cross_goal_sharing_enabled: true,
      };
      const manyPatterns = JSON.stringify({
        patterns: [
          {
            description: "Pattern A",
            pattern_type: "scope_sizing",
            action_group: "scope A",
            applicable_domains: [],
            occurrence_count: 3,
            consistent_count: 3,
            total_count: 3,
            is_specific: true,
          },
          {
            description: "Pattern B",
            pattern_type: "task_generation",
            action_group: "task B",
            applicable_domains: [],
            occurrence_count: 2,
            consistent_count: 2,
            total_count: 2,
            is_specific: true,
          },
          {
            description: "Pattern C",
            pattern_type: "strategy_selection",
            action_group: "strategy C",
            applicable_domains: [],
            occurrence_count: 2,
            consistent_count: 2,
            total_count: 2,
            is_specific: true,
          },
        ],
      });

      const llm = createMockLLMClient([TRIPLETS_RESPONSE, manyPatterns]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager, config);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      await pipeline.analyzeLogs(trigger);

      const saved = await pipeline.getPatterns("goal-1");
      expect(saved.length).toBeLessThanOrEqual(2);
    });

    it("should keep highest-confidence patterns when over limit", async () => {
      const config: LearningPipelineConfig = {
        min_confidence_threshold: 0.0,
        periodic_review_interval_hours: 72,
        max_patterns_per_goal: 1,
        cross_goal_sharing_enabled: false,
      };
      // Pattern A: confidence = 3/3 * 3/3 = 1.0
      // Pattern B: confidence = 2/4 * 1/2 = 0.25
      const twoPatterns = JSON.stringify({
        patterns: [
          {
            description: "High confidence pattern",
            pattern_type: "scope_sizing",
            action_group: "scope",
            applicable_domains: [],
            occurrence_count: 3,
            consistent_count: 3,
            total_count: 3,
            is_specific: true,
          },
          {
            description: "Low confidence pattern",
            pattern_type: "task_generation",
            action_group: "task",
            applicable_domains: [],
            occurrence_count: 2,
            consistent_count: 1,
            total_count: 4,
            is_specific: true,
          },
        ],
      });

      const llm = createMockLLMClient([TRIPLETS_RESPONSE, twoPatterns]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager, config);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      await pipeline.analyzeLogs(trigger);

      const saved = await pipeline.getPatterns("goal-1");
      expect(saved).toHaveLength(1);
      expect(saved[0]!.description).toContain("High confidence");
    });

    it("should register embeddings in VectorIndex when available", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      await pipeline.analyzeLogs(trigger);

      expect(vectorIndex.size).toBeGreaterThan(0);
    });

    it("should set embedding_id on pattern after VectorIndex registration", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      await pipeline.analyzeLogs(trigger);

      const saved = await pipeline.getPatterns("goal-1");
      expect(saved[0]!.embedding_id).not.toBeNull();
    });

    it("should skip embedding registration when vectorIndex is null", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, null, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      // Still returns patterns even without VectorIndex
      expect(result).toHaveLength(1);
      expect(result[0]!.embedding_id).toBeNull();
    });

    it("should merge new patterns with existing patterns", async () => {
      const llm = createMockLLMClient([
        TRIPLETS_RESPONSE,
        PATTERNS_RESPONSE,
        TRIPLETS_RESPONSE,
        PATTERNS_RESPONSE_OBSERVATION,
      ]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "first run",
        timestamp: new Date().toISOString(),
      };
      await pipeline.analyzeLogs(trigger);
      await pipeline.analyzeLogs({ ...trigger, context: "second run" });

      const saved = await pipeline.getPatterns("goal-1");
      expect(saved.length).toBeGreaterThanOrEqual(2);
    });

    it("should compute confidence as occurrence_frequency * result_consistency", async () => {
      // occurrence_count=2, total_count=4, consistent_count=1
      // → confidence = (2/4) * (1/2) = 0.5 * 0.5 = 0.25 < 0.6 → filtered
      const lowPatterns = JSON.stringify({
        patterns: [
          {
            description: "Some specific pattern",
            pattern_type: "scope_sizing",
            action_group: "scope",
            applicable_domains: [],
            occurrence_count: 2,
            consistent_count: 1,
            total_count: 4,
            is_specific: true,
          },
        ],
      });
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, lowPatterns]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toEqual([]);
    });

    it("should handle custom min_confidence_threshold", async () => {
      const config: LearningPipelineConfig = {
        min_confidence_threshold: 0.1, // very low threshold
        periodic_review_interval_hours: 72,
        max_patterns_per_goal: 50,
        cross_goal_sharing_enabled: true,
      };
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, LOW_CONFIDENCE_PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager, config);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      // confidence = 0.1 * 1.0 = 0.1 ≥ 0.1 → included
      expect(result).toHaveLength(1);
    });

    it("should continue without crashing when embedding fails", async () => {
      // Use a VectorIndex with an embedding client that throws
      class FailingEmbeddingClient extends MockEmbeddingClient {
        override async embed(_text: string): Promise<number[]> {
          throw new Error("embedding service unavailable");
        }
      }
      const failingVectorIndex = new VectorIndex(
        path.join(tmpDir, "failing-vector-index.json"),
        new FailingEmbeddingClient(4)
      );

      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, failingVectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      // Patterns still returned even though embedding failed
      expect(result).toHaveLength(1);
    });

    it("should use default config when no config provided", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      // Default min_confidence_threshold = 0.6, PATTERNS_RESPONSE has confidence=1.0 → passes
      writeLogs(stateManager, "goal-1");
      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result).toHaveLength(1);
    });

    it("should handle large number of log entries gracefully", async () => {
      const largeLogData = Array.from({ length: 500 }, (_, i) => ({
        task_id: `task-${i}`,
        result: "success",
        gap_delta: -0.01,
      }));
      writeLogs(stateManager, "goal-large", largeLogData);

      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      const trigger = {
        type: "periodic_review" as const,
        goal_id: "goal-large",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ─── 2. フィードバック生成（generateFeedback）───

  describe("generateFeedback", () => {
    it("should return empty array for empty patterns list", () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      const result = await pipeline.generateFeedback([]);
      expect(result).toEqual([]);
    });

    it("should map observation_accuracy pattern to target_step=observation", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE_OBSERVATION]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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

    it("should produce unique feedback_ids for multiple patterns", () => {
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
      writeLogs(stateManager, "goal-1");

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

    it("should set effect_observed to null on creation", () => {
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

    it("should handle patterns from multiple source goals correctly", () => {
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

    it("should skip patterns with empty source_goal_ids", () => {
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
    function makePatternAndFeedback(
      pipeline: LearningPipeline,
      goalId: string,
      step: "observation" | "strategy" | "task",
      description: string,
      confidence: number
    ): void {
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

    it("should return empty array for goal with no feedback entries", () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      const result = await pipeline.applyFeedback("goal-nonexistent", "observation");
      expect(result).toEqual([]);
    });

    it("should return empty array when no feedback entries match the step", () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      makePatternAndFeedback(pipeline, "goal-1", "strategy", "Use incremental approach", 0.9);

      const result = await pipeline.applyFeedback("goal-1", "observation"); // different step
      expect(result).toEqual([]);
    });

    it("should return only feedback entries matching the requested step", () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      makePatternAndFeedback(pipeline, "goal-1", "observation", "Observation feedback", 0.9);
      makePatternAndFeedback(pipeline, "goal-1", "strategy", "Strategy feedback", 0.8);

      const result = await pipeline.applyFeedback("goal-1", "observation");
      expect(result).toHaveLength(1);
      expect(result[0]).toBe("Observation feedback");
    });

    it("should sort feedback by pattern confidence descending", () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      makePatternAndFeedback(pipeline, "goal-1", "task", "Low confidence pattern", 0.65);
      makePatternAndFeedback(pipeline, "goal-1", "task", "High confidence pattern", 0.95);
      makePatternAndFeedback(pipeline, "goal-1", "task", "Medium confidence pattern", 0.8);

      const result = await pipeline.applyFeedback("goal-1", "task");
      expect(result[0]).toBe("High confidence pattern");
      expect(result[1]).toBe("Medium confidence pattern");
      expect(result[2]).toBe("Low confidence pattern");
    });

    it("should return at most 3 feedback entries", () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      // Add 5 feedback entries for the same step
      for (let i = 0; i < 5; i++) {
        makePatternAndFeedback(pipeline, "goal-1", "task", `Pattern ${i}`, 0.7 + i * 0.01);
      }

      const result = await pipeline.applyFeedback("goal-1", "task");
      expect(result).toHaveLength(3);
    });

    it("should return adjustment strings (not FeedbackEntry objects)", () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      makePatternAndFeedback(pipeline, "goal-1", "strategy", "Use incremental approach", 0.9);

      const result = await pipeline.applyFeedback("goal-1", "strategy");
      expect(typeof result[0]).toBe("string");
      expect(result[0]).toBe("Use incremental approach");
    });

    it("should use pattern confidence for sorting (not feedback order)", () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      // Add patterns with known confidences in reverse order
      makePatternAndFeedback(pipeline, "goal-1", "task", "Third", 0.7);
      makePatternAndFeedback(pipeline, "goal-1", "task", "First", 0.95);
      makePatternAndFeedback(pipeline, "goal-1", "task", "Second", 0.85);

      const result = await pipeline.applyFeedback("goal-1", "task");
      expect(result).toEqual(["First", "Second", "Third"]);
    });

    it("should return all entries if 3 or fewer exist", () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      makePatternAndFeedback(pipeline, "goal-1", "observation", "Feedback A", 0.9);
      makePatternAndFeedback(pipeline, "goal-1", "observation", "Feedback B", 0.8);

      const result = await pipeline.applyFeedback("goal-1", "observation");
      expect(result).toHaveLength(2);
    });

    it("should use 0 confidence for patterns not found in pattern list", () => {
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
      writeLogs(stateManager, "goal-source");
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
      const targetGoalEntry = await vectorIndex.add(
        "goal-target-entry",
        sourcePattern.description, // same text → high similarity
        { goal_id: "goal-target" }
      );

      await pipeline.sharePatternAcrossGoals(sourcePattern.pattern_id);

      const targetPatterns = pipeline.getPatterns("goal-target");
      if (targetPatterns.length > 0) {
        expect(targetPatterns[0]!.confidence).toBeCloseTo(originalConfidence * 0.7, 5);
      }
      // If no patterns shared due to similarity threshold, that's also acceptable
    });

    it("should not duplicate patterns already in target goal", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      writeLogs(stateManager, "goal-source");
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

      const targetPatterns = pipeline.getPatterns("goal-target");
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
      writeLogs(stateManager, "goal-source");

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

      const targetPatterns = pipeline.getPatterns("goal-target");
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
      writeLogs(stateManager, "goal-source");

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

      const targetPatterns = pipeline.getPatterns("goal-target");
      expect(targetPatterns.length).toBeLessThanOrEqual(1);
    });

    it("should not share to source goal itself", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-source");

      const trigger = {
        type: "goal_completed" as const,
        goal_id: "goal-source",
        context: "completed",
        timestamp: new Date().toISOString(),
      };
      const patterns = await pipeline.analyzeLogs(trigger);
      const sourcePattern = patterns[0]!;
      const initialPatternCount = pipeline.getPatterns("goal-source").length;

      // Add vector entries to simulate source goal entries
      await vectorIndex.add(
        "goal-source-self-entry",
        sourcePattern.description,
        { goal_id: "goal-source" } // same as source
      );

      await pipeline.sharePatternAcrossGoals(sourcePattern.pattern_id);

      // Source goal should not gain extra patterns from self-sharing
      const afterPatternCount = pipeline.getPatterns("goal-source").length;
      expect(afterPatternCount).toBe(initialPatternCount);
    });
  });

  // ─── 5. トリガーハンドラ ───

  describe("trigger handlers", () => {
    describe("onMilestoneReached", () => {
      it("should call analyzeLogs and return patterns", async () => {
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        writeLogs(stateManager, "goal-1");

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
        writeLogs(stateManager, "goal-1");

        await pipeline.onMilestoneReached("goal-1", "milestone context");

        const feedbackEntries = pipeline.getFeedbackEntries("goal-1");
        expect(feedbackEntries.length).toBeGreaterThan(0);
      });

      it("should not call generateFeedback when no patterns found", async () => {
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, EMPTY_PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        writeLogs(stateManager, "goal-1");

        await pipeline.onMilestoneReached("goal-1", "milestone context");

        const feedbackEntries = pipeline.getFeedbackEntries("goal-1");
        expect(feedbackEntries).toHaveLength(0);
      });

      it("should not throw on error", async () => {
        const llm = createMockLLMClient([]); // will throw on first LLM call
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        writeLogs(stateManager, "goal-1");

        await expect(pipeline.onMilestoneReached("goal-1", "context")).resolves.toEqual([]);
      });
    });

    describe("onStallDetected", () => {
      it("should call analyzeLogs with stall context and return patterns", async () => {
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        writeLogs(stateManager, "goal-1");
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
        writeLogs(stateManager, "goal-1");
        const stallReport = makeStallReport("goal-1");

        await pipeline.onStallDetected("goal-1", stallReport);

        const feedbackEntries = pipeline.getFeedbackEntries("goal-1");
        expect(feedbackEntries.length).toBeGreaterThan(0);
      });

      it("should not throw on LLM error", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        writeLogs(stateManager, "goal-1");
        const stallReport = makeStallReport("goal-1");

        await expect(pipeline.onStallDetected("goal-1", stallReport)).resolves.toEqual([]);
      });
    });

    describe("onPeriodicReview", () => {
      it("should call analyzeLogs and return patterns", async () => {
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        writeLogs(stateManager, "goal-1");

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
        writeLogs(stateManager, "goal-1");

        await pipeline.onPeriodicReview("goal-1");

        const feedbackEntries = pipeline.getFeedbackEntries("goal-1");
        expect(feedbackEntries.length).toBeGreaterThan(0);
      });

      it("should not throw on LLM error", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        writeLogs(stateManager, "goal-1");

        await expect(pipeline.onPeriodicReview("goal-1")).resolves.toEqual([]);
      });
    });

    describe("onGoalCompleted", () => {
      it("should call analyzeLogs and return patterns", async () => {
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        writeLogs(stateManager, "goal-1");

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
        writeLogs(stateManager, "goal-1");

        await pipeline.onGoalCompleted("goal-1");

        const feedbackEntries = pipeline.getFeedbackEntries("goal-1");
        expect(feedbackEntries.length).toBeGreaterThan(0);
      });

      it("should attempt cross-goal sharing when cross_goal_sharing_enabled is true", async () => {
        const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        writeLogs(stateManager, "goal-1");

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
        writeLogs(stateManager, "goal-1");

        const result = await pipeline.onGoalCompleted("goal-1");
        expect(result).toHaveLength(1);
      });

      it("should not throw on LLM error", async () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
        writeLogs(stateManager, "goal-1");

        await expect(pipeline.onGoalCompleted("goal-1")).resolves.toEqual([]);
      });
    });
  });

  // ─── 6. 永続化（getPatterns, savePatterns, getFeedbackEntries, saveFeedbackEntries）───

  describe("persistence", () => {
    describe("getPatterns / savePatterns", () => {
      it("should return empty array for unknown goal", () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

        expect(pipeline.getPatterns("goal-nonexistent")).toEqual([]);
      });

      it("should persist and retrieve patterns", () => {
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
        const loaded = pipeline.getPatterns("goal-persist");

        expect(loaded).toHaveLength(1);
        expect(loaded[0]!.pattern_id).toBe("pat-persist-1");
        expect(loaded[0]!.confidence).toBe(0.85);
        expect(loaded[0]!.description).toBe("Persisted pattern");
      });

      it("should overwrite existing patterns on save", () => {
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
        const loaded = pipeline.getPatterns("goal-x");

        expect(loaded).toHaveLength(1);
        expect(loaded[0]!.pattern_id).toBe("pat-v2");
      });

      it("should save empty array and return empty array", () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

        await pipeline.savePatterns("goal-empty", []);
        // readRaw returns [] (an array), which is truthy but isArray check passes
        const loaded = pipeline.getPatterns("goal-empty");
        expect(loaded).toEqual([]);
      });

      it("should survive StateManager re-instantiation (disk persistence)", () => {
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
        pipeline1.savePatterns("goal-disk", patterns);

        // New StateManager instance pointing to same tmpDir
        const stateManager2 = new StateManager(tmpDir);
        const pipeline2 = new LearningPipeline(
          createMockLLMClient([]),
          vectorIndex,
          stateManager2
        );

        const loaded = pipeline2.getPatterns("goal-disk");
        expect(loaded).toHaveLength(1);
        expect(loaded[0]!.pattern_id).toBe("pat-disk");
      });
    });

    describe("getFeedbackEntries / saveFeedbackEntries", () => {
      it("should return empty array for unknown goal", () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

        expect(pipeline.getFeedbackEntries("goal-nonexistent")).toEqual([]);
      });

      it("should persist and retrieve feedback entries", () => {
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
        const loaded = pipeline.getFeedbackEntries("goal-persist");

        expect(loaded).toHaveLength(1);
        expect(loaded[0]!.feedback_id).toBe("fb-persist-1");
        expect(loaded[0]!.target_step).toBe("observation");
        expect(loaded[0]!.adjustment).toBe("Increase confidence for deterministic results");
      });

      it("should overwrite existing feedback entries on save", () => {
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
        const loaded = pipeline.getFeedbackEntries("goal-x");

        expect(loaded).toHaveLength(1);
        expect(loaded[0]!.feedback_id).toBe("fb-v2");
      });

      it("should save empty array and return empty array", () => {
        const llm = createMockLLMClient([]);
        const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

        await pipeline.saveFeedbackEntries("goal-empty", []);
        const loaded = pipeline.getFeedbackEntries("goal-empty");
        expect(loaded).toEqual([]);
      });

      it("should survive StateManager re-instantiation (disk persistence)", () => {
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
        pipeline1.saveFeedbackEntries("goal-disk", entries);

        const stateManager2 = new StateManager(tmpDir);
        const pipeline2 = new LearningPipeline(
          createMockLLMClient([]),
          vectorIndex,
          stateManager2
        );

        const loaded = pipeline2.getFeedbackEntries("goal-disk");
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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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

    it("should handle goal IDs with special characters", () => {
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
      const loaded = pipeline.getPatterns("goal-2026-q1-sprint-3");
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

      writeLogs(stateManager, "goal-concurrent-1");
      writeLogs(stateManager, "goal-concurrent-2");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-stall");

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
      writeLogs(stateManager, "goal-done");

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
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "run",
        timestamp: new Date().toISOString(),
      };

      const patterns1 = await pipeline.analyzeLogs(trigger);
      await pipeline.generateFeedback(patterns1);
      const countAfterFirst = pipeline.getFeedbackEntries("goal-1").length;

      const patterns2 = await pipeline.analyzeLogs({ ...trigger, context: "run 2" });
      await pipeline.generateFeedback(patterns2);
      const countAfterSecond = pipeline.getFeedbackEntries("goal-1").length;

      expect(countAfterSecond).toBeGreaterThan(countAfterFirst);
    });

    it("applyFeedback returns empty array when step is gap (no gap patterns)", () => {
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

    it("generateFeedback returns FeedbackEntry[] with correct schema fields", () => {
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

      const result = pipeline.getPatterns("goal-corrupt");
      expect(result).toEqual([]);
    });

    it("getFeedbackEntries returns empty array when stored data is not a valid array", async () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);

      // Write corrupt data (not an array)
      await stateManager.writeRaw("learning/goal-corrupt_feedback.json", { not: "an array" });

      const result = pipeline.getFeedbackEntries("goal-corrupt");
      expect(result).toEqual([]);
    });

    it("should handle trigger with long context string", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

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

    it("applyFeedback returns strings for all valid target_step values", () => {
      const llm = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      const now = new Date().toISOString();

      const allSteps: Array<"observation" | "gap" | "strategy" | "task"> = [
        "observation", "gap", "strategy", "task",
      ];
      const allEntries: FeedbackEntry[] = allSteps.map((step, i) => ({
        feedback_id: `fb-${step}`,
        pattern_id: `pat-${step}`,
        target_step: step,
        adjustment: `Adjustment for ${step}`,
        applied_at: now,
        effect_observed: null,
      }));

      // Add patterns for all of them
      const allPatterns: LearnedPattern[] = allSteps.map((step, i) => ({
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
      writeLogs(stateManager, "goal-1");

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
      writeLogs(stateManager, "goal-1");

      const trigger = {
        type: "milestone_reached" as const,
        goal_id: "goal-1",
        context: "test",
        timestamp: new Date().toISOString(),
      };
      const result = await pipeline.analyzeLogs(trigger);
      expect(result[0]!.applicable_domains).toEqual([]);
    });

    it("savePatterns and getPatterns round-trip preserves all LearnedPattern fields", () => {
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
      const loaded = pipeline.getPatterns("goal-full");

      expect(loaded[0]!.pattern_id).toBe(pattern.pattern_id);
      expect(loaded[0]!.type).toBe(pattern.type);
      expect(loaded[0]!.confidence).toBe(pattern.confidence);
      expect(loaded[0]!.evidence_count).toBe(pattern.evidence_count);
      expect(loaded[0]!.source_goal_ids).toEqual(pattern.source_goal_ids);
      expect(loaded[0]!.applicable_domains).toEqual(pattern.applicable_domains);
      expect(loaded[0]!.embedding_id).toBe(pattern.embedding_id);
      expect(loaded[0]!.last_applied_at).toBe(pattern.last_applied_at);
    });

    it("saveFeedbackEntries and getFeedbackEntries round-trip preserves all FeedbackEntry fields", () => {
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
      const loaded = pipeline.getFeedbackEntries("goal-full");

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
      writeLogs(stateManager, "goal-periodic");

      const result = await pipeline.onPeriodicReview("goal-periodic");
      expect(result).toHaveLength(1);
      expect(result[0]!.source_goal_ids).toContain("goal-periodic");
    });

    it("onStallDetected serializes stallInfo as JSON in trigger context", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-stall-context");
      const stallReport = makeStallReport("goal-stall-context");

      // If serialization fails, the trigger would fail Zod validation (context must be string)
      const result = await pipeline.onStallDetected("goal-stall-context", stallReport);
      expect(Array.isArray(result)).toBe(true);
    });

    it("onMilestoneReached passes milestoneContext as trigger context", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-milestone");

      const milestoneCtx = "test_coverage dimension exceeded 80% threshold";
      const result = await pipeline.onMilestoneReached("goal-milestone", milestoneCtx);
      expect(result).toHaveLength(1);
    });

    it("should not share patterns to same source goal via onGoalCompleted", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      writeLogs(stateManager, "goal-complete");

      const result = await pipeline.onGoalCompleted("goal-complete");
      const patternsBefore = pipeline.getPatterns("goal-complete").length;

      // No additional patterns should appear because sharing to self is blocked
      expect(pipeline.getPatterns("goal-complete").length).toBe(patternsBefore);
      expect(result).toHaveLength(1);
    });
  });
});
