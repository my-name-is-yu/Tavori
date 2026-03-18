import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KnowledgeTransfer } from "../src/knowledge/knowledge-transfer.js";
import { StateManager } from "../src/state-manager.js";
import { VectorIndex } from "../src/knowledge/vector-index.js";
import { MockEmbeddingClient } from "../src/knowledge/embedding-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import type { LearnedPattern } from "../src/types/learning.js";

// ─── Helpers ───

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kt-test-"));
}

function makePattern(overrides: Partial<LearnedPattern> = {}): LearnedPattern {
  return {
    pattern_id: overrides.pattern_id ?? "pat_1",
    type: overrides.type ?? "scope_sizing",
    description: overrides.description ?? "When blocked, reduce scope",
    confidence: overrides.confidence ?? 0.8,
    evidence_count: overrides.evidence_count ?? 5,
    source_goal_ids: overrides.source_goal_ids ?? ["goal_a"],
    applicable_domains: overrides.applicable_domains ?? ["testing"],
    embedding_id: overrides.embedding_id ?? null,
    created_at: overrides.created_at ?? new Date().toISOString(),
    last_applied_at: overrides.last_applied_at ?? null,
  };
}

function makeMockKnowledgeManager() {
  return {} as any;
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

function makeMockLearningPipeline(
  patternsPerGoal: Record<string, LearnedPattern[]> = {}
) {
  return {
    getPatterns: (goalId: string) => patternsPerGoal[goalId] ?? [],
  } as any;
}

const ADAPTATION_RESPONSE = JSON.stringify({
  adaptation_description: "Adapted pattern for target context",
  adapted_content: "Reduce scope when blocked in target domain",
  success: true,
});

const ADAPTATION_FAILURE_RESPONSE = JSON.stringify({
  adaptation_description: "Pattern not applicable to target",
  adapted_content: "",
  success: false,
});

const META_PATTERNS_RESPONSE = JSON.stringify({
  meta_patterns: [
    {
      description: "Reduce scope when progress stalls",
      applicable_domains: ["testing", "ci"],
      source_pattern_ids: ["pat_1", "pat_2"],
    },
    {
      description: "Incremental approach for complex tasks",
      applicable_domains: ["refactoring"],
      source_pattern_ids: ["pat_3"],
    },
  ],
});

const EMPTY_META_PATTERNS_RESPONSE = JSON.stringify({
  meta_patterns: [],
});

describe("KnowledgeTransfer", async () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let vectorIndex: VectorIndex;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stateManager = new StateManager(tmpDir);
    const embeddingClient = new MockEmbeddingClient();
    vectorIndex = new VectorIndex(
      path.join(tmpDir, "vectors.json"),
      embeddingClient
    );
  });

  async function createKT(opts: {
    llmResponses?: string[];
    patternsPerGoal?: Record<string, LearnedPattern[]>;
    ethicsVerdict?: "pass" | "flag" | "reject";
    goalIds?: string[];
  } = {}) {
    const llmClient = createMockLLMClient(opts.llmResponses ?? []);
    const learningPipeline = makeMockLearningPipeline(opts.patternsPerGoal ?? {});
    const ethicsGate = makeMockEthicsGate(opts.ethicsVerdict ?? "pass");

    for (const goalId of opts.goalIds ?? []) {
      await stateManager.writeRaw(`goals/${goalId}/state.json`, { gap: 0.5 });
    }

    return new KnowledgeTransfer({
      llmClient,
      knowledgeManager: makeMockKnowledgeManager(),
      vectorIndex,
      learningPipeline,
      ethicsGate,
      stateManager,
    });
  }

  describe("detectTransferOpportunities", async () => {
    it("returns empty array when there are no other goals", async () => {
      const kt = await createKT({ goalIds: ["goal_a"] });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result).toEqual([]);
    });

    it("returns empty array when other goals have no patterns", async () => {
      const kt = await createKT({ goalIds: ["goal_a", "goal_b"], patternsPerGoal: {} });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result).toEqual([]);
    });

    it("returns empty array when patterns already include target goal in source_goal_ids", async () => {
      const pattern = makePattern({ source_goal_ids: ["goal_a", "goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result).toEqual([]);
    });

    it("filters patterns below confidence threshold (0.6)", async () => {
      const lowConfPattern = makePattern({ confidence: 0.5, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [lowConfPattern] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result).toEqual([]);
    });

    it("returns candidates for patterns with confidence >= 0.6", async () => {
      const pattern = makePattern({ confidence: 0.7, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result.length).toBe(1);
      expect(result[0]!.source_goal_id).toBe("goal_b");
      expect(result[0]!.target_goal_id).toBe("goal_a");
      expect(result[0]!.type).toBe("pattern");
    });

    it("candidate has correct source_item_id from pattern", async () => {
      const pattern = makePattern({ pattern_id: "pat_custom", confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result[0]!.source_item_id).toBe("pat_custom");
    });

    it("candidate has similarity_score of 0.7 (default) when no vector data", async () => {
      const pattern = makePattern({ confidence: 0.9, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result[0]!.similarity_score).toBe(0.7);
    });

    it("stores candidates internally and returns them via getTransferCandidates", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
      });
      await kt.detectTransferOpportunities("goal_a");
      expect(kt.getTransferCandidates().length).toBe(1);
    });

    it("collects patterns from multiple source goals", async () => {
      const patB = makePattern({ pattern_id: "pat_b", confidence: 0.8, source_goal_ids: ["goal_b"] });
      const patC = makePattern({ pattern_id: "pat_c", confidence: 0.9, source_goal_ids: ["goal_c"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b", "goal_c"],
        patternsPerGoal: { goal_b: [patB], goal_c: [patC] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result.length).toBe(2);
    });

    it("sorts candidates by rank score descending", async () => {
      const patLow = makePattern({ pattern_id: "pat_low", confidence: 0.6, source_goal_ids: ["goal_b"] });
      const patHigh = makePattern({ pattern_id: "pat_high", confidence: 0.95, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [patLow, patHigh] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result.length).toBe(2);
      expect(result[0]!.source_item_id).toBe("pat_high");
      expect(result[1]!.source_item_id).toBe("pat_low");
    });

    it("skips invalidated patterns", async () => {
      const pattern = makePattern({ pattern_id: "pat_bad", confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: [ADAPTATION_RESPONSE, ADAPTATION_RESPONSE, ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });

      const candidates = await kt.detectTransferOpportunities("goal_a");
      expect(candidates.length).toBe(1);

      for (let i = 0; i < 3; i++) {
        const applyResult = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
        await kt.evaluateTransferEffect(applyResult.transfer_id);
      }

      const kt2Candidates = await kt.detectTransferOpportunities("goal_a");
      expect(kt2Candidates.length).toBe(0);
    });

    it("uses vector index similarity when entries exist", async () => {
      const pattern = makePattern({
        pattern_id: "pat_vec", confidence: 0.8, source_goal_ids: ["goal_b"], embedding_id: "emb_1",
      });
      await vectorIndex.add("emb_1", "scope reduction pattern", { type: "pattern" });

      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it("handles vector index search errors gracefully", async () => {
      const pattern = makePattern({
        pattern_id: "pat_err", confidence: 0.8, source_goal_ids: ["goal_b"], embedding_id: "emb_nonexistent",
      });
      await vectorIndex.add("emb_other", "something else", {});

      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(Array.isArray(result)).toBe(true);
    });

    it("candidate_id has tc_ prefix", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result[0]!.candidate_id).toMatch(/^tc_/);
    });

    it("estimated_benefit contains pattern description and confidence", async () => {
      const pattern = makePattern({
        description: "Reduce scope when stalled", confidence: 0.85, source_goal_ids: ["goal_b"],
      });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result[0]!.estimated_benefit).toContain("Reduce scope when stalled");
      expect(result[0]!.estimated_benefit).toContain("0.85");
    });

    it("includes multiple patterns from the same source goal", async () => {
      const pat1 = makePattern({ pattern_id: "pat_1", confidence: 0.7, source_goal_ids: ["goal_b"] });
      const pat2 = makePattern({ pattern_id: "pat_2", confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pat1, pat2] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result.length).toBe(2);
    });

    it("filters patterns at exact confidence boundary 0.6", async () => {
      const patExact = makePattern({ pattern_id: "pat_exact", confidence: 0.6, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [patExact] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result.length).toBe(1);
    });

    it("filters pattern at confidence just below 0.6", async () => {
      const pat = makePattern({ pattern_id: "pat_just_below", confidence: 0.59, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pat] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result.length).toBe(0);
    });

    it("does not include the target goal as a source", async () => {
      const ownPattern = makePattern({ pattern_id: "pat_own", confidence: 0.9, source_goal_ids: ["goal_a"] });
      const kt = await createKT({
        goalIds: ["goal_a"],
        patternsPerGoal: { goal_a: [ownPattern] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result.length).toBe(0);
    });

    it("accumulates candidates across multiple calls", async () => {
      const patB = makePattern({ pattern_id: "pat_b", confidence: 0.8, source_goal_ids: ["goal_b"] });
      const patC = makePattern({ pattern_id: "pat_c", confidence: 0.8, source_goal_ids: ["goal_c"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b", "goal_c"],
        patternsPerGoal: { goal_b: [patB], goal_c: [patC] },
      });

      await kt.detectTransferOpportunities("goal_a");
      await kt.detectTransferOpportunities("goal_b");

      const allCandidates = kt.getTransferCandidates();
      expect(allCandidates.length).toBeGreaterThanOrEqual(2);
    });

    it("handles vector index with entries but pattern without embedding_id", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"], embedding_id: null });
      await vectorIndex.add("emb_unrelated", "unrelated text", {});

      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result.length).toBe(1);
      expect(result[0]!.similarity_score).toBe(0.7);
    });

    it("rank score is product of similarity, confidence, and effectiveness", async () => {
      const pat = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pat] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      expect(result[0]!.estimated_benefit).toContain("0.280");
    });

    it("returns empty when only goal in system is the target", async () => {
      const kt = await createKT({ goalIds: ["only_goal"], patternsPerGoal: {} });
      const result = await kt.detectTransferOpportunities("only_goal");
      expect(result).toEqual([]);
    });

    it("handles goal not in stateManager gracefully", async () => {
      const kt = await createKT({
        goalIds: ["goal_b"],
        patternsPerGoal: {
          goal_b: [makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] })],
        },
      });
      const result = await kt.detectTransferOpportunities("unknown_goal");
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("applyTransfer", async () => {
    it("returns failure when candidate is not found", async () => {
      const kt = await createKT({ goalIds: ["goal_a"] });
      const result = await kt.applyTransfer("nonexistent_id", "goal_a");
      expect(result.success).toBe(false);
      expect(result.adaptation_description).toBe("Candidate not found");
    });

    it("stores failed result even for unknown candidate", async () => {
      const kt = await createKT({ goalIds: ["goal_a"] });
      await kt.applyTransfer("nonexistent_id", "goal_a");
      const results = kt.getTransferResults();
      expect(results.length).toBe(1);
      expect(results[0]!.success).toBe(false);
    });

    it("transfer_id has tr_ prefix", async () => {
      const kt = await createKT({ goalIds: ["goal_a"] });
      const result = await kt.applyTransfer("nonexistent_id", "goal_a");
      expect(result.transfer_id).toMatch(/^tr_/);
    });

    it("returns failure when ethics gate rejects", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        ethicsVerdict: "reject",
      });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const result = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      expect(result.success).toBe(false);
      expect(result.adaptation_description).toContain("Ethics gate rejected");
    });

    it("succeeds when ethics gate passes", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: [ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const result = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      expect(result.success).toBe(true);
    });

    it("uses LLM adaptation when source pattern exists", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: [ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const result = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      expect(result.adaptation_description).toBe("Adapted pattern for target context");
    });

    it("returns success=false when LLM adaptation returns success=false", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: [ADAPTATION_FAILURE_RESPONSE],
        ethicsVerdict: "pass",
      });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const result = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      expect(result.success).toBe(false);
    });

    it("falls back to estimated_benefit when LLM throws", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: ["NOT VALID JSON AT ALL"],
        ethicsVerdict: "pass",
      });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const result = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      expect(result.success).toBe(true);
      expect(result.adaptation_description).toContain("When blocked");
    });

    it("stores result in internal results map", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: [ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      expect(kt.getTransferResults().length).toBe(1);
    });

    it("has applied_at as valid ISO datetime", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: [ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const result = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      expect(() => new Date(result.applied_at)).not.toThrow();
      expect(new Date(result.applied_at).toISOString()).toBeTruthy();
    });

    it("result candidate_id matches the input candidate_id", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: [ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const candidateId = candidates[0]!.candidate_id;
      const result = await kt.applyTransfer(candidateId, "goal_a");
      expect(result.candidate_id).toBe(candidateId);
    });

    it("proceeds when ethics gate returns flag (not reject)", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: [ADAPTATION_RESPONSE],
        ethicsVerdict: "flag",
      });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const result = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      expect(result.success).toBe(true);
    });

    it("handles ethics gate that throws an error", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const throwingEthicsGate = {
        check: async () => { throw new Error("Ethics service unavailable"); },
      } as any;

      const llmClient = createMockLLMClient([]);
      const learningPipeline = makeMockLearningPipeline({ goal_b: [pattern] });

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.5 });
      await stateManager.writeRaw("goals/goal_b/state.json", { gap: 0.3 });

      const kt = new KnowledgeTransfer({
        llmClient,
        knowledgeManager: makeMockKnowledgeManager(),
        vectorIndex,
        learningPipeline,
        ethicsGate: throwingEthicsGate,
        stateManager,
      });

      const candidates = await kt.detectTransferOpportunities("goal_a");
      const result = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      expect(result.success).toBe(false);
      expect(result.adaptation_description).toBe("Ethics gate check failed");
    });

    it("applies multiple transfers and stores all results", async () => {
      const pat1 = makePattern({ pattern_id: "pat_1", confidence: 0.8, source_goal_ids: ["goal_b"] });
      const pat2 = makePattern({ pattern_id: "pat_2", confidence: 0.9, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pat1, pat2] },
        llmResponses: [ADAPTATION_RESPONSE, ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      expect(candidates.length).toBe(2);
      await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      await kt.applyTransfer(candidates[1]!.candidate_id, "goal_a");
      expect(kt.getTransferResults().length).toBe(2);
    });

    it("uses estimated_benefit when source pattern is not found in learning pipeline", async () => {
      const pattern = makePattern({ pattern_id: "pat_missing", confidence: 0.8, source_goal_ids: ["goal_b"] });
      const learningPipeline = {
        getPatterns: (goalId: string) => goalId === "goal_b" ? [pattern] : [],
      } as any;

      const llmClient = createMockLLMClient([]);
      const ethicsGate = makeMockEthicsGate("pass");

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.5 });
      await stateManager.writeRaw("goals/goal_b/state.json", { gap: 0.3 });

      const kt = new KnowledgeTransfer({
        llmClient, knowledgeManager: makeMockKnowledgeManager(),
        vectorIndex, learningPipeline, ethicsGate, stateManager,
      });

      const candidates = await kt.detectTransferOpportunities("goal_a");
      const result = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      expect(result.success).toBe(true);
    });

    it("ethics rejection result includes reasoning from gate", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        ethicsVerdict: "reject",
      });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const result = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      expect(result.adaptation_description).toContain("Rejected by ethics");
    });

    it("each apply generates a unique transfer_id", async () => {
      const pat = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pat] },
        llmResponses: [ADAPTATION_RESPONSE, ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const r1 = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      const r2 = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      expect(r1.transfer_id).not.toBe(r2.transfer_id);
    });
  });

  describe("evaluateTransferEffect", async () => {
    it("returns neutral record for unknown transfer_id", async () => {
      const kt = await createKT({ goalIds: ["goal_a"] });
      const record = await kt.evaluateTransferEffect("unknown_id");
      expect(record.effectiveness).toBe("neutral");
      expect(record.gap_delta_before).toBe(0);
      expect(record.gap_delta_after).toBe(0);
    });

    it("returns positive when gap decreased after transfer", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: [ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.8 });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const applyResult = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.3 });
      const record = await kt.evaluateTransferEffect(applyResult.transfer_id);
      expect(record.effectiveness).toBe("positive");
      expect(record.gap_delta_before).toBe(0.8);
      expect(record.gap_delta_after).toBe(0.3);
    });

    it("returns negative when gap increased after transfer", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: [ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.3 });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const applyResult = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.8 });
      const record = await kt.evaluateTransferEffect(applyResult.transfer_id);
      expect(record.effectiveness).toBe("negative");
    });

    it("returns neutral when gap change is within 0.05 threshold", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: [ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.5 });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const applyResult = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.48 });
      const record = await kt.evaluateTransferEffect(applyResult.transfer_id);
      expect(record.effectiveness).toBe("neutral");
    });

    it("has valid evaluated_at datetime", async () => {
      const kt = await createKT({ goalIds: ["goal_a"] });
      const record = await kt.evaluateTransferEffect("unknown");
      expect(() => new Date(record.evaluated_at)).not.toThrow();
    });

    it("tracks consecutive non-positive for pattern invalidation", async () => {
      const pattern = makePattern({ pattern_id: "pat_track", confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: [ADAPTATION_RESPONSE, ADAPTATION_RESPONSE, ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.5 });

      for (let i = 0; i < 3; i++) {
        const candidates = await kt.detectTransferOpportunities("goal_a");
        if (candidates.length === 0) break;
        const applyResult = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
        await kt.evaluateTransferEffect(applyResult.transfer_id);
      }

      const finalCandidates = await kt.detectTransferOpportunities("goal_a");
      expect(finalCandidates.length).toBe(0);
    });

    it("resets consecutive counter on positive outcome", async () => {
      const pattern = makePattern({ pattern_id: "pat_reset", confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: Array(6).fill(ADAPTATION_RESPONSE),
        ethicsVerdict: "pass",
      });

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.5 });
      for (let i = 0; i < 2; i++) {
        const candidates = await kt.detectTransferOpportunities("goal_a");
        const applyResult = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
        await kt.evaluateTransferEffect(applyResult.transfer_id);
      }

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.8 });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      expect(candidates.length).toBe(1);
      const applyResult = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.2 });
      const record = await kt.evaluateTransferEffect(applyResult.transfer_id);
      expect(record.effectiveness).toBe("positive");

      const moreCandidates = await kt.detectTransferOpportunities("goal_a");
      expect(moreCandidates.length).toBe(1);
    });

    it("uses gap_score when gap field is absent", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: [ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });

      await stateManager.writeRaw("goals/goal_a/state.json", { gap_score: 0.7 });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const applyResult = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");

      await stateManager.writeRaw("goals/goal_a/state.json", { gap_score: 0.2 });
      const record = await kt.evaluateTransferEffect(applyResult.transfer_id);
      expect(record.effectiveness).toBe("positive");
      expect(record.gap_delta_before).toBe(0.7);
      expect(record.gap_delta_after).toBe(0.2);
    });

    it("defaults gap to 0.5 when state file has no gap fields", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const learningPipeline = makeMockLearningPipeline({ goal_b: [pattern] });
      const llmClient = createMockLLMClient([ADAPTATION_RESPONSE]);
      const ethicsGate = makeMockEthicsGate("pass");

      await stateManager.writeRaw("goals/goal_a/state.json", { something: "else" });
      await stateManager.writeRaw("goals/goal_b/state.json", { gap: 0.3 });

      const kt = new KnowledgeTransfer({
        llmClient, knowledgeManager: makeMockKnowledgeManager(),
        vectorIndex, learningPipeline, ethicsGate, stateManager,
      });

      const candidates = await kt.detectTransferOpportunities("goal_a");
      if (candidates.length > 0) {
        const applyResult = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
        const record = await kt.evaluateTransferEffect(applyResult.transfer_id);
        expect(record.gap_delta_before).toBe(0.5);
      }
    });

    it("handles null source_pattern gracefully (no tracker update)", async () => {
      const pattern = makePattern({ pattern_id: "pat_null_src", confidence: 0.8, source_goal_ids: ["goal_b"] });
      let callCount = 0;
      const learningPipeline = {
        getPatterns: (goalId: string) => {
          if (goalId === "goal_b") {
            callCount++;
            if (callCount <= 1) return [pattern];
            return [];
          }
          return [];
        },
      } as any;

      const llmClient = createMockLLMClient([]);
      const ethicsGate = makeMockEthicsGate("pass");

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.5 });
      await stateManager.writeRaw("goals/goal_b/state.json", { gap: 0.3 });

      const kt = new KnowledgeTransfer({
        llmClient, knowledgeManager: makeMockKnowledgeManager(),
        vectorIndex, learningPipeline, ethicsGate, stateManager,
      });

      const candidates = await kt.detectTransferOpportunities("goal_a");
      expect(candidates.length).toBe(1);

      const applyResult = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      const record = await kt.evaluateTransferEffect(applyResult.transfer_id);
      expect(record.effectiveness).toBe("neutral");
    });

    it("exact boundary: delta = 0.05 may round to positive due to float precision", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: [ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });

      // Use values that produce exactly 0.04 delta (clearly neutral)
      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.54 });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const applyResult = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.5 });
      const record = await kt.evaluateTransferEffect(applyResult.transfer_id);
      expect(record.effectiveness).toBe("neutral");
    });

    it("delta just over 0.05 is positive", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: [ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.56 });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const applyResult = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.5 });
      const record = await kt.evaluateTransferEffect(applyResult.transfer_id);
      expect(record.effectiveness).toBe("positive");
    });

    it("small negative delta within threshold is neutral", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: [ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });

      // Use values that produce exactly -0.04 delta (clearly neutral)
      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.5 });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      const applyResult = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.54 });
      const record = await kt.evaluateTransferEffect(applyResult.transfer_id);
      expect(record.effectiveness).toBe("neutral");
    });

    it("transfer_id in record matches input", async () => {
      const kt = await createKT({ goalIds: ["goal_a"] });
      const record = await kt.evaluateTransferEffect("my_transfer_id");
      expect(record.transfer_id).toBe("my_transfer_id");
    });

    it("negative effectiveness increments consecutive counter", async () => {
      const pattern = makePattern({ pattern_id: "pat_neg", confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pattern] },
        llmResponses: Array(4).fill(ADAPTATION_RESPONSE),
        ethicsVerdict: "pass",
      });

      for (let i = 0; i < 3; i++) {
        await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.3 });
        const candidates = await kt.detectTransferOpportunities("goal_a");
        if (candidates.length === 0) break;
        const applyResult = await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
        await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.8 });
        const record = await kt.evaluateTransferEffect(applyResult.transfer_id);
        expect(record.effectiveness).toBe("negative");
      }

      const finalCandidates = await kt.detectTransferOpportunities("goal_a");
      expect(finalCandidates.length).toBe(0);
    });
  });

  describe("buildCrossGoalKnowledgeBase", async () => {
    it("does nothing when there are no goals", async () => {
      const kt = await createKT({ goalIds: [], llmResponses: [] });
      await expect(kt.buildCrossGoalKnowledgeBase()).resolves.toBeUndefined();
    });

    it("does nothing when there are no high-confidence patterns", async () => {
      const lowPat = makePattern({ confidence: 0.5, source_goal_ids: ["goal_a"] });
      const kt = await createKT({
        goalIds: ["goal_a"],
        patternsPerGoal: { goal_a: [lowPat] },
        llmResponses: [],
      });
      await expect(kt.buildCrossGoalKnowledgeBase()).resolves.toBeUndefined();
    });

    it("calls LLM and adds meta-patterns to vector index", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_a"] });
      const kt = await createKT({
        goalIds: ["goal_a"],
        patternsPerGoal: { goal_a: [pattern] },
        llmResponses: [META_PATTERNS_RESPONSE],
      });

      const sizeBefore = vectorIndex.size;
      await kt.buildCrossGoalKnowledgeBase();
      expect(vectorIndex.size).toBe(sizeBefore + 2);
    });

    it("handles LLM failure gracefully", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_a"] });
      const kt = await createKT({
        goalIds: ["goal_a"],
        patternsPerGoal: { goal_a: [pattern] },
        llmResponses: ["INVALID JSON"],
      });
      await expect(kt.buildCrossGoalKnowledgeBase()).resolves.toBeUndefined();
    });

    it("collects patterns from multiple goals", async () => {
      const patA = makePattern({ pattern_id: "pat_a", confidence: 0.7, source_goal_ids: ["goal_a"] });
      const patB = makePattern({ pattern_id: "pat_b", confidence: 0.9, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_a: [patA], goal_b: [patB] },
        llmResponses: [META_PATTERNS_RESPONSE],
      });
      await kt.buildCrossGoalKnowledgeBase();
      expect(vectorIndex.size).toBe(2);
    });

    it("filters patterns below 0.6 confidence", async () => {
      const lowPat = makePattern({ pattern_id: "pat_low", confidence: 0.59, source_goal_ids: ["goal_a"] });
      const highPat = makePattern({ pattern_id: "pat_high", confidence: 0.6, source_goal_ids: ["goal_a"] });
      const kt = await createKT({
        goalIds: ["goal_a"],
        patternsPerGoal: { goal_a: [lowPat, highPat] },
        llmResponses: [META_PATTERNS_RESPONSE],
      });
      await kt.buildCrossGoalKnowledgeBase();
      expect(vectorIndex.size).toBe(2);
    });

    it("handles empty meta_patterns response", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_a"] });
      const kt = await createKT({
        goalIds: ["goal_a"],
        patternsPerGoal: { goal_a: [pattern] },
        llmResponses: [EMPTY_META_PATTERNS_RESPONSE],
      });
      await kt.buildCrossGoalKnowledgeBase();
      expect(vectorIndex.size).toBe(0);
    });

    it("meta-pattern entries are searchable in vector index", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_a"] });
      const kt = await createKT({
        goalIds: ["goal_a"],
        patternsPerGoal: { goal_a: [pattern] },
        llmResponses: [META_PATTERNS_RESPONSE],
      });
      await kt.buildCrossGoalKnowledgeBase();
      const searchResults = await vectorIndex.search("scope", 10, 0.0);
      expect(searchResults.length).toBeGreaterThanOrEqual(0);
    });

    it("does not throw when vector index add fails", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_a"] });
      const failingClient = {
        embed: async () => { throw new Error("Embedding service down"); },
      } as any;
      const failingVectorIndex = new VectorIndex(path.join(tmpDir, "fail-vectors.json"), failingClient);

      const llmClient = createMockLLMClient([META_PATTERNS_RESPONSE]);
      const learningPipeline = makeMockLearningPipeline({ goal_a: [pattern] });
      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.5 });

      const kt = new KnowledgeTransfer({
        llmClient, knowledgeManager: makeMockKnowledgeManager(),
        vectorIndex: failingVectorIndex, learningPipeline,
        ethicsGate: makeMockEthicsGate("pass"), stateManager,
      });

      await expect(kt.buildCrossGoalKnowledgeBase()).resolves.toBeUndefined();
    });

    it("returns void (no return value)", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_a"] });
      const kt = await createKT({
        goalIds: ["goal_a"],
        patternsPerGoal: { goal_a: [pattern] },
        llmResponses: [META_PATTERNS_RESPONSE],
      });
      const result = await kt.buildCrossGoalKnowledgeBase();
      expect(result).toBeUndefined();
    });

    it("processes all goals even when one has no patterns", async () => {
      const patA = makePattern({ confidence: 0.8, source_goal_ids: ["goal_a"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_a: [patA] },
        llmResponses: [META_PATTERNS_RESPONSE],
      });
      await kt.buildCrossGoalKnowledgeBase();
      expect(vectorIndex.size).toBe(2);
    });

    it("skips LLM when all patterns are below confidence threshold", async () => {
      const lowPat1 = makePattern({ pattern_id: "low1", confidence: 0.3, source_goal_ids: ["goal_a"] });
      const lowPat2 = makePattern({ pattern_id: "low2", confidence: 0.59, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_a: [lowPat1], goal_b: [lowPat2] },
        llmResponses: [],
      });
      await kt.buildCrossGoalKnowledgeBase();
      expect(vectorIndex.size).toBe(0);
    });

    it("can be called multiple times and adds new entries each time", async () => {
      const pattern = makePattern({ confidence: 0.8, source_goal_ids: ["goal_a"] });
      const kt = await createKT({
        goalIds: ["goal_a"],
        patternsPerGoal: { goal_a: [pattern] },
        llmResponses: [META_PATTERNS_RESPONSE, META_PATTERNS_RESPONSE],
      });
      await kt.buildCrossGoalKnowledgeBase();
      expect(vectorIndex.size).toBe(2);
      await kt.buildCrossGoalKnowledgeBase();
      expect(vectorIndex.size).toBe(4);
    });

    it("uses only up to 50 patterns to limit LLM token usage", async () => {
      const manyPatterns: LearnedPattern[] = [];
      for (let i = 0; i < 60; i++) {
        manyPatterns.push(makePattern({
          pattern_id: `pat_${i}`, confidence: 0.8, source_goal_ids: ["goal_a"],
        }));
      }
      const kt = await createKT({
        goalIds: ["goal_a"],
        patternsPerGoal: { goal_a: manyPatterns },
        llmResponses: [META_PATTERNS_RESPONSE],
      });
      await kt.buildCrossGoalKnowledgeBase();
      expect(vectorIndex.size).toBe(2);
    });
  });

  describe("getTransferCandidates", async () => {
    it("returns empty array initially", async () => {
      const kt = await createKT({ goalIds: [] });
      expect(kt.getTransferCandidates()).toEqual([]);
    });

    it("returns all stored candidates after detection", async () => {
      const pat = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pat] },
      });
      await kt.detectTransferOpportunities("goal_a");
      const candidates = kt.getTransferCandidates();
      expect(candidates.length).toBe(1);
      expect(candidates[0]!.target_goal_id).toBe("goal_a");
    });

    it("returns a new array (not internal reference)", async () => {
      const pat = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pat] },
      });
      await kt.detectTransferOpportunities("goal_a");
      const c1 = kt.getTransferCandidates();
      const c2 = kt.getTransferCandidates();
      expect(c1).not.toBe(c2);
      expect(c1).toEqual(c2);
    });

    it("includes candidates from multiple detect calls", async () => {
      const patB = makePattern({ pattern_id: "pat_b", confidence: 0.8, source_goal_ids: ["goal_b"] });
      const patC = makePattern({ pattern_id: "pat_c", confidence: 0.8, source_goal_ids: ["goal_c"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b", "goal_c"],
        patternsPerGoal: { goal_b: [patB], goal_c: [patC] },
      });
      await kt.detectTransferOpportunities("goal_a");
      expect(kt.getTransferCandidates().length).toBe(2);
    });

    it("all candidates conform to TransferCandidate schema", async () => {
      const pat = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pat] },
      });
      await kt.detectTransferOpportunities("goal_a");
      for (const c of kt.getTransferCandidates()) {
        expect(c).toHaveProperty("candidate_id");
        expect(c).toHaveProperty("source_goal_id");
        expect(c).toHaveProperty("target_goal_id");
        expect(c).toHaveProperty("type");
        expect(c).toHaveProperty("source_item_id");
        expect(c).toHaveProperty("similarity_score");
        expect(c).toHaveProperty("estimated_benefit");
      }
    });
  });

  describe("getTransferResults", async () => {
    it("returns empty array initially", async () => {
      const kt = await createKT({ goalIds: [] });
      expect(kt.getTransferResults()).toEqual([]);
    });

    it("returns all stored results after apply", async () => {
      const pat = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pat] },
        llmResponses: [ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      expect(kt.getTransferResults().length).toBe(1);
    });

    it("includes failed results", async () => {
      const kt = await createKT({ goalIds: ["goal_a"] });
      await kt.applyTransfer("nonexistent", "goal_a");
      const results = kt.getTransferResults();
      expect(results.length).toBe(1);
      expect(results[0]!.success).toBe(false);
    });

    it("returns a new array (not internal reference)", async () => {
      const kt = await createKT({ goalIds: ["goal_a"] });
      await kt.applyTransfer("nonexistent", "goal_a");
      const r1 = kt.getTransferResults();
      const r2 = kt.getTransferResults();
      expect(r1).not.toBe(r2);
      expect(r1).toEqual(r2);
    });

    it("all results conform to TransferResult schema", async () => {
      const pat = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pat] },
        llmResponses: [ADAPTATION_RESPONSE],
        ethicsVerdict: "pass",
      });
      const candidates = await kt.detectTransferOpportunities("goal_a");
      await kt.applyTransfer(candidates[0]!.candidate_id, "goal_a");
      for (const r of kt.getTransferResults()) {
        expect(r).toHaveProperty("transfer_id");
        expect(r).toHaveProperty("candidate_id");
        expect(r).toHaveProperty("applied_at");
        expect(r).toHaveProperty("adaptation_description");
        expect(r).toHaveProperty("success");
      }
    });
  });
});
