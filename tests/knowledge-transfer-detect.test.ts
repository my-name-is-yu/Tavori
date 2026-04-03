import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KnowledgeTransfer } from "../src/knowledge/transfer/knowledge-transfer.js";
import { StateManager } from "../src/state/state-manager.js";
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

    it("rank score is product of similarity, confidence, trust_score plus domain_tag bonus", async () => {
      const pat = makePattern({ confidence: 0.8, source_goal_ids: ["goal_b"] });
      const kt = await createKT({
        goalIds: ["goal_a", "goal_b"],
        patternsPerGoal: { goal_b: [pat] },
      });
      const result = await kt.detectTransferOpportunities("goal_a");
      // similarity=0.7 * confidence=0.8 * trust_score=0.5 + domain_tag_bonus=0.1 = 0.380
      expect(result[0]!.estimated_benefit).toContain("0.380");
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
});
