import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state/state-manager.js";
import { KnowledgeManager } from "../src/knowledge/knowledge-manager.js";
import { VectorIndex } from "../src/knowledge/vector-index.js";
import { MockEmbeddingClient } from "../src/knowledge/embedding-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import type { KnowledgeEntry, SharedKnowledgeEntry } from "../src/types/knowledge.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { randomUUID } from "node:crypto";

function makeKnowledgeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    entry_id: overrides.entry_id ?? randomUUID(),
    question: overrides.question ?? "What is the SaaS churn rate benchmark?",
    answer: overrides.answer ?? "Industry average SaaS churn is 5-7% annually.",
    sources: overrides.sources ?? [
      { type: "web", reference: "https://example.com/saas-benchmarks", reliability: "medium" },
    ],
    confidence: overrides.confidence ?? 0.75,
    acquired_at: overrides.acquired_at ?? new Date().toISOString(),
    acquisition_task_id: overrides.acquisition_task_id ?? randomUUID(),
    superseded_by: overrides.superseded_by ?? null,
    tags: overrides.tags ?? ["churn_rate", "saas", "benchmark"],
    embedding_id: overrides.embedding_id ?? null,
    ...overrides,
  };
}

function makeVectorIndex(dir: string): VectorIndex {
  const embeddingClient = new MockEmbeddingClient(8);
  return new VectorIndex(path.join(dir, "vector-index.json"), embeddingClient);
}

// Date helpers
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}
function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
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
// 5.1a — SharedKnowledgeEntry CRUD
// ═══════════════════════════════════════════════════════

