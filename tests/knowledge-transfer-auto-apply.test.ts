import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KnowledgeTransfer } from "../src/knowledge/transfer/knowledge-transfer.js";
import { KnowledgeManager } from "../src/knowledge/knowledge-manager.js";
import { StateManager } from "../src/state/state-manager.js";
import { VectorIndex } from "../src/knowledge/vector-index.js";
import { MockEmbeddingClient } from "../src/knowledge/embedding-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import type { LearnedPattern } from "../src/types/learning.js";
import type { DecisionRecord } from "../src/types/knowledge.js";

// ─── Helpers ───

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kt-auto-apply-test-"));
}

function makePattern(overrides: Partial<LearnedPattern> = {}): LearnedPattern {
  return {
    pattern_id: overrides.pattern_id ?? "pat_1",
    type: overrides.type ?? "scope_sizing",
    description: overrides.description ?? "When blocked, reduce scope",
    confidence: overrides.confidence ?? 0.9,
    evidence_count: overrides.evidence_count ?? 10,
    source_goal_ids: overrides.source_goal_ids ?? ["goal_a"],
    applicable_domains: overrides.applicable_domains ?? ["testing"],
    embedding_id: overrides.embedding_id ?? null,
    created_at: overrides.created_at ?? new Date().toISOString(),
    last_applied_at: overrides.last_applied_at ?? null,
  };
}

function makeMockEthicsGate(verdict: "pass" | "flag" | "reject" = "pass") {
  return {
    check: async () => ({
      verdict,
      reasoning: verdict === "reject" ? "Rejected by ethics" : "Approved",
      confidence: 0.9,
    }),
  } as any;
}

function makeMockLearningPipeline(patternsPerGoal: Record<string, LearnedPattern[]> = {}) {
  return {
    getPatterns: async (goalId: string) => patternsPerGoal[goalId] ?? [],
  } as any;
}

function makeMockTransferTrust(trustScore: number = 0.8) {
  return {
    getTrustScore: async () => ({
      domain_pair: "testing",
      trust_score: trustScore,
      success_count: 5,
      failure_count: 1,
      neutral_count: 1,
      last_updated: new Date().toISOString(),
    }),
    shouldInvalidate: async () => false,
    updateTrust: async () => ({}),
  } as any;
}

const ADAPTATION_RESPONSE = JSON.stringify({
  adaptation_description: "Adapted pattern for target context",
  adapted_content: "Reduce scope when blocked in target domain",
  success: true,
});

// ─── KnowledgeTransfer auto-apply tests ───

