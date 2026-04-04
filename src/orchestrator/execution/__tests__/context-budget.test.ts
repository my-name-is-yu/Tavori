import { describe, it, expect, vi } from "vitest";
import {
  allocateBudget,
  allocateTierBudget,
  estimateTokens,
  selectWithinBudget,
  trimToBudget,
  type BudgetAllocation,
} from "../context/context-budget.js";
import { VectorIndex } from "../../../platform/knowledge/vector-index.js";
import type { IEmbeddingClient } from "../../../platform/knowledge/embedding-client.js";

// ─── Helpers ───

function makeEmbeddingClient(vectorSize = 4): IEmbeddingClient {
  return {
    embed: vi.fn(async (_text: string) => Array(vectorSize).fill(0.5) as number[]),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => Array(vectorSize).fill(0.5) as number[])),
  };
}

function makeTempIndexPath() {
  return `/tmp/vi-test-${Math.random().toString(36).slice(2)}.json`;
}

// ─── allocateTierBudget ───

describe("allocateTierBudget", () => {
  it("distributes 1000 tokens: core=500, recall=350, archival=150", () => {
    const budget = allocateTierBudget(1000);
    expect(budget.core).toBe(500);
    expect(budget.recall).toBe(350);
    expect(budget.archival).toBe(150);
  });

  it("returns all zeros for 0 total tokens", () => {
    const budget = allocateTierBudget(0);
    expect(budget.core).toBe(0);
    expect(budget.recall).toBe(0);
    expect(budget.archival).toBe(0);
  });

  it("handles edge case of 1 token: core=0, recall=0, archival=1", () => {
    const budget = allocateTierBudget(1);
    // core = floor(0.5) = 0, recall = floor(0.35) = 0, archival = 1 - 0 - 0 = 1
    expect(budget.core).toBe(0);
    expect(budget.recall).toBe(0);
    expect(budget.archival).toBe(1);
  });

  it("sums to totalTokens for any input", () => {
    for (const n of [7, 100, 999, 10000]) {
      const budget = allocateTierBudget(n);
      expect(budget.core + budget.recall + budget.archival).toBe(n);
    }
  });
});

// ─── allocateBudget ───

describe("allocateBudget", () => {
  it("allocates correct proportions from a total budget", () => {
    const alloc = allocateBudget(100_000);
    expect(alloc.goalDefinition).toBe(20_000);   // 20%
    expect(alloc.observations).toBe(30_000);      // 30%
    expect(alloc.knowledge).toBe(30_000);         // 30%
    expect(alloc.transferKnowledge).toBe(15_000); // 15%
    expect(alloc.meta).toBe(5_000);               // 5%
  });

  it("floors fractional allocations", () => {
    const alloc = allocateBudget(1001);
    const total = alloc.goalDefinition + alloc.observations + alloc.knowledge +
      alloc.transferKnowledge + alloc.meta;
    expect(total).toBeLessThanOrEqual(1001);
  });
});

// ─── estimateTokens ───

describe("estimateTokens", () => {
  it("returns ceil(length / 4)", () => {
    expect(estimateTokens("abcd")).toBe(1);      // 4 chars → 1 token
    expect(estimateTokens("abcde")).toBe(2);     // 5 chars → ceil(5/4)=2
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });
});

// ─── selectWithinBudget ───

