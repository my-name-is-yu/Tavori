import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LearningPipeline } from "../src/knowledge/learning-pipeline.js";
import { StateManager } from "../src/state-manager.js";
import { VectorIndex } from "../src/knowledge/vector-index.js";
import { MockEmbeddingClient } from "../src/knowledge/embedding-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import type { LearningPipelineConfig } from "../src/types/learning.js";

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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

    it("should return patterns when confidence meets threshold", async () => {
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
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe("scope_sizing");
      expect(result[0]!.description).toContain("reduce task scope");
    });

    it("should set source_goal_ids from trigger goal_id", async () => {
      const llm = createMockLLMClient([TRIPLETS_RESPONSE, PATTERNS_RESPONSE]);
      const pipeline = new LearningPipeline(llm, vectorIndex, stateManager);
      await writeLogs(stateManager, "goal-abc");

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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
      await writeLogs(stateManager, "goal-1");

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

    it("should handle large number of log entries gracefully", async () => {
      const largeLogData = Array.from({ length: 500 }, (_, i) => ({
        task_id: `task-${i}`,
        result: "success",
        gap_delta: -0.01,
      }));
      await writeLogs(stateManager, "goal-large", largeLogData);

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
});