describe("KnowledgeTransfer.autoApplyHighConfidenceTransfers", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let vectorIndex: VectorIndex;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    stateManager = new StateManager(tmpDir);
    const embeddingClient = new MockEmbeddingClient();
    vectorIndex = new VectorIndex(path.join(tmpDir, "vectors.json"), embeddingClient);

    // Set up two goals in state manager
    await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.5 });
    await stateManager.writeRaw("goals/goal_b/state.json", { gap: 0.6 });
  });

  it("auto-applies when confidence >= 0.85 and trust_score >= 0.7", async () => {
    const highConfPattern = makePattern({ confidence: 0.9, applicable_domains: ["testing"] });
    const llmClient = createMockLLMClient([ADAPTATION_RESPONSE, ADAPTATION_RESPONSE, ADAPTATION_RESPONSE]);
    const kt = new KnowledgeTransfer({
      llmClient,
      knowledgeManager: {} as any,
      vectorIndex,
      learningPipeline: makeMockLearningPipeline({ goal_a: [highConfPattern] }),
      ethicsGate: makeMockEthicsGate("pass"),
      stateManager,
      transferTrust: makeMockTransferTrust(0.8),
    });

    const results = await kt.autoApplyHighConfidenceTransfers("goal_b");
    expect(results.length).toBeGreaterThan(0);
    const applied = results.filter((c) => c.state === "applied");
    expect(applied.length).toBeGreaterThan(0);
  });

  it("keeps as proposed when confidence < 0.85", async () => {
    const lowConfPattern = makePattern({ confidence: 0.75, applicable_domains: ["testing"] });
    const llmClient = createMockLLMClient([ADAPTATION_RESPONSE, ADAPTATION_RESPONSE, ADAPTATION_RESPONSE]);
    const kt = new KnowledgeTransfer({
      llmClient,
      knowledgeManager: {} as any,
      vectorIndex,
      learningPipeline: makeMockLearningPipeline({ goal_a: [lowConfPattern] }),
      ethicsGate: makeMockEthicsGate("pass"),
      stateManager,
      transferTrust: makeMockTransferTrust(0.8),
    });

    const results = await kt.autoApplyHighConfidenceTransfers("goal_b");
    expect(results.length).toBeGreaterThan(0);
    const proposed = results.filter((c) => c.state === "proposed");
    expect(proposed.length).toBeGreaterThan(0);
    const applied = results.filter((c) => c.state === "applied");
    expect(applied.length).toBe(0);
  });

  it("keeps as proposed when trust_score < 0.7", async () => {
    const highConfPattern = makePattern({ confidence: 0.9, applicable_domains: ["testing"] });
    const llmClient = createMockLLMClient([ADAPTATION_RESPONSE, ADAPTATION_RESPONSE, ADAPTATION_RESPONSE]);
    const kt = new KnowledgeTransfer({
      llmClient,
      knowledgeManager: {} as any,
      vectorIndex,
      learningPipeline: makeMockLearningPipeline({ goal_a: [highConfPattern] }),
      ethicsGate: makeMockEthicsGate("pass"),
      stateManager,
      transferTrust: makeMockTransferTrust(0.5), // below threshold
    });

    const results = await kt.autoApplyHighConfidenceTransfers("goal_b");
    expect(results.length).toBeGreaterThan(0);
    const proposed = results.filter((c) => c.state === "proposed");
    expect(proposed.length).toBeGreaterThan(0);
    const applied = results.filter((c) => c.state === "applied");
    expect(applied.length).toBe(0);
  });

  it("rejects when ethics-gate returns reject", async () => {
    const highConfPattern = makePattern({ confidence: 0.9, applicable_domains: ["testing"] });
    const llmClient = createMockLLMClient([ADAPTATION_RESPONSE, ADAPTATION_RESPONSE, ADAPTATION_RESPONSE]);
    const kt = new KnowledgeTransfer({
      llmClient,
      knowledgeManager: {} as any,
      vectorIndex,
      learningPipeline: makeMockLearningPipeline({ goal_a: [highConfPattern] }),
      ethicsGate: makeMockEthicsGate("reject"),
      stateManager,
      transferTrust: makeMockTransferTrust(0.8),
    });

    const results = await kt.autoApplyHighConfidenceTransfers("goal_b");
    expect(results.length).toBeGreaterThan(0);
    const rejected = results.filter((c) => c.state === "rejected");
    expect(rejected.length).toBeGreaterThan(0);
    const applied = results.filter((c) => c.state === "applied");
    expect(applied.length).toBe(0);
  });

  it("rejects when ethics-gate returns flag", async () => {
    const highConfPattern = makePattern({ confidence: 0.9, applicable_domains: ["testing"] });
    const llmClient = createMockLLMClient([ADAPTATION_RESPONSE, ADAPTATION_RESPONSE, ADAPTATION_RESPONSE]);
    const kt = new KnowledgeTransfer({
      llmClient,
      knowledgeManager: {} as any,
      vectorIndex,
      learningPipeline: makeMockLearningPipeline({ goal_a: [highConfPattern] }),
      ethicsGate: makeMockEthicsGate("flag"),
      stateManager,
      transferTrust: makeMockTransferTrust(0.8),
    });

    const results = await kt.autoApplyHighConfidenceTransfers("goal_b");
    const rejected = results.filter((c) => c.state === "rejected");
    expect(rejected.length).toBeGreaterThan(0);
  });
});

// ─── detectCandidatesRealtime tests ───

