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

const GENERALIZE_RESPONSE = JSON.stringify({
  hypothesis_pattern:
    "Automate repetitive tasks to reduce manual overhead and increase throughput",
  domain_tags: ["automation", "efficiency"],
  applicable_dimensions: ["throughput", "manual_effort"],
});

const GENERALIZE_RESPONSE_B = JSON.stringify({
  hypothesis_pattern:
    "Improve feedback loops to accelerate learning cycles",
  domain_tags: ["learning", "feedback"],
  applicable_dimensions: ["cycle_time", "accuracy"],
});

const ADAPT_RESPONSE = JSON.stringify({
  hypothesis:
    "Automate test execution to reduce manual QA effort for the new goal",
  target_dimensions: ["qa_time", "manual_effort"],
  expected_effect: [
    { dimension: "qa_time", direction: "decrease", magnitude: "large" },
    { dimension: "manual_effort", direction: "decrease", magnitude: "medium" },
  ],
});

/** Build a minimal valid completed strategy */
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

describe("StrategyTemplateRegistry", () => {
  let tmpDir: string;
  let embeddingClient: IEmbeddingClient;
  let vectorIndex: VectorIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-str-test-"));
    embeddingClient = new MockEmbeddingClient(64);
    vectorIndex = new VectorIndex(
      path.join(tmpDir, "vector-index.json"),
      embeddingClient
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── registerTemplate ───

  describe("registerTemplate", () => {
    it("registers template from completed strategy with high effectiveness", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();

      const template = await registry.registerTemplate(strategy, "goal-001");

      expect(template.source_goal_id).toBe("goal-001");
      expect(template.source_strategy_id).toBe("strat-test-001");
      expect(template.effectiveness_score).toBe(0.8);
    });

    it("rejects strategy with effectiveness_score < 0.5", async () => {
      const llm = createMockLLMClient([]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy({ effectiveness_score: 0.3 });

      await expect(
        registry.registerTemplate(strategy, "goal-001")
      ).rejects.toThrow(/effectiveness_score/);
    });

    it("rejects strategy with effectiveness_score = 0.49", async () => {
      const llm = createMockLLMClient([]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy({ effectiveness_score: 0.49 });

      await expect(
        registry.registerTemplate(strategy, "goal-001")
      ).rejects.toThrow();
    });

    it("rejects strategy with effectiveness_score = null", async () => {
      const llm = createMockLLMClient([]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy({ effectiveness_score: null });

      await expect(
        registry.registerTemplate(strategy, "goal-001")
      ).rejects.toThrow(/effectiveness_score/);
    });

    it("rejects strategy with state !== 'completed'", async () => {
      const llm = createMockLLMClient([]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy({ state: "active" });

      await expect(
        registry.registerTemplate(strategy, "goal-001")
      ).rejects.toThrow(/state/);
    });

    it("rejects candidate strategy", async () => {
      const llm = createMockLLMClient([]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy({ state: "candidate" });

      await expect(
        registry.registerTemplate(strategy, "goal-001")
      ).rejects.toThrow();
    });

    it("calls LLM for hypothesis generalization", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();

      await registry.registerTemplate(strategy, "goal-001");

      expect(llm.callCount).toBe(1);
    });

    it("generates embedding and adds entry to VectorIndex", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();

      expect(vectorIndex.size).toBe(0);
      await registry.registerTemplate(strategy, "goal-001");
      expect(vectorIndex.size).toBe(1);
    });

    it("persists template after registration", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();

      await registry.registerTemplate(strategy, "goal-001");

      const filePath = path.join(tmpDir, "strategy-templates.json");
      expect(fs.existsSync(filePath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown[];
      expect(data).toHaveLength(1);
    });

    it("returns a valid StrategyTemplate", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();

      const template = await registry.registerTemplate(strategy, "goal-001");

      expect(template.template_id).toBeDefined();
      expect(template.hypothesis_pattern).toBe(
        "Automate repetitive tasks to reduce manual overhead and increase throughput"
      );
      expect(template.domain_tags).toEqual(["automation", "efficiency"]);
      expect(template.applicable_dimensions).toEqual([
        "throughput",
        "manual_effort",
      ]);
      expect(template.embedding_id).toBeTruthy();
      expect(template.created_at).toBeDefined();
    });

    it("generated template_id has 'tmpl-' prefix", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();

      const template = await registry.registerTemplate(strategy, "goal-001");

      expect(template.template_id.startsWith("tmpl-")).toBe(true);
    });

    it("domain_tags populated from LLM response", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();

      const template = await registry.registerTemplate(strategy, "goal-001");

      expect(template.domain_tags).toContain("automation");
      expect(template.domain_tags).toContain("efficiency");
    });

    it("applicable_dimensions populated from LLM response", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();

      const template = await registry.registerTemplate(strategy, "goal-001");

      expect(template.applicable_dimensions).toContain("throughput");
      expect(template.applicable_dimensions).toContain("manual_effort");
    });

    it("accepts strategy with effectiveness_score exactly 0.5", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy({ effectiveness_score: 0.5 });

      const template = await registry.registerTemplate(strategy, "goal-001");

      expect(template.effectiveness_score).toBe(0.5);
    });
  });

  // ─── searchTemplates ───

  describe("searchTemplates", () => {
    it("finds templates by semantic search", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();
      await registry.registerTemplate(strategy, "goal-001");

      const results = await registry.searchTemplates(
        "automate pipeline for throughput"
      );

      expect(results).toHaveLength(1);
      expect(results[0].source_strategy_id).toBe("strat-test-001");
    });

    it("returns empty array when no templates are registered", async () => {
      const llm = createMockLLMClient([]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );

      const results = await registry.searchTemplates("some query");

      expect(results).toEqual([]);
    });

    it("filters by domain_tags overlap", async () => {
      const llm = createMockLLMClient([
        GENERALIZE_RESPONSE,
        GENERALIZE_RESPONSE_B,
      ]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const stratA = makeCompletedStrategy({ id: "strat-a" });
      const stratB = makeCompletedStrategy({
        id: "strat-b",
        hypothesis: "By improving feedback loops we speed up learning cycles",
        target_dimensions: ["cycle_time", "accuracy"],
      });

      await registry.registerTemplate(stratA, "goal-001");
      await registry.registerTemplate(stratB, "goal-002");

      // Filter by "automation" tag — should only return stratA's template
      const results = await registry.searchTemplates("some query", 5, [
        "automation",
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].domain_tags).toContain("automation");
    });

    it("respects limit parameter", async () => {
      const llm = createMockLLMClient([
        GENERALIZE_RESPONSE,
        GENERALIZE_RESPONSE_B,
      ]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const stratA = makeCompletedStrategy({ id: "strat-a" });
      const stratB = makeCompletedStrategy({
        id: "strat-b",
        hypothesis: "Feedback loop improvement for learning velocity",
        target_dimensions: ["cycle_time"],
      });

      await registry.registerTemplate(stratA, "goal-001");
      await registry.registerTemplate(stratB, "goal-002");

      const results = await registry.searchTemplates("query", 1);

      expect(results).toHaveLength(1);
    });

    it("returns empty array when no domain tag overlap", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();
      await registry.registerTemplate(strategy, "goal-001");

      // Template has ["automation","efficiency"], filter for ["learning"]
      const results = await registry.searchTemplates("query", 5, ["learning"]);

      expect(results).toHaveLength(0);
    });

    it("returns all templates up to default limit when no domain filter", async () => {
      const llm = createMockLLMClient([
        GENERALIZE_RESPONSE,
        GENERALIZE_RESPONSE_B,
      ]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const stratA = makeCompletedStrategy({ id: "strat-a" });
      const stratB = makeCompletedStrategy({
        id: "strat-b",
        hypothesis: "Another strategy for feedback improvement",
        target_dimensions: ["cycle_time"],
      });

      await registry.registerTemplate(stratA, "goal-001");
      await registry.registerTemplate(stratB, "goal-002");

      const results = await registry.searchTemplates("query");

      expect(results).toHaveLength(2);
    });
  });

  // ─── applyTemplate ───

  describe("applyTemplate", () => {
    it("adapts template to new goal context", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE, ADAPT_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();
      const template = await registry.registerTemplate(strategy, "goal-001");

      const newStrategy = await registry.applyTemplate(
        template.template_id,
        "goal-002",
        "Reduce QA manual effort for the payments module"
      );

      expect(newStrategy.hypothesis).toBe(
        "Automate test execution to reduce manual QA effort for the new goal"
      );
      expect(newStrategy.goal_id).toBe("goal-002");
    });

    it("throws if template not found", async () => {
      const llm = createMockLLMClient([]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );

      await expect(
        registry.applyTemplate("nonexistent-id", "goal-002", "some context")
      ).rejects.toThrow(/Template not found/);
    });

    it("calls LLM for context adaptation", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE, ADAPT_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();
      const template = await registry.registerTemplate(strategy, "goal-001");

      await registry.applyTemplate(
        template.template_id,
        "goal-002",
        "context"
      );

      // 1 call for registerTemplate + 1 call for applyTemplate
      expect(llm.callCount).toBe(2);
    });

    it("returns Strategy with source_template_id set", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE, ADAPT_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();
      const template = await registry.registerTemplate(strategy, "goal-001");

      const newStrategy = await registry.applyTemplate(
        template.template_id,
        "goal-002",
        "context"
      );

      expect(newStrategy.source_template_id).toBe(template.template_id);
    });

    it("returned strategy has state 'candidate'", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE, ADAPT_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();
      const template = await registry.registerTemplate(strategy, "goal-001");

      const newStrategy = await registry.applyTemplate(
        template.template_id,
        "goal-002",
        "context"
      );

      expect(newStrategy.state).toBe("candidate");
    });

    it("returned strategy has allocation 0", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE, ADAPT_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();
      const template = await registry.registerTemplate(strategy, "goal-001");

      const newStrategy = await registry.applyTemplate(
        template.template_id,
        "goal-002",
        "context"
      );

      expect(newStrategy.allocation).toBe(0);
    });

    it("returned strategy id has 'strat-' prefix", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE, ADAPT_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();
      const template = await registry.registerTemplate(strategy, "goal-001");

      const newStrategy = await registry.applyTemplate(
        template.template_id,
        "goal-002",
        "context"
      );

      expect(newStrategy.id.startsWith("strat-")).toBe(true);
    });

    it("expected_effect populated from LLM response", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE, ADAPT_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();
      const template = await registry.registerTemplate(strategy, "goal-001");

      const newStrategy = await registry.applyTemplate(
        template.template_id,
        "goal-002",
        "context"
      );

      expect(newStrategy.expected_effect).toHaveLength(2);
      expect(newStrategy.expected_effect[0].dimension).toBe("qa_time");
      expect(newStrategy.expected_effect[0].direction).toBe("decrease");
    });
  });

  // ─── persistence ───

  describe("persistence", () => {
    it("save writes templates to JSON file", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();
      await registry.registerTemplate(strategy, "goal-001");

      // save is called internally by registerTemplate, but let's call explicitly
      await registry.save();

      const filePath = path.join(tmpDir, "strategy-templates.json");
      expect(fs.existsSync(filePath)).toBe(true);

      const raw = JSON.parse(
        fs.readFileSync(filePath, "utf-8")
      ) as unknown[];
      expect(raw).toHaveLength(1);
    });

    it("load restores templates from JSON file", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();
      const template = await registry.registerTemplate(strategy, "goal-001");

      // Create a fresh registry and load from file
      const llm2 = createMockLLMClient([]);
      const registry2 = new StrategyTemplateRegistry(
        llm2,
        vectorIndex,
        embeddingClient,
        tmpDir
      );

      expect(registry2.size).toBe(0);
      await registry2.load();
      expect(registry2.size).toBe(1);

      const loaded = registry2.getTemplate(template.template_id);
      expect(loaded).toBeDefined();
      expect(loaded?.hypothesis_pattern).toBe(template.hypothesis_pattern);
    });

    it("load handles missing file gracefully", async () => {
      const llm = createMockLLMClient([]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );

      // File doesn't exist — should not throw
      await expect(registry.load()).resolves.not.toThrow();
      expect(registry.size).toBe(0);
    });

    it("round-trip save/load preserves data", async () => {
      const llm = createMockLLMClient([GENERALIZE_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      const strategy = makeCompletedStrategy();
      const template = await registry.registerTemplate(strategy, "goal-001");

      // Load into a fresh registry
      const llm2 = createMockLLMClient([]);
      const registry2 = new StrategyTemplateRegistry(
        llm2,
        vectorIndex,
        embeddingClient,
        tmpDir
      );
      await registry2.load();

      const restored = registry2.getTemplate(template.template_id);
      expect(restored).toBeDefined();
      expect(restored?.template_id).toBe(template.template_id);
      expect(restored?.source_goal_id).toBe(template.source_goal_id);
      expect(restored?.source_strategy_id).toBe(template.source_strategy_id);
      expect(restored?.hypothesis_pattern).toBe(template.hypothesis_pattern);
      expect(restored?.domain_tags).toEqual(template.domain_tags);
      expect(restored?.effectiveness_score).toBe(template.effectiveness_score);
      expect(restored?.applicable_dimensions).toEqual(
        template.applicable_dimensions
      );
      expect(restored?.embedding_id).toBe(template.embedding_id);
      expect(restored?.created_at).toBe(template.created_at);
    });

    it("save creates parent directory if it doesn't exist", async () => {
      const nestedDir = path.join(tmpDir, "nested", "dir");
      const llm = createMockLLMClient([GENERALIZE_RESPONSE]);
      const registry = new StrategyTemplateRegistry(
        llm,
        vectorIndex,
        embeddingClient,
        nestedDir
      );
      const strategy = makeCompletedStrategy();

      await registry.registerTemplate(strategy, "goal-001");

      const filePath = path.join(nestedDir, "strategy-templates.json");
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });
});
