import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KnowledgeTransfer } from "../src/knowledge/transfer/knowledge-transfer.js";
import { LearningPipeline } from "../src/knowledge/learning/learning-pipeline.js";
import { ReportingEngine } from "../src/reporting/reporting-engine.js";
import { StateManager } from "../src/state/state-manager.js";
import { VectorIndex } from "../src/knowledge/vector-index.js";
import { MockEmbeddingClient } from "../src/knowledge/embedding-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import type { LearnedPattern } from "../src/types/learning.js";

// ─── Helpers ───

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kt-incremental-test-"));
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
  return {} as unknown as ReturnType<typeof import("../src/knowledge/knowledge-manager.js").KnowledgeManager.prototype.constructor>;
}

function makeMockEthicsGate() {
  return {
    check: async () => ({ verdict: "pass" as const, reasoning: "Approved", confidence: 0.9 }),
  } as never;
}

// Meta-pattern LLM response fixture
const META_PATTERN_RESPONSE = JSON.stringify({
  meta_patterns: [
    {
      description: "Reduce scope incrementally when progress stalls",
      applicable_domains: ["testing", "development"],
      source_pattern_ids: ["pat_2"],
    },
  ],
});

// ─── describe suite ───

describe("M16.6: Incremental Meta-Pattern Update + Transfer Effect Report", () => {

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

  // ─── Build KnowledgeTransfer with inline mock learningPipeline ───

  function makeKT(opts: {
    llmResponses?: string[];
    learningPipelinePatterns?: LearnedPattern[];
    useVectorIndex?: boolean;
  } = {}): KnowledgeTransfer {
    const llmClient = createMockLLMClient(opts.llmResponses ?? []);
    const learningPipeline = {
      getPatterns: vi.fn().mockResolvedValue(opts.learningPipelinePatterns ?? []),
    } as never;

    return new KnowledgeTransfer({
      llmClient,
      knowledgeManager: makeMockKnowledgeManager(),
      vectorIndex: opts.useVectorIndex === false ? null : vectorIndex,
      learningPipeline,
      ethicsGate: makeMockEthicsGate(),
      stateManager,
    });
  }

  // ─── KnowledgeTransfer.updateMetaPatternsIncremental ───

  describe("KnowledgeTransfer.updateMetaPatternsIncremental", () => {

    it("processes only patterns created after lastAggregatedAt", async () => {
      // pattern1: old (before last_aggregated_at), confidence 0.8
      const pattern1 = makePattern({
        pattern_id: "pat_1",
        created_at: "2026-03-10T00:00:00.000Z",
        confidence: 0.8,
      });
      // pattern2: new (after last_aggregated_at), confidence 0.7 — should be processed
      const pattern2 = makePattern({
        pattern_id: "pat_2",
        created_at: "2026-03-18T00:00:00.000Z",
        confidence: 0.7,
      });
      // pattern3: new but low confidence — filtered out
      const pattern3 = makePattern({
        pattern_id: "pat_3",
        created_at: "2026-03-18T01:00:00.000Z",
        confidence: 0.4,
      });

      // Persist lastAggregatedAt as 2026-03-15
      await stateManager.writeRaw("meta-patterns/last_aggregated_at.json", {
        ts: "2026-03-15T00:00:00.000Z",
      });
      // Also write goal so listGoalIds returns something
      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.5 });

      const llmClient = createMockLLMClient([META_PATTERN_RESPONSE]);
      const getPatterns = vi.fn().mockResolvedValue([pattern1, pattern2, pattern3]);
      const learningPipeline = { getPatterns } as never;

      const kt = new KnowledgeTransfer({
        llmClient,
        knowledgeManager: makeMockKnowledgeManager(),
        vectorIndex,
        learningPipeline,
        ethicsGate: makeMockEthicsGate(),
        stateManager,
      });

      const result = await kt.updateMetaPatternsIncremental();

      // Only pattern2 (new + high-confidence) should reach LLM
      expect(llmClient.callCount).toBe(1);
      // LLM was called with content containing pattern2 description but not pattern1
      // Returns 1 registered meta-pattern
      expect(result).toBe(1);

      // Verify lastAggregatedAt was persisted
      const persisted = await stateManager.readRaw("meta-patterns/last_aggregated_at.json") as { ts: string } | null;
      expect(persisted).not.toBeNull();
      expect(persisted!.ts).not.toBe("2026-03-15T00:00:00.000Z");
    });

    it("processes all patterns when no lastAggregatedAt exists", async () => {
      const pat1 = makePattern({ pattern_id: "pat_a", confidence: 0.75, created_at: "2026-01-01T00:00:00.000Z" });
      const pat2 = makePattern({ pattern_id: "pat_b", confidence: 0.65, created_at: "2026-02-01T00:00:00.000Z" });

      await stateManager.writeRaw("goals/goal_x/state.json", { gap: 0.3 });

      const llmClient = createMockLLMClient([META_PATTERN_RESPONSE]);
      const learningPipeline = { getPatterns: vi.fn().mockResolvedValue([pat1, pat2]) } as never;

      const kt = new KnowledgeTransfer({
        llmClient,
        knowledgeManager: makeMockKnowledgeManager(),
        vectorIndex,
        learningPipeline,
        ethicsGate: makeMockEthicsGate(),
        stateManager,
      });

      // No readRaw data for last_aggregated_at (never persisted)
      const result = await kt.updateMetaPatternsIncremental();

      // Both patterns pass (no timestamp filter) — LLM should be called
      expect(llmClient.callCount).toBe(1);
      expect(result).toBe(1);
    });

    it("returns 0 when no new high-confidence patterns", async () => {
      // All patterns older than lastAggregatedAt
      const oldPattern = makePattern({
        pattern_id: "pat_old",
        created_at: "2026-03-01T00:00:00.000Z",
        confidence: 0.9,
      });
      // Low-confidence new pattern
      const lowConf = makePattern({
        pattern_id: "pat_low",
        created_at: "2026-03-18T00:00:00.000Z",
        confidence: 0.3,
      });

      await stateManager.writeRaw("meta-patterns/last_aggregated_at.json", {
        ts: "2026-03-15T00:00:00.000Z",
      });
      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.5 });

      const llmClient = createMockLLMClient([]);
      const learningPipeline = { getPatterns: vi.fn().mockResolvedValue([oldPattern, lowConf]) } as never;

      const kt = new KnowledgeTransfer({
        llmClient,
        knowledgeManager: makeMockKnowledgeManager(),
        vectorIndex,
        learningPipeline,
        ethicsGate: makeMockEthicsGate(),
        stateManager,
      });

      const result = await kt.updateMetaPatternsIncremental();

      // LLM must NOT be called (no patterns to process)
      expect(llmClient.callCount).toBe(0);
      expect(result).toBe(0);
    });

    it("handles LLM parse failure gracefully and returns 0", async () => {
      const newPat = makePattern({
        pattern_id: "pat_new",
        created_at: "2026-03-18T00:00:00.000Z",
        confidence: 0.8,
      });

      await stateManager.writeRaw("meta-patterns/last_aggregated_at.json", {
        ts: "2026-03-15T00:00:00.000Z",
      });
      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.5 });

      // LLM returns non-parseable content
      const llmClient = createMockLLMClient(["this is not json at all"]);
      const learningPipeline = { getPatterns: vi.fn().mockResolvedValue([newPat]) } as never;

      const kt = new KnowledgeTransfer({
        llmClient,
        knowledgeManager: makeMockKnowledgeManager(),
        vectorIndex,
        learningPipeline,
        ethicsGate: makeMockEthicsGate(),
        stateManager,
      });

      // Should not throw
      await expect(kt.updateMetaPatternsIncremental()).resolves.toBe(0);

      // lastAggregatedAt should still be updated even on LLM failure
      const persisted = await stateManager.readRaw("meta-patterns/last_aggregated_at.json") as { ts: string } | null;
      expect(persisted).not.toBeNull();
      expect(persisted!.ts).not.toBe("2026-03-15T00:00:00.000Z");
    });

    it("returns 0 immediately when vectorIndex is null (no registration possible)", async () => {
      const newPat = makePattern({
        pattern_id: "pat_nvec",
        created_at: "2026-03-18T00:00:00.000Z",
        confidence: 0.8,
      });

      await stateManager.writeRaw("goals/goal_a/state.json", { gap: 0.5 });

      const llmClient = createMockLLMClient([META_PATTERN_RESPONSE]);
      const learningPipeline = { getPatterns: vi.fn().mockResolvedValue([newPat]) } as never;

      const kt = new KnowledgeTransfer({
        llmClient,
        knowledgeManager: makeMockKnowledgeManager(),
        vectorIndex: null,
        learningPipeline,
        ethicsGate: makeMockEthicsGate(),
        stateManager,
      });

      // LLM is called but nothing is registered (no vectorIndex)
      const result = await kt.updateMetaPatternsIncremental();
      expect(result).toBe(0);
    });

  });

  // ─── LearningPipeline knowledgeTransfer hook ───

  describe("LearningPipeline knowledgeTransfer hook", () => {

    it("setKnowledgeTransfer stores reference (setter works)", () => {
      const llmClient = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llmClient, null, stateManager);

      const mockKT = { updateMetaPatternsIncremental: vi.fn().mockResolvedValue(0) };
      // Should not throw
      expect(() => pipeline.setKnowledgeTransfer(mockKT)).not.toThrow();
    });

    it("calls updateMetaPatternsIncremental after analyzeLogs produces patterns", async () => {
      // Provide LLM responses: 1 for triplet extraction, 1 for patternization
      const tripletsResponse = JSON.stringify({
        triplets: [
          {
            state_context: "Goal is stalling due to broad scope",
            action_taken: "Reduced task scope to a single sub-step",
            outcome: "Task completed successfully, gap reduced",
            gap_delta: -0.3,
          },
        ],
      });
      const patternsResponse = JSON.stringify({
        patterns: [
          {
            description: "Reduce task scope to a single step when blocked",
            pattern_type: "scope_sizing",
            action_group: "scope_reduction",
            applicable_domains: ["testing"],
            occurrence_count: 3,
            consistent_count: 3,
            total_count: 4,
            is_specific: true,
          },
        ],
      });

      const llmClient = createMockLLMClient([tripletsResponse, patternsResponse]);
      const pipeline = new LearningPipeline(llmClient, null, stateManager);

      const mockKT = { updateMetaPatternsIncremental: vi.fn().mockResolvedValue(1) };
      pipeline.setKnowledgeTransfer(mockKT);

      // Write logs so analyzeLogs has something to process
      await stateManager.writeRaw("learning/goal_x_logs.json", [
        { loop: 1, action: "reduced scope", result: "success" },
      ]);

      const trigger = {
        type: "periodic_review" as const,
        goal_id: "goal_x",
        context: "periodic review",
        timestamp: new Date().toISOString(),
      };

      const patterns = await pipeline.analyzeLogs(trigger);

      // New patterns were produced, so hook should have fired
      expect(patterns.length).toBeGreaterThan(0);
      expect(mockKT.updateMetaPatternsIncremental).toHaveBeenCalledOnce();
    });

    it("does not call updateMetaPatternsIncremental when analyzeLogs produces no patterns", async () => {
      const llmClient = createMockLLMClient([]);
      const pipeline = new LearningPipeline(llmClient, null, stateManager);

      const mockKT = { updateMetaPatternsIncremental: vi.fn().mockResolvedValue(0) };
      pipeline.setKnowledgeTransfer(mockKT);

      // No logs file — analyzeLogs returns [] immediately
      const trigger = {
        type: "periodic_review" as const,
        goal_id: "goal_no_logs",
        context: "periodic review",
        timestamp: new Date().toISOString(),
      };

      const patterns = await pipeline.analyzeLogs(trigger);
      expect(patterns).toHaveLength(0);
      expect(mockKT.updateMetaPatternsIncremental).not.toHaveBeenCalled();
    });

  });

  // ─── ReportingEngine.generateTransferEffectReport ───

  describe("ReportingEngine.generateTransferEffectReport", () => {

    it("generates report with transfer statistics", async () => {
      const engine = new ReportingEngine(stateManager);

      engine.setKnowledgeTransfer({
        getAppliedTransferCount: () => 5,
        getTransferSuccessRate: () => ({
          total: 10,
          positive: 7,
          negative: 2,
          neutral: 1,
          rate: 0.7,
        }),
        getEffectivenessRecords: () => [
          {
            transfer_id: "tr_1",
            gap_delta_before: 0.5,
            gap_delta_after: 0.3,
            effectiveness: "positive",
            evaluated_at: new Date().toISOString(),
          },
          {
            transfer_id: "tr_2",
            gap_delta_before: 0.4,
            gap_delta_after: 0.35,
            effectiveness: "neutral",
            evaluated_at: new Date().toISOString(),
          },
        ],
      });

      engine.setTransferTrust({
        getAllScores: async () => [
          {
            domain_pair: "web:api",
            trust_score: 0.8,
            success_count: 7,
            failure_count: 1,
            neutral_count: 2,
          },
        ],
      });

      const report = await engine.generateTransferEffectReport();

      expect(report.content).toContain("Applied transfers: 5");
      expect(report.content).toContain("70.0%");
      expect(report.content).toContain("web:api");
      expect(report.title).toBe("Transfer Effect Summary");
    });

    it("generates report without transferTrust (no domain pair section)", async () => {
      const engine = new ReportingEngine(stateManager);

      engine.setKnowledgeTransfer({
        getAppliedTransferCount: () => 3,
        getTransferSuccessRate: () => ({
          total: 3,
          positive: 2,
          negative: 1,
          neutral: 0,
          rate: 0.6667,
        }),
        getEffectivenessRecords: () => [],
      });

      // No transferTrust set

      const report = await engine.generateTransferEffectReport();

      expect(report.content).toContain("Applied transfers: 3");
      // Domain pair section should not appear
      expect(report.content).not.toContain("Domain Pair Trust Scores");
    });

    it("generates report without knowledgeTransfer (fallback message)", async () => {
      const engine = new ReportingEngine(stateManager);

      // Neither knowledgeTransfer nor transferTrust set
      const report = await engine.generateTransferEffectReport();

      expect(report.content).toContain("No transfer data available");
    });

    it("report has expected report_type and goal_id", async () => {
      const engine = new ReportingEngine(stateManager);

      const report = await engine.generateTransferEffectReport();

      expect(report.goal_id).toBe("cross-goal");
      expect(report.report_type).toBe("execution_summary");
      expect(report.id).toMatch(/^report_transfer_/);
    });

    it("includes gap reduction stats when effectiveness records exist", async () => {
      const engine = new ReportingEngine(stateManager);

      engine.setKnowledgeTransfer({
        getAppliedTransferCount: () => 2,
        getTransferSuccessRate: () => ({
          total: 2,
          positive: 2,
          negative: 0,
          neutral: 0,
          rate: 1.0,
        }),
        getEffectivenessRecords: () => [
          {
            transfer_id: "tr_a",
            gap_delta_before: 0.6,
            gap_delta_after: 0.2,
            effectiveness: "positive",
            evaluated_at: new Date().toISOString(),
          },
        ],
      });

      const report = await engine.generateTransferEffectReport();

      expect(report.content).toContain("Gap Reduction from Transfers");
      expect(report.content).toContain("100.0%");
    });

  });

});
