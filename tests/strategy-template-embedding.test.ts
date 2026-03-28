import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StrategyTemplateRegistry } from "../src/strategy/strategy-template-registry.js";
import { VectorIndex } from "../src/knowledge/vector-index.js";
import { MockEmbeddingClient } from "../src/knowledge/embedding-client.js";
import type { IEmbeddingClient } from "../src/knowledge/embedding-client.js";
import { StrategySchema } from "../src/types/strategy.js";
import type { Strategy } from "../src/types/strategy.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";

// ─── Fixtures ───

const GENERALIZE_AUTOMATION = JSON.stringify({
  hypothesis_pattern:
    "Automate repetitive tasks to reduce manual overhead and increase throughput",
  domain_tags: ["automation", "efficiency"],
  applicable_dimensions: ["throughput", "manual_effort"],
});

const GENERALIZE_LEARNING = JSON.stringify({
  hypothesis_pattern:
    "Improve feedback loops to accelerate learning cycles",
  domain_tags: ["learning", "feedback"],
  applicable_dimensions: ["cycle_time", "accuracy"],
});

const GENERALIZE_TESTING = JSON.stringify({
  hypothesis_pattern:
    "Automate test suites to catch regressions early and reduce QA time",
  domain_tags: ["testing", "automation", "quality"],
  applicable_dimensions: ["qa_time", "defect_rate"],
});

function makeCompletedStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return StrategySchema.parse({
    id: "strat-test-001",
    goal_id: "goal-001",
    target_dimensions: ["throughput", "manual_effort"],
    primary_dimension: "throughput",
    hypothesis:
      "By automating the build pipeline we reduce manual effort and increase throughput",
    expected_effect: [
      { dimension: "throughput", direction: "increase", magnitude: "large" },
    ],
    resource_estimate: {
      sessions: 2,
      duration: { value: 4, unit: "hours" },
      llm_calls: null,
    },
    state: "completed",
    allocation: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T01:00:00.000Z",
    completed_at: "2026-01-01T05:00:00.000Z",
    gap_snapshot_at_start: 0.7,
    tasks_generated: [],
    effectiveness_score: 0.8,
    consecutive_stall_count: 0,
    source_template_id: null,
    cross_goal_context: null,
    ...overrides,
  });
}

// ─── Test Suite ───

