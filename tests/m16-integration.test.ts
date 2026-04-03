import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { StateManager } from "../src/state/state-manager.js";
import { KnowledgeTransfer } from "../src/knowledge/transfer/knowledge-transfer.js";
import { TransferTrustManager } from "../src/knowledge/transfer/transfer-trust.js";
import { VectorIndex } from "../src/knowledge/vector-index.js";
import { MockEmbeddingClient } from "../src/knowledge/embedding-client.js";
import { CheckpointManager } from "../src/execution/checkpoint-manager.js";
import { ReportingEngine } from "../src/reporting/reporting-engine.js";
import {
  allocateBudget,
  selectWithinBudget,
  trimToBudget,
  type BudgetAllocation,
} from "../src/execution/context/context-budget.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import type { LearnedPattern } from "../src/types/learning.js";

// ─── Helpers ───

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m16-int-"));
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

function makeMockKnowledgeManager() { return {} as never; }

function makeMockEthicsGate(verdict: "pass" | "flag" | "reject" = "pass") {
  return {
    check: vi.fn(async () => ({ verdict, reasoning: "ok", confidence: 0.9 })),
  } as unknown as import("../src/traits/ethics-gate.js").EthicsGate;
}

function makeMockLearningPipeline(patternsPerGoal: Record<string, LearnedPattern[]> = {}) {
  return {
    getPatterns: vi.fn((goalId: string) => patternsPerGoal[goalId] ?? []),
  } as unknown as import("../src/knowledge/learning/learning-pipeline.js").LearningPipeline;
}

function makeStoreBacked() {
  const stored: Record<string, unknown> = {};
  const stateManager = {
    readRaw: vi.fn(async (p: string) => stored[p] ?? null),
    writeRaw: vi.fn(async (p: string, data: unknown) => { stored[p] = data; }),
    getBaseDir: vi.fn(() => "/tmp/test"),
  } as unknown as StateManager;
  return { stored, stateManager };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const ADAPTATION_RESPONSE = JSON.stringify({
  adaptation_description: "Adapted pattern for target context",
  adapted_content: "Reduce scope when blocked in target domain",
  success: true,
});

const META_PATTERN_RESPONSE = JSON.stringify({
  meta_patterns: [
    {
      description: "Break tasks into smaller units when facing blockers",
      applicable_domains: ["testing", "development"],
      source_pattern_ids: ["pat_1"],
    },
  ],
});

// ─── Flow 1: Transfer Detection → Scoring → Apply → Evaluate → Trust Update ───

describe("Flow 1: KnowledgeTransfer end-to-end pipeline", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let vectorIndex: VectorIndex;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stateManager = new StateManager(tmpDir);
    vectorIndex = new VectorIndex(
      path.join(tmpDir, "vectors.json"),
      new MockEmbeddingClient()
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects candidates, applies transfer, evaluates effect, and updates trust", async () => {
    const goalA = "goal_a";
    const goalB = "goal_b";

    // Seed goals in stateManager so listGoalIds works
    await stateManager.writeRaw(`goals/${goalA}/state.json`, { gap: 0.8 });
    await stateManager.writeRaw(`goals/${goalB}/state.json`, { gap: 0.4 });

    const pattern = makePattern({
      pattern_id: "pat_transfer",
      confidence: 0.85,
      source_goal_ids: [goalA],
      applicable_domains: ["testing"],
    });

    const llmClient = createMockLLMClient([ADAPTATION_RESPONSE]);
    const learningPipeline = makeMockLearningPipeline({ [goalA]: [pattern] });
    const ethicsGate = makeMockEthicsGate("pass");
    const transferTrust = new TransferTrustManager({ stateManager });

    const kt = new KnowledgeTransfer({
      llmClient,
      knowledgeManager: makeMockKnowledgeManager() as never,
      vectorIndex,
      learningPipeline,
      ethicsGate,
      stateManager,
      transferTrust,
    });

    const candidates = await kt.detectTransferOpportunities(goalB);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0]!.source_goal_id).toBe(goalA);
    expect(candidates[0]!.target_goal_id).toBe(goalB);
    expect(candidates[0]!.candidate_id).toMatch(/^tc_/);

    const result = await kt.applyTransfer(candidates[0]!.candidate_id, goalB);
    expect(result.success).toBe(true);
    expect(result.transfer_id).toMatch(/^tr_/);

    const record = await kt.evaluateTransferEffect(result.transfer_id);
    expect(record.transfer_id).toBe(result.transfer_id);
    expect(["positive", "neutral", "negative"]).toContain(record.effectiveness);
    expect(typeof record.gap_delta_before).toBe("number");
    expect(typeof record.gap_delta_after).toBe("number");

    const stats = kt.getTransferSuccessRate();
    expect(stats.total).toBe(1);
    expect(stats.positive + stats.neutral + stats.negative).toBe(1);
  });

  it("returns empty candidates when source goal has no patterns", async () => {
    await stateManager.writeRaw(`goals/goal_a/state.json`, { gap: 0.5 });
    await stateManager.writeRaw(`goals/goal_b/state.json`, { gap: 0.5 });

    const kt = new KnowledgeTransfer({
      llmClient: createMockLLMClient([]),
      knowledgeManager: makeMockKnowledgeManager() as never,
      vectorIndex,
      learningPipeline: makeMockLearningPipeline({}),
      ethicsGate: makeMockEthicsGate("pass"),
      stateManager,
    });

    const candidates = await kt.detectTransferOpportunities("goal_b");
    expect(candidates).toEqual([]);
  });
});

