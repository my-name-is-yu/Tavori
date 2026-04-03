import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state/state-manager.js";
import { KnowledgeManager } from "../src/knowledge/knowledge-manager.js";
import { VectorIndex } from "../src/knowledge/vector-index.js";
import { MockEmbeddingClient } from "../src/knowledge/embedding-client.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../src/llm/llm-client.js";
import type { KnowledgeEntry } from "../src/types/knowledge.js";
import type { ZodSchema } from "zod";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { randomUUID } from "node:crypto";

// ─── Helpers ───

function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `pulseed-knowledge-test-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeKnowledgeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    entry_id: overrides.entry_id ?? randomUUID(),
    question: overrides.question ?? "What is the normal breathing rate for a dog?",
    answer: overrides.answer ?? "15-30 breaths per minute for an adult dog at rest.",
    sources: overrides.sources ?? [
      { type: "web", reference: "https://example.com/dogs", reliability: "medium" },
    ],
    confidence: overrides.confidence ?? 0.7,
    acquired_at: overrides.acquired_at ?? new Date().toISOString(),
    acquisition_task_id: overrides.acquisition_task_id ?? randomUUID(),
    superseded_by: overrides.superseded_by ?? null,
    tags: overrides.tags ?? ["breathing_rate", "normal_range", "dog"],
    ...overrides,
  };
}

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════
// detectKnowledgeGap
// ═══════════════════════════════════════════════════════

describe("detectKnowledgeGap", () => {
  it("returns interpretation_difficulty signal when confidence < 0.3", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const signal = await manager.detectKnowledgeGap({
      observations: [{ value: 28 }],
      strategies: [{ name: "strategy_a" }],
      confidence: 0.25,
    });
    expect(signal).not.toBeNull();
    expect(signal!.signal_type).toBe("interpretation_difficulty");
    expect(signal!.source_step).toBe("gap_recognition");
  });

  it("returns interpretation_difficulty when confidence is exactly 0.29", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const signal = await manager.detectKnowledgeGap({
      observations: [],
      strategies: [{ name: "s" }],
      confidence: 0.29,
    });
    expect(signal).not.toBeNull();
    expect(signal!.signal_type).toBe("interpretation_difficulty");
  });

  it("does NOT trigger fast-path for confidence exactly 0.3", async () => {
    // confidence === 0.3 is not < 0.3, but strategies is empty → strategy_deadlock fast-path
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const signal = await manager.detectKnowledgeGap({
      observations: [],
      strategies: [],
      confidence: 0.3,
    });
    expect(signal).not.toBeNull();
    expect(signal!.signal_type).toBe("strategy_deadlock");
  });

  it("returns strategy_deadlock signal when strategies array is empty", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const signal = await manager.detectKnowledgeGap({
      observations: [{ value: 50 }],
      strategies: [],
      confidence: 0.8,
    });
    expect(signal).not.toBeNull();
    expect(signal!.signal_type).toBe("strategy_deadlock");
    expect(signal!.source_step).toBe("strategy_selection");
  });

  it("returns strategy_deadlock signal with useful missing_knowledge text", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const signal = await manager.detectKnowledgeGap({
      observations: [],
      strategies: [],
      confidence: 0.9,
    });
    expect(signal!.missing_knowledge).toBeTruthy();
    expect(signal!.missing_knowledge.length).toBeGreaterThan(10);
  });

  it("returns null when LLM reports no gap (normal case)", async () => {
    const llmResponse = JSON.stringify({ has_gap: false });
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([llmResponse])
    );
    const signal = await manager.detectKnowledgeGap({
      observations: [{ value: 50 }],
      strategies: [{ name: "s1" }, { name: "s2" }],
      confidence: 0.75,
    });
    expect(signal).toBeNull();
  });

  it("returns signal from LLM when gap is detected by LLM", async () => {
    const llmResponse = JSON.stringify({
      has_gap: true,
      signal_type: "new_domain",
      missing_knowledge: "Domain is entirely new — no baseline exists",
      source_step: "gap_recognition",
      related_dimension: "churn_rate",
    });
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([llmResponse])
    );
    const signal = await manager.detectKnowledgeGap({
      observations: [{ value: 0.5 }],
      strategies: [{ name: "s1" }],
      confidence: 0.6,
    });
    expect(signal).not.toBeNull();
    expect(signal!.signal_type).toBe("new_domain");
    expect(signal!.related_dimension).toBe("churn_rate");
  });

  it("returns null when LLM response is unparseable", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient(["not valid json at all"])
    );
    const signal = await manager.detectKnowledgeGap({
      observations: [{ v: 1 }],
      strategies: [{ n: "a" }],
      confidence: 0.6,
    });
    expect(signal).toBeNull();
  });

  it("includes related_dimension in fast-path signals (null by default)", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const signal = await manager.detectKnowledgeGap({
      observations: [],
      strategies: [],
      confidence: 0.5,
    });
    expect(signal!.related_dimension).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════
// generateAcquisitionTask
// ═══════════════════════════════════════════════════════

describe("generateAcquisitionTask", () => {
  function makeSignal() {
    return {
      signal_type: "strategy_deadlock" as const,
      missing_knowledge: "No strategies available for churn reduction",
      source_step: "strategy_selection",
      related_dimension: "churn_rate",
    };
  }

  function makeLLMFieldsResponse(questions: string[] = ["Q1", "Q2", "Q3"]) {
    return JSON.stringify({
      knowledge_target: "Churn reduction strategies for SaaS",
      knowledge_questions: questions,
      in_scope: ["Industry benchmarks", "Proven tactics"],
      out_of_scope: ["Product roadmap changes"],
    });
  }

  it("generates a task with task_category: knowledge_acquisition", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([makeLLMFieldsResponse()])
    );
    const task = await manager.generateAcquisitionTask(makeSignal(), "goal-1");
    expect(task.task_category).toBe("knowledge_acquisition");
  });

  it("generates a task with 3 research questions when LLM returns 3", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([makeLLMFieldsResponse(["Q1", "Q2", "Q3"])])
    );
    const task = await manager.generateAcquisitionTask(makeSignal(), "goal-1");
    expect(task.approach).toContain("Q1");
    expect(task.approach).toContain("Q2");
    expect(task.approach).toContain("Q3");
  });

  it("generates a task with 5 research questions when LLM returns 5", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([makeLLMFieldsResponse(["Q1", "Q2", "Q3", "Q4", "Q5"])])
    );
    const task = await manager.generateAcquisitionTask(makeSignal(), "goal-1");
    expect(task.approach).toContain("Q5");
  });

  it("clamps to 5 questions when LLM returns 6", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([
        makeLLMFieldsResponse(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]),
      ])
    );
    const task = await manager.generateAcquisitionTask(makeSignal(), "goal-1");
    // Q6 should not appear
    expect(task.approach).not.toContain("Q6");
    expect(task.approach).toContain("Q5");
  });

  it("sets reversibility to reversible", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([makeLLMFieldsResponse()])
    );
    const task = await manager.generateAcquisitionTask(makeSignal(), "goal-1");
    expect(task.reversibility).toBe("reversible");
  });

  it("sets estimated_duration to 4 hours (stall-detection default for research)", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([makeLLMFieldsResponse()])
    );
    const task = await manager.generateAcquisitionTask(makeSignal(), "goal-1");
    expect(task.estimated_duration).toEqual({ value: 4, unit: "hours" });
  });

  it("sets goal_id correctly", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([makeLLMFieldsResponse()])
    );
    const task = await manager.generateAcquisitionTask(makeSignal(), "goal-42");
    expect(task.goal_id).toBe("goal-42");
  });

  it("sets primary_dimension from signal related_dimension", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([makeLLMFieldsResponse()])
    );
    const task = await manager.generateAcquisitionTask(makeSignal(), "goal-1");
    expect(task.primary_dimension).toBe("churn_rate");
  });

  it("uses 'knowledge' as primary_dimension when related_dimension is null", async () => {
    const signal = {
      signal_type: "new_domain" as const,
      missing_knowledge: "New domain",
      source_step: "gap_recognition",
      related_dimension: null,
    };
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([makeLLMFieldsResponse()])
    );
    const task = await manager.generateAcquisitionTask(signal, "goal-1");
    expect(task.primary_dimension).toBe("knowledge");
  });

  it("includes scope limits in constraints", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([makeLLMFieldsResponse()])
    );
    const task = await manager.generateAcquisitionTask(makeSignal(), "goal-1");
    expect(task.constraints.some((c) => c.includes("scope") || c.includes("Scope"))).toBe(true);
    expect(task.constraints).toContain("No system modifications allowed");
  });

  it("has out_of_scope containing system modifications", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([makeLLMFieldsResponse()])
    );
    const task = await manager.generateAcquisitionTask(makeSignal(), "goal-1");
    expect(task.scope_boundary.out_of_scope).toContain("System modifications");
  });

  it("persists the generated task to state", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([makeLLMFieldsResponse()])
    );
    const task = await manager.generateAcquisitionTask(makeSignal(), "goal-1");
    const persisted = await stateManager.readRaw(`tasks/goal-1/${task.id}.json`);
    expect(persisted).not.toBeNull();
  });

  it("has a non-empty work_description", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([makeLLMFieldsResponse()])
    );
    const task = await manager.generateAcquisitionTask(makeSignal(), "goal-1");
    expect(task.work_description.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════
// saveKnowledge / loadKnowledge (CRUD)
// ═══════════════════════════════════════════════════════

describe("saveKnowledge / loadKnowledge", () => {
  it("saves an entry and loads it back", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry();
    await manager.saveKnowledge("goal-1", entry);
    const loaded = await manager.loadKnowledge("goal-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.entry_id).toBe(entry.entry_id);
  });

  it("saves multiple entries and loads all", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const e1 = makeKnowledgeEntry({ entry_id: "e1", tags: ["a"] });
    const e2 = makeKnowledgeEntry({ entry_id: "e2", tags: ["b"] });
    await manager.saveKnowledge("goal-1", e1);
    await manager.saveKnowledge("goal-1", e2);
    const loaded = await manager.loadKnowledge("goal-1");
    expect(loaded).toHaveLength(2);
  });

  it("returns empty array for goal with no knowledge", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const loaded = await manager.loadKnowledge("nonexistent-goal");
    expect(loaded).toEqual([]);
  });

  it("filters by tags — single tag match", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const e1 = makeKnowledgeEntry({ entry_id: "e1", tags: ["breathing_rate", "dog"] });
    const e2 = makeKnowledgeEntry({ entry_id: "e2", tags: ["churn_rate", "saas"] });
    await manager.saveKnowledge("goal-1", e1);
    await manager.saveKnowledge("goal-1", e2);
    const loaded = await manager.loadKnowledge("goal-1", ["dog"]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.entry_id).toBe("e1");
  });

  it("filters by tags — multiple tags (AND logic)", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const e1 = makeKnowledgeEntry({ entry_id: "e1", tags: ["breathing_rate", "dog", "french_bulldog"] });
    const e2 = makeKnowledgeEntry({ entry_id: "e2", tags: ["breathing_rate", "dog"] });
    await manager.saveKnowledge("goal-1", e1);
    await manager.saveKnowledge("goal-1", e2);
    const loaded = await manager.loadKnowledge("goal-1", ["breathing_rate", "french_bulldog"]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.entry_id).toBe("e1");
  });

  it("returns empty array when no entries match tags", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const e1 = makeKnowledgeEntry({ tags: ["dog"] });
    await manager.saveKnowledge("goal-1", e1);
    const loaded = await manager.loadKnowledge("goal-1", ["cat"]);
    expect(loaded).toEqual([]);
  });

  it("returns all entries when tags array is empty", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const e1 = makeKnowledgeEntry({ entry_id: "e1", tags: ["a"] });
    const e2 = makeKnowledgeEntry({ entry_id: "e2", tags: ["b"] });
    await manager.saveKnowledge("goal-1", e1);
    await manager.saveKnowledge("goal-1", e2);
    const loaded = await manager.loadKnowledge("goal-1", []);
    expect(loaded).toHaveLength(2);
  });

  it("persists entry fields accurately (answer, confidence, sources)", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry({
      answer: "Specific answer here",
      confidence: 0.85,
      sources: [{ type: "expert", reference: "Dr. Smith", reliability: "high" }],
    });
    await manager.saveKnowledge("goal-1", entry);
    const loaded = await manager.loadKnowledge("goal-1");
    expect(loaded[0]!.answer).toBe("Specific answer here");
    expect(loaded[0]!.confidence).toBe(0.85);
    expect(loaded[0]!.sources[0]!.type).toBe("expert");
  });

  it("rolls back vectorIndex entry when writeRaw fails", async () => {
    const vectorIndex = new VectorIndex(
      path.join(tempDir, "vector-index.json"),
      new MockEmbeddingClient(8)
    );
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([]),
      vectorIndex
    );

    // Make writeRaw throw
    vi.spyOn(stateManager, "writeRaw").mockRejectedValueOnce(
      new Error("disk full")
    );

    const entry = makeKnowledgeEntry({ entry_id: "rollback-entry" });
    await expect(manager.saveKnowledge("goal-1", entry)).rejects.toThrow(
      "disk full"
    );

    // The vector index entry must have been removed as compensation
    expect(vectorIndex.getEntry("rollback-entry")).toBeUndefined();
  });

  it("entries from different goals do not interfere", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const e1 = makeKnowledgeEntry({ entry_id: "e1", tags: ["x"] });
    const e2 = makeKnowledgeEntry({ entry_id: "e2", tags: ["y"] });
    await manager.saveKnowledge("goal-A", e1);
    await manager.saveKnowledge("goal-B", e2);
    expect(await manager.loadKnowledge("goal-A")).toHaveLength(1);
    expect(await manager.loadKnowledge("goal-B")).toHaveLength(1);
    expect((await manager.loadKnowledge("goal-A"))[0]!.entry_id).toBe("e1");
  });
});

// ═══════════════════════════════════════════════════════
// checkContradiction
// ═══════════════════════════════════════════════════════

describe("checkContradiction", () => {
  it("returns no contradiction when no existing entries share tags", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry({ tags: ["unique_tag_xyz"] });
    const result = await manager.checkContradiction("goal-1", entry);
    expect(result.has_contradiction).toBe(false);
  });

  it("returns no contradiction when knowledge store is empty", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry();
    const result = await manager.checkContradiction("goal-1", entry);
    expect(result.has_contradiction).toBe(false);
    expect(result.conflicting_entry_id).toBeNull();
  });

  it("detects contradiction via LLM when existing entry shares tags", async () => {
    const existingId = "existing-entry-id";
    const existing = makeKnowledgeEntry({
      entry_id: existingId,
      answer: "15-30 breaths per minute",
      tags: ["breathing_rate", "dog"],
    });
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([
        JSON.stringify({
          has_contradiction: true,
          conflicting_entry_id: existingId,
          resolution: "New entry contradicts existing entry — higher confidence source preferred",
        }),
      ])
    );
    await manager.saveKnowledge("goal-1", existing);

    const newEntry = makeKnowledgeEntry({
      entry_id: "new-entry-id",
      answer: "60-80 breaths per minute — completely different claim",
      tags: ["breathing_rate", "dog"],
    });
    const result = await manager.checkContradiction("goal-1", newEntry);
    expect(result.has_contradiction).toBe(true);
    expect(result.conflicting_entry_id).toBe(existingId);
    expect(result.resolution).toBeTruthy();
  });

  it("returns no contradiction when LLM reports none", async () => {
    const existing = makeKnowledgeEntry({
      entry_id: "e1",
      answer: "15-30 breaths per minute",
      tags: ["breathing_rate", "dog"],
    });
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([
        JSON.stringify({
          has_contradiction: false,
          conflicting_entry_id: null,
          resolution: null,
        }),
      ])
    );
    await manager.saveKnowledge("goal-1", existing);

    const newEntry = makeKnowledgeEntry({
      entry_id: "e2",
      answer: "15-30 breaths per minute — same claim, different source",
      tags: ["breathing_rate", "dog"],
    });
    const result = await manager.checkContradiction("goal-1", newEntry);
    expect(result.has_contradiction).toBe(false);
  });

  it("does not compare an entry against itself", async () => {
    const entryId = "self-entry";
    const entry = makeKnowledgeEntry({
      entry_id: entryId,
      tags: ["breathing_rate"],
    });
    // No LLM call should be needed (no candidates)
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    await manager.saveKnowledge("goal-1", entry);
    const result = await manager.checkContradiction("goal-1", entry);
    expect(result.has_contradiction).toBe(false);
  });

  it("does not compare against superseded entries", async () => {
    const superseded = makeKnowledgeEntry({
      entry_id: "old-entry",
      tags: ["breathing_rate", "dog"],
      superseded_by: "newer-entry-id",
    });
    // No LLM needed since superseded entry is excluded
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    await manager.saveKnowledge("goal-1", superseded);

    const newEntry = makeKnowledgeEntry({
      entry_id: "new-entry",
      tags: ["breathing_rate", "dog"],
    });
    const result = await manager.checkContradiction("goal-1", newEntry);
    expect(result.has_contradiction).toBe(false);
  });

  it("returns no contradiction when LLM response is invalid JSON", async () => {
    const existing = makeKnowledgeEntry({
      entry_id: "e1",
      tags: ["tag_a"],
    });
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient(["not valid json"])
    );
    await manager.saveKnowledge("goal-1", existing);

    const newEntry = makeKnowledgeEntry({
      entry_id: "e2",
      tags: ["tag_a"],
    });
    const result = await manager.checkContradiction("goal-1", newEntry);
    expect(result.has_contradiction).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// getRelevantKnowledge
// ═══════════════════════════════════════════════════════

describe("getRelevantKnowledge", () => {
  it("returns entries whose tags include the dimension name", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const e1 = makeKnowledgeEntry({ entry_id: "e1", tags: ["churn_rate", "saas"] });
    const e2 = makeKnowledgeEntry({ entry_id: "e2", tags: ["breathing_rate", "dog"] });
    await manager.saveKnowledge("goal-1", e1);
    await manager.saveKnowledge("goal-1", e2);

    const result = await manager.getRelevantKnowledge("goal-1", "churn_rate");
    expect(result).toHaveLength(1);
    expect(result[0]!.entry_id).toBe("e1");
  });

  it("returns empty array when no entries match the dimension name", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const e1 = makeKnowledgeEntry({ tags: ["dog"] });
    await manager.saveKnowledge("goal-1", e1);

    const result = await manager.getRelevantKnowledge("goal-1", "churn_rate");
    expect(result).toEqual([]);
  });

  it("returns multiple entries when multiple match", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const e1 = makeKnowledgeEntry({ entry_id: "e1", tags: ["churn_rate", "monthly"] });
    const e2 = makeKnowledgeEntry({ entry_id: "e2", tags: ["churn_rate", "annual"] });
    const e3 = makeKnowledgeEntry({ entry_id: "e3", tags: ["nps", "saas"] });
    await manager.saveKnowledge("goal-1", e1);
    await manager.saveKnowledge("goal-1", e2);
    await manager.saveKnowledge("goal-1", e3);

    const result = await manager.getRelevantKnowledge("goal-1", "churn_rate");
    expect(result).toHaveLength(2);
    const ids = result.map((e) => e.entry_id);
    expect(ids).toContain("e1");
    expect(ids).toContain("e2");
  });

  it("returns empty array for goal with no knowledge at all", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const result = await manager.getRelevantKnowledge("nonexistent-goal", "dim_x");
    expect(result).toEqual([]);
  });

  it("uses exact tag match — dimension name must be a tag, not a substring", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    // Tag "churn" should NOT match dimension "churn_rate"
    const e1 = makeKnowledgeEntry({ entry_id: "e1", tags: ["churn"] });
    await manager.saveKnowledge("goal-1", e1);

    const result = await manager.getRelevantKnowledge("goal-1", "churn_rate");
    expect(result).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════
// Semantic Search (Phase 2)
// ═══════════════════════════════════════════════════════

describe("Semantic Search (Phase 2)", () => {
  function makeVectorIndex(dir: string): VectorIndex {
    const embeddingClient = new MockEmbeddingClient(8); // small dims for tests
    return new VectorIndex(path.join(dir, "vector-index.json"), embeddingClient);
  }

  it("searchKnowledge returns results via vector search", async () => {
    const vectorIndex = makeVectorIndex(tempDir);
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([]),
      vectorIndex
    );

    const e1 = makeKnowledgeEntry({
      entry_id: "e1",
      question: "What is the churn rate benchmark?",
      answer: "Industry average SaaS churn is around 5% annually.",
      tags: ["churn_rate", "saas"],
    });
    await manager.saveKnowledge("goal-1", e1);

    const results = await manager.searchKnowledge("churn rate SaaS benchmark");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entry_id).toBe("e1");
  });

  it("searchKnowledge falls back to empty array when no vectorIndex", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const e1 = makeKnowledgeEntry({ entry_id: "e1", tags: ["churn_rate"] });
    await manager.saveKnowledge("goal-1", e1);

    const results = await manager.searchKnowledge("churn rate");
    expect(results).toEqual([]);
  });

  it("addKnowledge (saveKnowledge) also indexes in VectorIndex when available", async () => {
    const vectorIndex = makeVectorIndex(tempDir);
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([]),
      vectorIndex
    );

    const e1 = makeKnowledgeEntry({ entry_id: "e1", tags: ["nps"] });
    await manager.saveKnowledge("goal-1", e1);

    // The vector index should now have the entry
    expect(vectorIndex.size).toBe(1);
    const entry = vectorIndex.getEntry("e1");
    expect(entry).toBeDefined();
    expect(entry!.metadata["goal_id"]).toBe("goal-1");
  });

  it("searchAcrossGoals returns entries from multiple goals", async () => {
    const vectorIndex = makeVectorIndex(tempDir);
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([]),
      vectorIndex
    );

    const e1 = makeKnowledgeEntry({
      entry_id: "e1",
      question: "Breathing rate for a dog?",
      answer: "15-30 breaths per minute.",
      tags: ["breathing_rate"],
    });
    const e2 = makeKnowledgeEntry({
      entry_id: "e2",
      question: "Breathing rate for a cat?",
      answer: "20-30 breaths per minute.",
      tags: ["breathing_rate"],
    });

    await manager.saveKnowledge("goal-dog", e1);
    await manager.saveKnowledge("goal-cat", e2);

    // Both entries are indexed globally; cross-goal search should find both
    const results = await manager.searchAcrossGoals("breathing rate", 10);
    expect(results.length).toBeGreaterThanOrEqual(2);
    const ids = results.map((r) => r.entry_id);
    expect(ids).toContain("e1");
    expect(ids).toContain("e2");
  });
});