describe("StrategyTemplateRegistry — embedding-based recommendation", () => {
  let tmpDir: string;
  let embeddingClient: IEmbeddingClient;
  let vectorIndex: VectorIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-emb-test-"));
    embeddingClient = new MockEmbeddingClient(64);
    vectorIndex = new VectorIndex(
      path.join(tmpDir, "vector-index.json"),
      embeddingClient
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── indexTemplates ───

  describe("indexTemplates", () => {
    it("adds one entry per registered template to VectorIndex", async () => {
      const llm = createMockLLMClient([GENERALIZE_AUTOMATION]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();
      await registry.registerTemplate(strategy, "goal-001");

      // Fresh VectorIndex to isolate indexTemplates from registerTemplate side effects
      const freshIndex = new VectorIndex(
        path.join(tmpDir, "fresh-index.json"),
        embeddingClient
      );
      expect(freshIndex.size).toBe(0);

      await registry.indexTemplates(embeddingClient, freshIndex);

      expect(freshIndex.size).toBe(1);
    });

    it("indexes multiple templates", async () => {
      const llm = createMockLLMClient([GENERALIZE_AUTOMATION, GENERALIZE_LEARNING]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      await registry.registerTemplate(makeCompletedStrategy({ id: "s-a" }), "goal-001");
      await registry.registerTemplate(
        makeCompletedStrategy({
          id: "s-b",
          hypothesis: "Feedback loops improve learning",
          target_dimensions: ["cycle_time"],
        }),
        "goal-002"
      );

      const freshIndex = new VectorIndex(
        path.join(tmpDir, "fresh-index.json"),
        embeddingClient
      );
      await registry.indexTemplates(embeddingClient, freshIndex);

      expect(freshIndex.size).toBe(2);
    });

    it("no-ops when no templates are registered", async () => {
      const llm = createMockLLMClient([]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const freshIndex = new VectorIndex(
        path.join(tmpDir, "fresh-index.json"),
        embeddingClient
      );

      await registry.indexTemplates(embeddingClient, freshIndex);

      expect(freshIndex.size).toBe(0);
    });

    it("stored entries have template_id in metadata", async () => {
      const llm = createMockLLMClient([GENERALIZE_AUTOMATION]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const template = await registry.registerTemplate(
        makeCompletedStrategy(),
        "goal-001"
      );

      const freshIndex = new VectorIndex(
        path.join(tmpDir, "fresh-index.json"),
        embeddingClient
      );
      await registry.indexTemplates(embeddingClient, freshIndex);

      // Search with a broad query to get the indexed entry
      const results = await freshIndex.search("automate", 1);
      expect(results).toHaveLength(1);
      expect(results[0].metadata?.["template_id"]).toBe(template.template_id);
    });
  });

  // ─── recommendByEmbedding ───

  describe("recommendByEmbedding", () => {
    it("returns similar templates for a relevant query", async () => {
      const llm = createMockLLMClient([GENERALIZE_AUTOMATION]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const template = await registry.registerTemplate(
        makeCompletedStrategy(),
        "goal-001"
      );

      // Index into a fresh index
      const freshIndex = new VectorIndex(
        path.join(tmpDir, "fresh-index.json"),
        embeddingClient
      );
      await registry.indexTemplates(embeddingClient, freshIndex);

      const recs = await registry.recommendByEmbedding(
        "automate build pipeline",
        embeddingClient,
        freshIndex
      );

      expect(recs).toHaveLength(1);
      expect(recs[0].templateId).toBe(template.template_id);
      expect(recs[0].similarity).toBeGreaterThan(0);
      expect(typeof recs[0].matchReason).toBe("string");
      expect(recs[0].matchReason.length).toBeGreaterThan(0);
    });

    it("returns empty array when no templates are registered", async () => {
      const llm = createMockLLMClient([]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const emptyIndex = new VectorIndex(
        path.join(tmpDir, "empty-index.json"),
        embeddingClient
      );

      const recs = await registry.recommendByEmbedding(
        "some goal description",
        embeddingClient,
        emptyIndex
      );

      expect(recs).toEqual([]);
    });

    it("returns empty array when VectorIndex has no indexed entries", async () => {
      const llm = createMockLLMClient([GENERALIZE_AUTOMATION]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      await registry.registerTemplate(makeCompletedStrategy(), "goal-001");

      // Do NOT call indexTemplates — freshIndex is empty
      const emptyIndex = new VectorIndex(
        path.join(tmpDir, "empty-index.json"),
        embeddingClient
      );

      const recs = await registry.recommendByEmbedding(
        "automate pipeline",
        embeddingClient,
        emptyIndex
      );

      expect(recs).toEqual([]);
    });

    it("respects topK limit", async () => {
      const llm = createMockLLMClient([
        GENERALIZE_AUTOMATION,
        GENERALIZE_LEARNING,
        GENERALIZE_TESTING,
      ]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      await registry.registerTemplate(makeCompletedStrategy({ id: "s-a" }), "goal-001");
      await registry.registerTemplate(
        makeCompletedStrategy({
          id: "s-b",
          hypothesis: "Feedback loops",
          target_dimensions: ["cycle_time"],
        }),
        "goal-002"
      );
      await registry.registerTemplate(
        makeCompletedStrategy({
          id: "s-c",
          hypothesis: "Test automation reduces defects",
          target_dimensions: ["qa_time"],
        }),
        "goal-003"
      );

      const freshIndex = new VectorIndex(
        path.join(tmpDir, "fresh-index.json"),
        embeddingClient
      );
      await registry.indexTemplates(embeddingClient, freshIndex);

      const recs = await registry.recommendByEmbedding(
        "automate",
        embeddingClient,
        freshIndex,
        2
      );

      expect(recs.length).toBeLessThanOrEqual(2);
    });

    it("returns results sorted by similarity descending", async () => {
      const llm = createMockLLMClient([GENERALIZE_AUTOMATION, GENERALIZE_LEARNING]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      await registry.registerTemplate(makeCompletedStrategy({ id: "s-a" }), "goal-001");
      await registry.registerTemplate(
        makeCompletedStrategy({
          id: "s-b",
          hypothesis: "Feedback loops improve learning",
          target_dimensions: ["cycle_time"],
        }),
        "goal-002"
      );

      const freshIndex = new VectorIndex(
        path.join(tmpDir, "fresh-index.json"),
        embeddingClient
      );
      await registry.indexTemplates(embeddingClient, freshIndex);

      const recs = await registry.recommendByEmbedding(
        "automate tasks",
        embeddingClient,
        freshIndex,
        5
      );

      for (let i = 0; i < recs.length - 1; i++) {
        expect(recs[i].similarity).toBeGreaterThanOrEqual(recs[i + 1].similarity);
      }
    });

    it("similarity is between 0 and 1", async () => {
      const llm = createMockLLMClient([GENERALIZE_AUTOMATION]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      await registry.registerTemplate(makeCompletedStrategy(), "goal-001");

      const freshIndex = new VectorIndex(
        path.join(tmpDir, "fresh-index.json"),
        embeddingClient
      );
      await registry.indexTemplates(embeddingClient, freshIndex);

      const recs = await registry.recommendByEmbedding(
        "throughput automation",
        embeddingClient,
        freshIndex
      );

      for (const rec of recs) {
        expect(rec.similarity).toBeGreaterThanOrEqual(0);
        expect(rec.similarity).toBeLessThanOrEqual(1);
      }
    });
  });

  // ─── recommendHybrid ───

  describe("recommendHybrid", () => {
    it("returns hybrid recommendations combining tag and embedding scores", async () => {
      const llm = createMockLLMClient([GENERALIZE_AUTOMATION]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const template = await registry.registerTemplate(
        makeCompletedStrategy(),
        "goal-001"
      );

      const freshIndex = new VectorIndex(
        path.join(tmpDir, "fresh-index.json"),
        embeddingClient
      );
      await registry.indexTemplates(embeddingClient, freshIndex);

      const recs = await registry.recommendHybrid(
        "automate pipeline tasks",
        ["automation"],
        embeddingClient,
        freshIndex
      );

      expect(recs).toHaveLength(1);
      expect(recs[0].templateId).toBe(template.template_id);
      expect(recs[0].tagScore).toBeGreaterThan(0);
      expect(recs[0].embeddingScore).toBeGreaterThanOrEqual(0);
      expect(recs[0].combinedScore).toBeGreaterThan(0);
    });

    it("combinedScore equals tagWeight*tagScore + embeddingWeight*embeddingScore", async () => {
      const llm = createMockLLMClient([GENERALIZE_AUTOMATION]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      await registry.registerTemplate(makeCompletedStrategy(), "goal-001");

      const freshIndex = new VectorIndex(
        path.join(tmpDir, "fresh-index.json"),
        embeddingClient
      );
      await registry.indexTemplates(embeddingClient, freshIndex);

      const recs = await registry.recommendHybrid(
        "automate tasks",
        ["automation"],
        embeddingClient,
        freshIndex,
        { tagWeight: 0.4, embeddingWeight: 0.6 }
      );

      expect(recs).toHaveLength(1);
      const rec = recs[0];
      const expected = 0.4 * rec.tagScore + 0.6 * rec.embeddingScore;
      expect(rec.combinedScore).toBeCloseTo(expected, 10);
    });

    it("respects custom weights", async () => {
      const llm = createMockLLMClient([GENERALIZE_AUTOMATION, GENERALIZE_LEARNING]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      await registry.registerTemplate(makeCompletedStrategy({ id: "s-a" }), "goal-001");
      await registry.registerTemplate(
        makeCompletedStrategy({
          id: "s-b",
          hypothesis: "Feedback loops accelerate learning",
          target_dimensions: ["cycle_time"],
        }),
        "goal-002"
      );

      const freshIndex = new VectorIndex(
        path.join(tmpDir, "fresh-index.json"),
        embeddingClient
      );
      await registry.indexTemplates(embeddingClient, freshIndex);

      // tagWeight=1, embeddingWeight=0 — only tag overlap matters
      const recs = await registry.recommendHybrid(
        "anything",
        ["automation"],
        embeddingClient,
        freshIndex,
        { tagWeight: 1.0, embeddingWeight: 0.0 }
      );

      // The template with "automation" tag should rank first
      expect(recs[0].tagScore).toBeGreaterThan(recs[recs.length - 1].tagScore);
    });

    it("tagScore is 0 when no goal tags are provided", async () => {
      const llm = createMockLLMClient([GENERALIZE_AUTOMATION]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      await registry.registerTemplate(makeCompletedStrategy(), "goal-001");

      const freshIndex = new VectorIndex(
        path.join(tmpDir, "fresh-index.json"),
        embeddingClient
      );
      await registry.indexTemplates(embeddingClient, freshIndex);

      const recs = await registry.recommendHybrid(
        "automate tasks",
        [],
        embeddingClient,
        freshIndex
      );

      expect(recs).toHaveLength(1);
      expect(recs[0].tagScore).toBe(0);
    });

    it("returns empty array when no templates are registered", async () => {
      const llm = createMockLLMClient([]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const emptyIndex = new VectorIndex(
        path.join(tmpDir, "empty-index.json"),
        embeddingClient
      );

      const recs = await registry.recommendHybrid(
        "automate",
        ["automation"],
        embeddingClient,
        emptyIndex
      );

      expect(recs).toEqual([]);
    });

    it("respects topK limit", async () => {
      const llm = createMockLLMClient([
        GENERALIZE_AUTOMATION,
        GENERALIZE_LEARNING,
        GENERALIZE_TESTING,
      ]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      await registry.registerTemplate(makeCompletedStrategy({ id: "s-a" }), "goal-001");
      await registry.registerTemplate(
        makeCompletedStrategy({
          id: "s-b",
          hypothesis: "Feedback loops",
          target_dimensions: ["cycle_time"],
        }),
        "goal-002"
      );
      await registry.registerTemplate(
        makeCompletedStrategy({
          id: "s-c",
          hypothesis: "Test automation",
          target_dimensions: ["qa_time"],
        }),
        "goal-003"
      );

      const freshIndex = new VectorIndex(
        path.join(tmpDir, "fresh-index.json"),
        embeddingClient
      );
      await registry.indexTemplates(embeddingClient, freshIndex);

      const recs = await registry.recommendHybrid(
        "automate tasks",
        ["automation"],
        embeddingClient,
        freshIndex,
        { topK: 2 }
      );

      expect(recs.length).toBeLessThanOrEqual(2);
    });

    it("results are sorted by combinedScore descending", async () => {
      const llm = createMockLLMClient([GENERALIZE_AUTOMATION, GENERALIZE_LEARNING]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      await registry.registerTemplate(makeCompletedStrategy({ id: "s-a" }), "goal-001");
      await registry.registerTemplate(
        makeCompletedStrategy({
          id: "s-b",
          hypothesis: "Feedback loops improve learning velocity",
          target_dimensions: ["cycle_time"],
        }),
        "goal-002"
      );

      const freshIndex = new VectorIndex(
        path.join(tmpDir, "fresh-index.json"),
        embeddingClient
      );
      await registry.indexTemplates(embeddingClient, freshIndex);

      const recs = await registry.recommendHybrid(
        "automate tasks for efficiency",
        ["automation"],
        embeddingClient,
        freshIndex
      );

      for (let i = 0; i < recs.length - 1; i++) {
        expect(recs[i].combinedScore).toBeGreaterThanOrEqual(
          recs[i + 1].combinedScore
        );
      }
    });

    it("works when VectorIndex has no indexed entries (embeddingScore=0)", async () => {
      const llm = createMockLLMClient([GENERALIZE_AUTOMATION]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      await registry.registerTemplate(makeCompletedStrategy(), "goal-001");

      // emptyIndex not indexed — all embeddingScores will be 0
      const emptyIndex = new VectorIndex(
        path.join(tmpDir, "empty-index.json"),
        embeddingClient
      );

      const recs = await registry.recommendHybrid(
        "automate tasks",
        ["automation"],
        embeddingClient,
        emptyIndex
      );

      expect(recs).toHaveLength(1);
      expect(recs[0].embeddingScore).toBe(0);
      // combinedScore should still reflect tagScore
      expect(recs[0].combinedScore).toBeCloseTo(0.4 * recs[0].tagScore, 10);
    });
  });
});