// ─── Flow 2: Checkpoint Save → Load → Agent Handoff ───

describe("Flow 2: CheckpointManager save/load/adapt/GC", () => {
  const GOAL_ID = "goal-cp-test";
  const TASK_ID = "task-001";

  it("saves and loads checkpoint, adapts for different agent, GC removes old ones", async () => {
    const { stored, stateManager } = makeStoreBacked();
    const logger = makeLogger();
    const llmClient = { chat: vi.fn(async () => ({ content: "adapted context for agent-B" })) };
    const manager = new CheckpointManager({ stateManager, llmClient, logger });

    const checkpoint = await manager.saveCheckpoint({
      goalId: GOAL_ID,
      taskId: TASK_ID,
      agentId: "agent-A",
      sessionContextSnapshot: "context data...",
      intermediateResults: ["result1"],
    });

    expect(checkpoint.goal_id).toBe(GOAL_ID);
    expect(checkpoint.agent_id).toBe("agent-A");
    expect(checkpoint.intermediate_results).toEqual(["result1"]);

    const loaded = await manager.loadCheckpoint(GOAL_ID);
    expect(loaded).not.toBeNull();
    expect(loaded?.checkpoint_id).toBe(checkpoint.checkpoint_id);
    expect(loaded?.session_context_snapshot).toBe("context data...");

    const adapted = await manager.loadAndAdaptCheckpoint(GOAL_ID, "agent-B");
    expect(adapted).not.toBeNull();
    expect(adapted?.wasAdapted).toBe(true);
    expect(adapted?.adaptedContext).toBe("adapted context for agent-B");
    expect(llmClient.chat).toHaveBeenCalledTimes(1);

    // same agent — no adaptation
    const notAdapted = await manager.loadAndAdaptCheckpoint(GOAL_ID, "agent-A");
    expect(notAdapted?.wasAdapted).toBe(false);
    expect(llmClient.chat).toHaveBeenCalledTimes(1);

    // GC removes entries older than 7 days
    const oldAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const indexKey = `checkpoints/${GOAL_ID}/index.json`;
    type CpEntry = { checkpoint_id: string; task_id: string; agent_id: string; created_at: string };
    const currentIndex = stored[indexKey] as { goal_id: string; checkpoints: CpEntry[] };
    const oldId = "old-checkpoint-id";
    currentIndex.checkpoints.push({ checkpoint_id: oldId, task_id: TASK_ID, agent_id: "agent-A", created_at: oldAt });
    stored[indexKey] = currentIndex;

    const gcCount = await manager.garbageCollect(GOAL_ID, 7);
    expect(gcCount).toBe(1);

    const ids = (stored[indexKey] as typeof currentIndex).checkpoints.map((c) => c.checkpoint_id);
    expect(ids).not.toContain(oldId);
    expect(ids).toContain(checkpoint.checkpoint_id);
  });
});

// ─── Flow 3: Progressive Disclosure Budget Allocation ───

describe("Flow 3: context-budget progressive disclosure", () => {
  it("allocates correct proportions from a 50000 token budget", () => {
    const alloc = allocateBudget(50_000);
    expect(alloc.goalDefinition).toBe(10_000);     // 20%
    expect(alloc.observations).toBe(15_000);       // 30%
    expect(alloc.knowledge).toBe(15_000);          // 30%
    expect(alloc.transferKnowledge).toBe(7_500);   // 15%
    expect(alloc.meta).toBe(2_500);                // 5%
  });

  it("selects candidates within 7500 token budget", () => {
    // Each "a"*40 = 40 chars = 10 tokens; "b"*200 = 200 chars = 50 tokens
    const candidates = [
      { text: "a".repeat(40), similarity: 0.95 },  // 10 tokens
      { text: "a".repeat(40), similarity: 0.90 },  // 10 tokens
      { text: "b".repeat(200), similarity: 0.85 }, // 50 tokens
    ];
    const selected = selectWithinBudget(candidates, 25);
    expect(selected.length).toBe(2); // only the two 10-token entries fit in 25
    expect(selected.every((c) => c.text.startsWith("a"))).toBe(true);
  });

  it("trims lowest-priority (meta) first when over budget", () => {
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
      meta: 15, // 10 over: meta fully trimmed (5 off), then transferKnowledge loses 5
    };
    const result = trimToBudget(alloc, usage, 100);
    expect(result.meta).toBe(0);
    expect(result.transferKnowledge).toBe(10);
    expect(result.knowledge).toBe(30); // untouched
  });
});

// ─── Flow 4: Incremental Meta-Pattern Update ───