describe("saveToSharedKnowledgeBase", () => {
  it("saves an entry and returns a SharedKnowledgeEntry with source_goal_ids", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry({ entry_id: "e1" });
    const shared = await manager.saveToSharedKnowledgeBase(entry, "goal-A");

    expect(shared.entry_id).toBe("e1");
    expect(shared.source_goal_ids).toContain("goal-A");
  });

  it("sets domain_stability to 'moderate' by default", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry();
    const shared = await manager.saveToSharedKnowledgeBase(entry, "goal-A");
    expect(shared.domain_stability).toBe("moderate");
  });

  it("sets revalidation_due_at to approximately 180 days from now (moderate)", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry();
    const before = Date.now();
    const shared = await manager.saveToSharedKnowledgeBase(entry, "goal-A");
    const after = Date.now();

    const dueTs = new Date(shared.revalidation_due_at!).getTime();
    const expectedMin = before + 179 * 24 * 60 * 60 * 1000;
    const expectedMax = after + 181 * 24 * 60 * 60 * 1000;
    expect(dueTs).toBeGreaterThanOrEqual(expectedMin);
    expect(dueTs).toBeLessThanOrEqual(expectedMax);
  });

  it("merges source_goal_ids when same entry is saved by two different goals", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry({ entry_id: "shared-entry" });

    await manager.saveToSharedKnowledgeBase(entry, "goal-A");
    const merged = await manager.saveToSharedKnowledgeBase(entry, "goal-B");

    expect(merged.source_goal_ids).toContain("goal-A");
    expect(merged.source_goal_ids).toContain("goal-B");
    // No duplicates
    const unique = new Set(merged.source_goal_ids);
    expect(unique.size).toBe(merged.source_goal_ids.length);
  });

  it("saving the same entry twice for the same goal does not duplicate the goal id", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry({ entry_id: "e1" });
    await manager.saveToSharedKnowledgeBase(entry, "goal-A");
    const second = await manager.saveToSharedKnowledgeBase(entry, "goal-A");
    expect(second.source_goal_ids.filter((id) => id === "goal-A")).toHaveLength(1);
  });

  it("persists entries to storage (survives a new manager instance)", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry({ entry_id: "persisted" });
    await manager.saveToSharedKnowledgeBase(entry, "goal-A");

    // Create a new manager using the same stateManager
    const manager2 = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const results = await manager2.querySharedKnowledge([]);
    expect(results.some((e) => e.entry_id === "persisted")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 5.1a — querySharedKnowledge
// ═══════════════════════════════════════════════════════

describe("querySharedKnowledge", () => {
  it("returns all entries when tags array is empty", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    await manager.saveToSharedKnowledgeBase(makeKnowledgeEntry({ entry_id: "e1", tags: ["a"] }), "g1");
    await manager.saveToSharedKnowledgeBase(makeKnowledgeEntry({ entry_id: "e2", tags: ["b"] }), "g2");
    const results = await manager.querySharedKnowledge([]);
    expect(results).toHaveLength(2);
  });

  it("filters by tags (AND logic)", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    await manager.saveToSharedKnowledgeBase(
      makeKnowledgeEntry({ entry_id: "e1", tags: ["saas", "churn"] }),
      "g1"
    );
    await manager.saveToSharedKnowledgeBase(
      makeKnowledgeEntry({ entry_id: "e2", tags: ["saas", "nps"] }),
      "g1"
    );
    const results = await manager.querySharedKnowledge(["saas", "churn"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.entry_id).toBe("e1");
  });

  it("filters by goalId — only returns entries that include the given goal", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    await manager.saveToSharedKnowledgeBase(makeKnowledgeEntry({ entry_id: "e1" }), "goal-A");
    await manager.saveToSharedKnowledgeBase(makeKnowledgeEntry({ entry_id: "e2" }), "goal-B");
    const results = await manager.querySharedKnowledge([], "goal-A");
    expect(results).toHaveLength(1);
    expect(results[0]!.entry_id).toBe("e1");
  });

  it("cross-goal entry is returned when queried by either goal", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry({ entry_id: "shared" });
    await manager.saveToSharedKnowledgeBase(entry, "goal-A");
    await manager.saveToSharedKnowledgeBase(entry, "goal-B");

    expect(await manager.querySharedKnowledge([], "goal-A")).toHaveLength(1);
    expect(await manager.querySharedKnowledge([], "goal-B")).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════
// 5.1b — Vector Search
// ═══════════════════════════════════════════════════════

describe("searchByEmbedding", () => {
  it("returns empty array when no vectorIndex is provided", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry();
    await manager.saveToSharedKnowledgeBase(entry, "g1");
    const results = await manager.searchByEmbedding("churn rate benchmark");
    expect(results).toEqual([]);
  });

  it("returns matching entries with similarity scores when vectorIndex is provided", async () => {
    const vectorIndex = makeVectorIndex(tempDir);
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([]),
      vectorIndex
    );
    const entry = makeKnowledgeEntry({
      entry_id: "e1",
      question: "What is the churn rate?",
      answer: "5-7% annually for SaaS.",
      tags: ["churn"],
    });
    await manager.saveToSharedKnowledgeBase(entry, "goal-A");
    const results = await manager.searchByEmbedding("churn rate SaaS", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entry).toBeDefined();
    expect(typeof results[0]!.similarity).toBe("number");
  });

  it("save → embed → search integration: saved entry is discoverable via embedding search", async () => {
    const vectorIndex = makeVectorIndex(tempDir);
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([]),
      vectorIndex
    );
    const entry = makeKnowledgeEntry({
      entry_id: "integration-e1",
      question: "How is NPS calculated?",
      answer: "NPS = %Promoters - %Detractors",
      tags: ["nps", "metric"],
    });
    await manager.saveToSharedKnowledgeBase(entry, "goal-nps");

    // embedding_id should be set
    const stored = await manager.querySharedKnowledge(["nps"]);
    expect(stored[0]!.embedding_id).toBe("integration-e1");

    // search should find it
    const results = await manager.searchByEmbedding("NPS calculation formula", 5);
    const found = results.find((r) => r.entry.entry_id === "integration-e1");
    expect(found).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════
// 5.1c — Domain Stability Classification
// ═══════════════════════════════════════════════════════

describe("classifyDomainStability", () => {
  it("classifies domain as 'stable' based on LLM response", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([JSON.stringify({ stability: "stable", rationale: "Math never changes" })])
    );
    const result = await manager.classifyDomainStability("mathematics", []);
    expect(result).toBe("stable");
  });

  it("classifies domain as 'volatile' based on LLM response", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([JSON.stringify({ stability: "volatile", rationale: "Crypto changes daily" })])
    );
    const result = await manager.classifyDomainStability("cryptocurrency_prices", []);
    expect(result).toBe("volatile");
  });

  it("classifies domain as 'moderate' based on LLM response", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient([JSON.stringify({ stability: "moderate", rationale: "Best practices evolve slowly" })])
    );
    const result = await manager.classifyDomainStability("saas_best_practices", []);
    expect(result).toBe("moderate");
  });

  it("falls back to 'moderate' when LLM returns invalid JSON", async () => {
    const manager = new KnowledgeManager(
      stateManager,
      createMockLLMClient(["not valid json at all"])
    );
    const result = await manager.classifyDomainStability("some_domain", []);
    expect(result).toBe("moderate");
  });
});

// ═══════════════════════════════════════════════════════
// 5.1c — Stale Entry Detection
// ═══════════════════════════════════════════════════════