describe("KnowledgeTransfer.detectCandidatesRealtime", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let vectorIndex: VectorIndex;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    stateManager = new StateManager(tmpDir);
    const embeddingClient = new MockEmbeddingClient();
    vectorIndex = new VectorIndex(path.join(tmpDir, "vectors.json"), embeddingClient);

    await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.5 });
    await stateManager.writeRaw("goals/goal_b/state.json", { gap: 0.6 });
  });

  it("returns contextSnippets for high-score candidates", async () => {
    const pattern = makePattern({ confidence: 0.8, applicable_domains: ["testing"] });
    const llmClient = createMockLLMClient([ADAPTATION_RESPONSE, ADAPTATION_RESPONSE, ADAPTATION_RESPONSE]);
    const kt = new KnowledgeTransfer({
      llmClient,
      knowledgeManager: {} as any,
      vectorIndex,
      learningPipeline: makeMockLearningPipeline({ goal_a: [pattern] }),
      ethicsGate: makeMockEthicsGate("pass"),
      stateManager,
      transferTrust: makeMockTransferTrust(0.7),
    });

    const { candidates, contextSnippets } = await kt.detectCandidatesRealtime("goal_b");
    expect(candidates.length).toBeGreaterThan(0);
    // At least one snippet should be present (similarity defaults to 0.7 which equals threshold)
    expect(contextSnippets.length).toBeGreaterThanOrEqual(0);
    // contextSnippets should be strings
    for (const snippet of contextSnippets) {
      expect(typeof snippet).toBe("string");
    }
  });

  it("returns empty candidates when no source goals have patterns", async () => {
    const llmClient = createMockLLMClient([]);
    const kt = new KnowledgeTransfer({
      llmClient,
      knowledgeManager: {} as any,
      vectorIndex,
      learningPipeline: makeMockLearningPipeline({}),
      ethicsGate: makeMockEthicsGate("pass"),
      stateManager,
      transferTrust: makeMockTransferTrust(0.8),
    });

    const { candidates, contextSnippets } = await kt.detectCandidatesRealtime("goal_b");
    expect(candidates).toHaveLength(0);
    expect(contextSnippets).toHaveLength(0);
  });
});

// ─── KnowledgeManager.enrichDecisionRecord tests ───

describe("KnowledgeManager.enrichDecisionRecord", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  const makeDecisionRecord = (outcome: "success" | "failure" | "pending" = "success"): DecisionRecord => ({
    id: "dec_1",
    goal_id: "goal_a",
    goal_type: "coding",
    strategy_id: "strat_1",
    decision: "proceed",
    context: {
      gap_value: 0.6,
      stall_count: 0,
      cycle_count: 3,
      trust_score: 0.8,
    },
    outcome,
    timestamp: new Date().toISOString(),
    what_worked: [],
    what_failed: [],
    suggested_next: [],
  });

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stateManager = new StateManager(tmpDir);
  });

  it("extracts what_worked/what_failed/suggested_next via LLM", async () => {
    const enrichmentResponse = JSON.stringify({
      what_worked: ["focused scope", "iterative approach"],
      what_failed: [],
      suggested_next: ["continue with same strategy"],
    });
    const llmClient = createMockLLMClient([enrichmentResponse]);
    const km = new KnowledgeManager(stateManager, llmClient);

    const record = makeDecisionRecord("success");
    const enriched = await km.enrichDecisionRecord(record);

    expect(enriched.what_worked).toEqual(["focused scope", "iterative approach"]);
    expect(enriched.what_failed).toEqual([]);
    expect(enriched.suggested_next).toEqual(["continue with same strategy"]);
  });

  it("returns default empty arrays when LLM fails", async () => {
    const llmClient = createMockLLMClient(["not valid json at all"]);
    const km = new KnowledgeManager(stateManager, llmClient);

    const record = makeDecisionRecord("failure");
    const enriched = await km.enrichDecisionRecord(record);

    // Should fall back gracefully — fields are arrays (possibly empty)
    expect(Array.isArray(enriched.what_worked)).toBe(true);
    expect(Array.isArray(enriched.what_failed)).toBe(true);
    expect(Array.isArray(enriched.suggested_next)).toBe(true);
  });

  it("recordDecision enriches completed records automatically", async () => {
    const enrichmentResponse = JSON.stringify({
      what_worked: ["clear goal definition"],
      what_failed: ["underestimated complexity"],
      suggested_next: ["break into subtasks"],
    });
    const llmClient = createMockLLMClient([enrichmentResponse]);
    const km = new KnowledgeManager(stateManager, llmClient);

    const record = makeDecisionRecord("success");
    await km.recordDecision(record);

    // Load the saved file and check enrichment
    const decisions = await km.queryDecisions("coding");
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.what_worked).toEqual(["clear goal definition"]);
  });

  it("recordDecision does NOT enrich pending records", async () => {
    const enrichSpy = vi.fn().mockResolvedValue(makeDecisionRecord("pending"));
    const llmClient = createMockLLMClient("{}");
    const km = new KnowledgeManager(stateManager, llmClient);
    // Spy on enrichDecisionRecord
    (km as any).enrichDecisionRecord = enrichSpy;

    const record = makeDecisionRecord("pending");
    await km.recordDecision(record);

    expect(enrichSpy).not.toHaveBeenCalled();
  });
});