describe("Flow 4: updateMetaPatternsIncremental", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("processes new patterns only and updates lastAggregatedAt", async () => {
    const oldAt = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    const newAt = new Date().toISOString();

    const oldPattern = makePattern({ pattern_id: "old_pat", confidence: 0.8, created_at: oldAt, source_goal_ids: ["goal_a"] });
    const newPattern = makePattern({ pattern_id: "new_pat", confidence: 0.9, created_at: newAt, source_goal_ids: ["goal_a"] });

    // Seed goal state
    await stateManager.writeRaw(`goals/goal_a/state.json`, { gap: 0.5 });
    // Set last_aggregated_at to just before newPattern
    const lastAggAt = new Date(Date.now() - 30_000).toISOString(); // 30s ago
    await stateManager.writeRaw("meta-patterns/last_aggregated_at.json", { ts: lastAggAt });

    const vectorIndex = new VectorIndex(
      path.join(tmpDir, "vectors.json"),
      new MockEmbeddingClient()
    );

    const learningPipeline = makeMockLearningPipeline({ goal_a: [oldPattern, newPattern] });
    const llmClient = createMockLLMClient([META_PATTERN_RESPONSE]);

    const kt = new KnowledgeTransfer({
      llmClient,
      knowledgeManager: makeMockKnowledgeManager() as never,
      vectorIndex,
      learningPipeline,
      ethicsGate: makeMockEthicsGate("pass"),
      stateManager,
    });

    const registered = await kt.updateMetaPatternsIncremental();

    // LLM should have been called with only the new (high-confidence) pattern
    expect(llmClient.callCount).toBe(1);

    // lastAggregatedAt should now be updated
    const saved = await stateManager.readRaw("meta-patterns/last_aggregated_at.json") as { ts: string } | null;
    expect(saved?.ts).toBeTruthy();
    expect(saved!.ts > lastAggAt).toBe(true);

    // Returns number of registered meta-patterns
    expect(typeof registered).toBe("number");
  });

  it("processes all patterns when no prior aggregation timestamp exists", async () => {
    const pattern = makePattern({ pattern_id: "p1", confidence: 0.75, source_goal_ids: ["goal_x"] });
    await stateManager.writeRaw(`goals/goal_x/state.json`, { gap: 0.3 });

    const vectorIndex = new VectorIndex(
      path.join(tmpDir, "vec2.json"),
      new MockEmbeddingClient()
    );
    const llmClient = createMockLLMClient([META_PATTERN_RESPONSE]);
    const learningPipeline = makeMockLearningPipeline({ goal_x: [pattern] });

    const kt = new KnowledgeTransfer({
      llmClient,
      knowledgeManager: makeMockKnowledgeManager() as never,
      vectorIndex,
      learningPipeline,
      ethicsGate: makeMockEthicsGate("pass"),
      stateManager,
    });

    // No last_aggregated_at set — all patterns should be processed
    const registered = await kt.updateMetaPatternsIncremental();
    expect(llmClient.callCount).toBe(1);
    expect(typeof registered).toBe("number");
  });
});

// ─── Flow 5: Transfer Effect Report Generation ───

describe("Flow 5: ReportingEngine.generateTransferEffectReport", () => {
  it("generates report with transfer stats section when knowledgeTransfer is wired", async () => {
    const { stateManager } = makeStoreBacked();
    const engine = new ReportingEngine(stateManager);

    const mockKT = {
      getAppliedTransferCount: vi.fn(() => 3),
      getTransferSuccessRate: vi.fn(() => ({
        total: 5,
        positive: 3,
        negative: 1,
        neutral: 1,
        rate: 0.6,
      })),
      getEffectivenessRecords: vi.fn(() => [
        { transfer_id: "tr_1", gap_delta_before: 0.8, gap_delta_after: 0.5, effectiveness: "positive", evaluated_at: new Date().toISOString() },
        { transfer_id: "tr_2", gap_delta_before: 0.6, gap_delta_after: 0.6, effectiveness: "neutral", evaluated_at: new Date().toISOString() },
      ]),
    };

    const mockTT = {
      getAllScores: vi.fn(async () => [
        { domain_pair: "testing::dev", trust_score: 0.75, success_count: 3, failure_count: 1, neutral_count: 0 },
      ]),
    };

    engine.setKnowledgeTransfer(mockKT);
    engine.setTransferTrust(mockTT);

    const report = await engine.generateTransferEffectReport();

    expect(report.title).toBe("Transfer Effect Summary");
    expect(report.content).toContain("Transfer Statistics");
    expect(report.content).toContain("Applied transfers: 3");
    expect(report.content).toContain("60.0%");
    expect(report.content).toContain("Gap Reduction from Transfers");
    expect(report.content).toContain("Domain Pair Trust Scores");
    expect(report.content).toContain("testing::dev");
  });

  it("generates fallback report when no knowledgeTransfer is set", async () => {
    const { stateManager } = makeStoreBacked();
    const engine = new ReportingEngine(stateManager);

    const report = await engine.generateTransferEffectReport();

    expect(report.title).toBe("Transfer Effect Summary");
    expect(report.content).toContain("No transfer data available");
  });
});