describe("getStaleEntries", () => {
  it("returns entries where revalidation_due_at is in the past", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry({ entry_id: "stale-e1" });
    const shared = await manager.saveToSharedKnowledgeBase(entry, "g1");

    // Overwrite with a past due date by writing directly
    const all = await manager.querySharedKnowledge([]);
    const updated = { ...shared, revalidation_due_at: daysAgo(1) };
    await stateManager.writeRaw("memory/shared-knowledge/entries.json", [updated]);

    const stale = await manager.getStaleEntries();
    expect(stale.some((e) => e.entry_id === "stale-e1")).toBe(true);
  });

  it("does NOT include entries where revalidation_due_at is in the future", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry({ entry_id: "fresh-e1" });
    const shared = await manager.saveToSharedKnowledgeBase(entry, "g1");

    const updated = { ...shared, revalidation_due_at: daysFromNow(30) };
    await stateManager.writeRaw("memory/shared-knowledge/entries.json", [updated]);

    const stale = await manager.getStaleEntries();
    expect(stale.some((e) => e.entry_id === "fresh-e1")).toBe(false);
  });

  it("uses stability interval from acquired_at when revalidation_due_at is null — stable (365 days)", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    // acquired_at 400 days ago, stability=stable → due at 365 days → overdue
    const acquiredAt = daysAgo(400);
    const entry: SharedKnowledgeEntry = {
      ...makeKnowledgeEntry({ entry_id: "old-stable", acquired_at: acquiredAt }),
      source_goal_ids: ["g1"],
      domain_stability: "stable",
      revalidation_due_at: null,
    };
    await stateManager.writeRaw("memory/shared-knowledge/entries.json", [entry]);

    const stale = await manager.getStaleEntries();
    expect(stale.some((e) => e.entry_id === "old-stable")).toBe(true);
  });

  it("uses stability interval from acquired_at when revalidation_due_at is null — volatile (90 days)", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    // acquired_at 100 days ago, stability=volatile → due at 90 days → overdue
    const acquiredAt = daysAgo(100);
    const entry: SharedKnowledgeEntry = {
      ...makeKnowledgeEntry({ entry_id: "old-volatile", acquired_at: acquiredAt }),
      source_goal_ids: ["g1"],
      domain_stability: "volatile",
      revalidation_due_at: null,
    };
    await stateManager.writeRaw("memory/shared-knowledge/entries.json", [entry]);

    const stale = await manager.getStaleEntries();
    expect(stale.some((e) => e.entry_id === "old-volatile")).toBe(true);
  });

  it("returns empty array when all entries are fresh", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry({ entry_id: "fresh" });
    await manager.saveToSharedKnowledgeBase(entry, "g1");
    // Default revalidation_due_at is 180 days from now — not stale
    const stale = await manager.getStaleEntries();
    expect(stale).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════
// 5.1c — Revalidation Task Generation
// ═══════════════════════════════════════════════════════

describe("generateRevalidationTasks", () => {
  it("generates one task per stale entry", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const e1: SharedKnowledgeEntry = {
      ...makeKnowledgeEntry({ entry_id: "stale-1", question: "What is the NPS benchmark?" }),
      source_goal_ids: ["g1"],
      domain_stability: "moderate",
      revalidation_due_at: daysAgo(1),
    };
    const e2: SharedKnowledgeEntry = {
      ...makeKnowledgeEntry({ entry_id: "stale-2", question: "What is the churn rate benchmark?" }),
      source_goal_ids: ["g2"],
      domain_stability: "volatile",
      revalidation_due_at: daysAgo(5),
    };
    const tasks = await manager.generateRevalidationTasks([e1, e2]);
    expect(tasks).toHaveLength(2);
  });

  it("each revalidation task has task_category: knowledge_acquisition", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const stale: SharedKnowledgeEntry = {
      ...makeKnowledgeEntry({ entry_id: "s1" }),
      source_goal_ids: ["g1"],
      domain_stability: "volatile",
      revalidation_due_at: daysAgo(1),
    };
    const tasks = await manager.generateRevalidationTasks([stale]);
    expect(tasks[0]!.task_category).toBe("knowledge_acquisition");
  });

  it("revalidation task work_description references the original question", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const stale: SharedKnowledgeEntry = {
      ...makeKnowledgeEntry({ entry_id: "s1", question: "What is the average CAC for SaaS?" }),
      source_goal_ids: ["g1"],
      domain_stability: "moderate",
      revalidation_due_at: daysAgo(2),
    };
    const tasks = await manager.generateRevalidationTasks([stale]);
    expect(tasks[0]!.work_description).toContain("What is the average CAC for SaaS?");
  });

  it("returns empty array when no stale entries provided", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const tasks = await manager.generateRevalidationTasks([]);
    expect(tasks).toHaveLength(0);
  });

  it("revalidation task reversibility is 'reversible'", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const stale: SharedKnowledgeEntry = {
      ...makeKnowledgeEntry({ entry_id: "s1" }),
      source_goal_ids: ["g1"],
      domain_stability: "stable",
      revalidation_due_at: daysAgo(1),
    };
    const tasks = await manager.generateRevalidationTasks([stale]);
    expect(tasks[0]!.reversibility).toBe("reversible");
  });

  it("task goal_id is taken from source_goal_ids[0]", async () => {
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const stale: SharedKnowledgeEntry = {
      ...makeKnowledgeEntry({ entry_id: "s1" }),
      source_goal_ids: ["primary-goal", "secondary-goal"],
      domain_stability: "volatile",
      revalidation_due_at: daysAgo(1),
    };
    const tasks = await manager.generateRevalidationTasks([stale]);
    expect(tasks[0]!.goal_id).toBe("primary-goal");
  });
});
