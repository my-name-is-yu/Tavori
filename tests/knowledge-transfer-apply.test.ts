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

const ADAPTATION_FAILURE_RESPONSE = JSON.stringify({
  adaptation_description: "Pattern not applicable to target",
  adapted_content: "",
  success: false,
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
});