describe("selectWithinBudget", () => {
  const makeCandidates = (texts: string[]) =>
    texts.map((text, i) => ({ text, similarity: 1 - i * 0.1 }));

  it("selects all candidates when they fit within budget", () => {
    const candidates = makeCandidates(["ab", "cd"]);
    // Each "ab"/"cd" = 2 chars → 1 token each; budget=10
    const result = selectWithinBudget(candidates, 10);
    expect(result).toHaveLength(2);
  });

  it("stops when budget is exceeded", () => {
    // "aaaa" = 4 chars = 1 token; "bbbb" = 1 token; budget=1
    const candidates = makeCandidates(["aaaa", "bbbb"]);
    const result = selectWithinBudget(candidates, 1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("aaaa");
  });

  it("returns empty array when first candidate already exceeds budget", () => {
    const candidates = makeCandidates(["a".repeat(100)]); // 25 tokens
    const result = selectWithinBudget(candidates, 10);
    expect(result).toHaveLength(0);
  });

  it("returns empty array for empty candidates", () => {
    expect(selectWithinBudget([], 1000)).toHaveLength(0);
  });
});

// ─── trimToBudget ───

describe("trimToBudget", () => {
  it("returns allocation unchanged when usage is within budget", () => {
    const alloc = allocateBudget(100);
    const usage: Record<keyof BudgetAllocation, number> = {
      goalDefinition: 10,
      observations: 15,
      knowledge: 15,
      transferKnowledge: 7,
      meta: 2,
    };
    const result = trimToBudget(alloc, usage, 100);
    expect(result).toEqual(alloc);
  });

  it("trims meta first (lowest priority)", () => {
    const alloc: BudgetAllocation = {
      goalDefinition: 20,
      observations: 30,
      knowledge: 30,
      transferKnowledge: 15,
      meta: 5,
    };
    const usage: Record<keyof BudgetAllocation, number> = {
      goalDefinition: 20,
      observations: 30,
      knowledge: 30,
      transferKnowledge: 15,
      meta: 10, // 5 over
    };
    const result = trimToBudget(alloc, usage, 100);
    expect(result.meta).toBe(0); // 5 - 5 = 0
    expect(result.transferKnowledge).toBe(15); // untouched
  });

  it("trims transferKnowledge after meta is exhausted", () => {
    const alloc: BudgetAllocation = {
      goalDefinition: 20,
      observations: 30,
      knowledge: 30,
      transferKnowledge: 15,
      meta: 5,
    };
    // 10 over budget: meta=5 trimmed, then transferKnowledge loses 5
    const usage: Record<keyof BudgetAllocation, number> = {
      goalDefinition: 20,
      observations: 30,
      knowledge: 30,
      transferKnowledge: 15,
      meta: 15,
    };
    const result = trimToBudget(alloc, usage, 100);
    expect(result.meta).toBe(0);
    expect(result.transferKnowledge).toBe(10);
  });
});

// ─── VectorIndex.searchMetadata + getEntryById ───

describe("VectorIndex.searchMetadata", () => {
  it("returns id, similarity, metadata without text field", async () => {
    const client = makeEmbeddingClient();
    const index = new VectorIndex(makeTempIndexPath(), client);
    await index.add("entry1", "hello world", { goal_id: "g1" });

    const results = await index.searchMetadata("hello", 5);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("entry1");
    expect(results[0].similarity).toBeGreaterThanOrEqual(0);
    expect(results[0].metadata).toMatchObject({ goal_id: "g1" });
    // text must NOT be present
    expect((results[0] as Record<string, unknown>)["text"]).toBeUndefined();
  });

  it("respects topK limit", async () => {
    const client = makeEmbeddingClient();
    const index = new VectorIndex(makeTempIndexPath(), client);
    await index.add("e1", "text1", {});
    await index.add("e2", "text2", {});
    await index.add("e3", "text3", {});

    const results = await index.searchMetadata("text", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("VectorIndex.getEntryById", () => {
  it("returns the entry for a known id", async () => {
    const client = makeEmbeddingClient();
    const index = new VectorIndex(makeTempIndexPath(), client);
    await index.add("abc", "the text", { tag: "x" });

    const entry = index.getEntryById("abc");
    expect(entry).toBeDefined();
    expect(entry?.id).toBe("abc");
    expect(entry?.text).toBe("the text");
  });

  it("returns undefined for unknown id", () => {
    const client = makeEmbeddingClient();
    const index = new VectorIndex(makeTempIndexPath(), client);
    expect(index.getEntryById("nonexistent")).toBeUndefined();
  });
});

// ─── Progressive Disclosure integration ───

describe("Progressive Disclosure: searchMetadata → selectWithinBudget → getEntryById", () => {
  it("retrieves metadata, selects within budget, then loads full text", async () => {
    const client = makeEmbeddingClient();
    const index = new VectorIndex(makeTempIndexPath(), client);

    // Add 3 entries with varying text lengths
    await index.add("short", "hi", {});          // 1 token
    await index.add("medium", "a".repeat(40), {}); // 10 tokens
    await index.add("long", "b".repeat(200), {});  // 50 tokens

    // Step 1: searchMetadata — get candidates without text
    const candidates = await index.searchMetadata("query", 20);
    expect(candidates.length).toBe(3);

    // Step 2: build objects with text for budget selection
    const withText = candidates
      .map((c) => {
        const entry = index.getEntryById(c.id);
        return entry ? { ...c, text: entry.text } : null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    // Budget of 15 tokens: "hi"(1) + "aaa..."(10) = 11 fit, "bbb..."(50) does not
    const selected = selectWithinBudget(withText, 15);

    // We should have at least the short entry
    expect(selected.length).toBeGreaterThanOrEqual(1);
    const selectedIds = selected.map((s) => s.id);
    expect(selectedIds).not.toContain("long"); // 50 tokens doesn't fit in 15

    // Step 3: verify full text is accessible
    for (const s of selected) {
      expect(s.text).toBeTruthy();
    }
  });
});
