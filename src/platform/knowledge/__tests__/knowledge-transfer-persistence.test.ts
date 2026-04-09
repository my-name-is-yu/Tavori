import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KnowledgeTransfer } from "../transfer/knowledge-transfer.js";
import { StateManager } from "../../../base/state/state-manager.js";
import { VectorIndex } from "../vector-index.js";
import { MockEmbeddingClient } from "../embedding-client.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import type { LearnedPattern } from "../../../base/types/learning.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kt-persist-"));
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

function makeMockEthicsGate() {
  return {
    check: async () => ({
      verdict: "pass" as const,
      reasoning: "Approved",
      confidence: 0.9,
    }),
  } as any;
}

function makeMockLearningPipeline(patternsPerGoal: Record<string, LearnedPattern[]>) {
  return {
    getPatterns: (goalId: string) => patternsPerGoal[goalId] ?? [],
  } as any;
}

const ADAPTATION_RESPONSE = JSON.stringify({
  adaptation_description: "Adapted pattern for target context",
  adapted_content: "Reduce scope when blocked in target domain",
  success: true,
});

describe("KnowledgeTransfer snapshot persistence", () => {
  it("restores transfer history from disk in a fresh instance", async () => {
    const tmpDir = makeTmpDir();
    const stateManager1 = new StateManager(tmpDir);
    const vectorIndex1 = new VectorIndex(
      path.join(tmpDir, "vectors.json"),
      new MockEmbeddingClient()
    );
    const pattern = makePattern({
      pattern_id: "pat_snapshot",
      source_goal_ids: ["goal_b"],
      confidence: 0.85,
    });

    await stateManager1.writeRaw("goals/goal_a/state.json", { gap: 0.8 });
    await stateManager1.writeRaw("goals/goal_b/state.json", { gap: 0.4 });

    const kt1 = new KnowledgeTransfer({
      llmClient: createMockLLMClient([ADAPTATION_RESPONSE]),
      knowledgeManager: makeMockKnowledgeManager(),
      vectorIndex: vectorIndex1,
      learningPipeline: makeMockLearningPipeline({ goal_b: [pattern] }),
      ethicsGate: makeMockEthicsGate(),
      stateManager: stateManager1,
    });

    const candidates = await kt1.detectTransferOpportunities("goal_a");
    expect(candidates).toHaveLength(1);

    const applyResult = await kt1.applyTransfer(candidates[0]!.candidate_id, "goal_a");
    await stateManager1.writeRaw("goals/goal_a/state.json", { gap: 0.2 });
    const effectiveness = await kt1.evaluateTransferEffect(applyResult.transfer_id);
    expect(effectiveness.effectiveness).toBe("positive");

    const stateManager2 = new StateManager(tmpDir);
    const vectorIndex2 = new VectorIndex(
      path.join(tmpDir, "vectors.json"),
      new MockEmbeddingClient()
    );
    const kt2 = new KnowledgeTransfer({
      llmClient: createMockLLMClient([]),
      knowledgeManager: makeMockKnowledgeManager(),
      vectorIndex: vectorIndex2,
      learningPipeline: makeMockLearningPipeline({}),
      ethicsGate: makeMockEthicsGate(),
      stateManager: stateManager2,
    });

    const snapshot = await kt2.listTransferSnapshot();
    expect(snapshot.transfers).toHaveLength(1);
    expect(snapshot.results).toHaveLength(1);
    expect(snapshot.effectiveness_records).toHaveLength(1);
    expect(snapshot.transfers[0]!.candidate_id).toBe(candidates[0]!.candidate_id);
    expect(snapshot.results[0]!.transfer_id).toBe(applyResult.transfer_id);
    expect(snapshot.effectiveness_records[0]!.transfer_id).toBe(applyResult.transfer_id);
  });
});
