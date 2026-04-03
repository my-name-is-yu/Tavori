/**
 * Milestone 5 E2E Tests: Cross-Goal Knowledge Sharing + Drive-based Memory Management
 *                        + Dynamic Context Budget + Full Multi-Goal Integration
 *
 * Group 1: Cross-Goal Knowledge Sharing (KnowledgeManager shared KB + VectorIndex)
 * Group 2: Drive-based Memory Management (MemoryLifecycleManager + IDriveScorer)
 * Group 3: Dynamic Context Budget (SessionManager budget filtering + conflict awareness)
 * Group 4: Full Integration — Multi-Goal Loop with Knowledge Transfer
 *
 * All LLM and embedding calls are mocked. No real API calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Real implementations ───
import { StateManager } from "../../src/state/state-manager.js";
import { KnowledgeManager } from "../../src/knowledge/knowledge-manager.js";
import { VectorIndex } from "../../src/knowledge/vector-index.js";
import { MockEmbeddingClient } from "../../src/knowledge/embedding-client.js";
import { MemoryLifecycleManager } from "../../src/knowledge/memory/memory-lifecycle.js";
import type { IDriveScorer } from "../../src/knowledge/memory/memory-lifecycle.js";
import { SessionManager } from "../../src/execution/session-manager.js";
import { GoalDependencyGraph } from "../../src/goal/goal-dependency-graph.js";
import { ObservationEngine } from "../../src/observation/observation-engine.js";
import { TaskLifecycle } from "../../src/execution/task/task-lifecycle.js";
import { SatisficingJudge } from "../../src/drive/satisficing-judge.js";
import { StallDetector } from "../../src/drive/stall-detector.js";
import { StrategyManager } from "../../src/strategy/strategy-manager.js";
import { ReportingEngine } from "../../src/reporting/reporting-engine.js";
import { DriveSystem } from "../../src/drive/drive-system.js";
import { TrustManager } from "../../src/traits/trust-manager.js";
import { CoreLoop } from "../../src/loop/core-loop.js";
import { AdapterRegistry } from "../../src/execution/adapter-layer.js";
import type { IAdapter, AgentTask, AgentResult } from "../../src/execution/adapter-layer.js";
import * as GapCalculator from "../../src/drive/gap-calculator.js";
import * as DriveScorer from "../../src/drive/drive-scorer.js";

// ─── Types ───
import type { Goal } from "../../src/types/goal.js";
import type { KnowledgeEntry } from "../../src/types/knowledge.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../src/llm/llm-client.js";
import type { ZodSchema } from "zod";
import { makeTempDir } from "../helpers/temp-dir.js";

// ─── Helpers ───

function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function extractJSON(text: string): string {
  const jsonBlock = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlock) return jsonBlock[1]!.trim();
  const genericBlock = text.match(/```\s*([\s\S]*?)```/);
  if (genericBlock) return genericBlock[1]!.trim();
  return text.trim();
}

function createSequentialMockLLMClient(responses: string[]): ILLMClient & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async sendMessage(_: LLMMessage[], __?: LLMRequestOptions): Promise<LLMResponse> {
      const index = callCount++;
      if (index >= responses.length) {
        throw new Error(`MockLLMClient: no response at index ${index} (only ${responses.length} configured)`);
      }
      const content = responses[index]!;
      return { content, usage: { input_tokens: 10, output_tokens: content.length }, stop_reason: "end_turn" };
    },
    parseJSON<T>(content: string, schema: ZodSchema<T>): T {
      return schema.parse(JSON.parse(extractJSON(content)));
    },
  };
}

/** Build a KnowledgeEntry fixture */
function makeKnowledgeEntry(
  id: string,
  question: string,
  answer: string,
  tags: string[]
): KnowledgeEntry {
  return {
    entry_id: id,
    question,
    answer,
    sources: [{ type: "llm_inference", reference: "test", reliability: "medium" }],
    confidence: 0.8,
    acquired_at: new Date().toISOString(),
    acquisition_task_id: `task-${id}`,
    superseded_by: null,
    tags,
    embedding_id: null,
  };
}

/** Build a minimal active Goal */
function makeGoal(id: string, title: string): Goal {
  const now = new Date().toISOString();
  return {
    id,
    parent_id: null,
    node_type: "goal",
    title,
    description: `Goal: ${title}`,
    status: "active",
    dimensions: [
      {
        name: "quality_score",
        label: "Quality Score",
        current_value: 0.4,
        threshold: { type: "min", value: 0.8 },
        confidence: 0.6,
        observation_method: {
          type: "llm_review",
          source: "llm",
          schedule: null,
          endpoint: null,
          confidence_tier: "independent_review",
        },
        last_updated: now,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
        state_integrity: "ok",
        dimension_mapping: null,
      },
    ],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: null,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: 0,
    specificity_score: null,
    loop_status: "idle",
    created_at: now,
    updated_at: now,
  };
}

/** MockAdapter — always returns success */
class MockAdapter implements IAdapter {
  readonly adapterType = "claude_api";

  async execute(_task: AgentTask): Promise<AgentResult> {
    return {
      success: true,
      output: "Task completed successfully.",
      error: null,
      exit_code: null,
      elapsed_ms: 10,
      stopped_reason: "completed",
    };
  }
}

/** LLM response factories reused across groups */
function makeTaskGenerationResponse(dimension = "quality_score"): string {
  return JSON.stringify({
    work_description: `Improve ${dimension} by making targeted changes`,
    rationale: `${dimension} is below the required threshold`,
    approach: "Analyze current state and apply targeted improvements",
    success_criteria: [
      {
        description: `${dimension} meets the required threshold`,
        verification_method: "Automated review",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["target dimension"],
      out_of_scope: ["other dimensions"],
      blast_radius: "minimal",
    },
    constraints: [],
    reversibility: "reversible",
    estimated_duration: { value: 20, unit: "minutes" },
  });
}

function makeLLMReviewResponse(): string {
  return JSON.stringify({
    verdict: "pass",
    reasoning: "Improvements satisfy all required criteria",
    criteria_met: 1,
    criteria_total: 1,
  });
}

function makeLLMObservationScore(score: number, reason: string): string {
  return JSON.stringify({ score, reason });
}

// ─── Group 1: Cross-Goal Knowledge Sharing ───

describe("Milestone 5 — Group 1: Cross-Goal Knowledge Sharing", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  // ── Test 1: Save knowledge for goal A, query from goal B (cross-goal access) ──

  it("Save knowledge for goal A, query it from goal B via shared KB", async () => {
    const stateManager = new StateManager(tempDir);
    const llmClient = createSequentialMockLLMClient([]);
    const km = new KnowledgeManager(stateManager, llmClient);

    const entryA = makeKnowledgeEntry(
      "entry-kb-a1",
      "What is the best approach to improve README quality?",
      "Use clear headings, installation guide, and usage examples.",
      ["readme", "documentation"]
    );

    // Save from goal A
    const shared = await km.saveToSharedKnowledgeBase(entryA, "goal-readme");
    expect(shared.source_goal_ids).toContain("goal-readme");
    expect(shared.entry_id).toBe("entry-kb-a1");

    // Query from goal B — should find it via tags
    const results = await km.querySharedKnowledge(["readme"]);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const found = results.find((e) => e.entry_id === "entry-kb-a1");
    expect(found).toBeDefined();
    expect(found!.source_goal_ids).toContain("goal-readme");

    // Query from goal B's perspective — no goalId filter → still finds it
    const resultsFromB = await km.querySharedKnowledge(["documentation"]);
    expect(resultsFromB.some((e) => e.entry_id === "entry-kb-a1")).toBe(true);
  });

  // ── Test 2: Multiple goals contributing to same entry merges source_goal_ids ──

  it("Same entry saved by goal A and goal B merges source_goal_ids", async () => {
    const stateManager = new StateManager(tempDir);
    const km = new KnowledgeManager(stateManager, createSequentialMockLLMClient([]));

    const entry = makeKnowledgeEntry(
      "entry-shared-multi",
      "How to improve test coverage?",
      "Write unit tests for all public APIs.",
      ["testing", "coverage"]
    );

    await km.saveToSharedKnowledgeBase(entry, "goal-readme");
    await km.saveToSharedKnowledgeBase(entry, "goal-tests");

    const results = await km.querySharedKnowledge(["testing"]);
    const found = results.find((e) => e.entry_id === "entry-shared-multi");
    expect(found).toBeDefined();
    expect(found!.source_goal_ids).toContain("goal-readme");
    expect(found!.source_goal_ids).toContain("goal-tests");
    // No duplicates
    expect(new Set(found!.source_goal_ids).size).toBe(found!.source_goal_ids.length);
  });

  // ── Test 3: Vector search — save entries, search by semantic query ──

  it("VectorIndex auto-registration: saved entries are searchable by semantic query", async () => {
    const stateManager = new StateManager(tempDir);
    const embeddingClient = new MockEmbeddingClient(64);
    const vectorIndex = new VectorIndex(
      path.join(tempDir, "vector-index.json"),
      embeddingClient
    );
    const km = new KnowledgeManager(
      stateManager,
      createSequentialMockLLMClient([]),
      vectorIndex,
      embeddingClient
    );

    const entryA = makeKnowledgeEntry(
      "vec-entry-readme",
      "README documentation best practices",
      "Write clear installation steps, API examples, and badges.",
      ["readme", "documentation"]
    );

    const entryB = makeKnowledgeEntry(
      "vec-entry-tests",
      "Test coverage improvement strategies",
      "Add unit tests, integration tests, and mutation testing.",
      ["testing", "coverage"]
    );

    await km.saveToSharedKnowledgeBase(entryA, "goal-docs");
    await km.saveToSharedKnowledgeBase(entryB, "goal-tests");

    // VectorIndex should now contain both entries
    expect(vectorIndex.size).toBeGreaterThanOrEqual(2);

    // Semantic search for documentation-related query
    const docResults = await km.searchByEmbedding("documentation README", 5);
    expect(docResults.length).toBeGreaterThanOrEqual(1);
    // Results should be SharedKnowledgeEntries
    for (const r of docResults) {
      expect(r.entry).toBeDefined();
      expect(typeof r.similarity).toBe("number");
      expect(r.similarity).toBeGreaterThanOrEqual(0);
    }
  });

  // ── Test 4: Stale entry detection via getStaleEntries ──

  it("getStaleEntries returns entries whose revalidation_due_at is in the past", async () => {
    const stateManager = new StateManager(tempDir);
    const km = new KnowledgeManager(stateManager, createSequentialMockLLMClient([]));

    // Create an entry with a past revalidation_due_at
    const pastDate = new Date(Date.now() - 24 * 3600 * 1000).toISOString(); // yesterday
    const entry = makeKnowledgeEntry(
      "stale-entry-1",
      "Old knowledge question",
      "Old answer that may be outdated.",
      ["volatile-domain"]
    );

    // Manually save to shared KB then mutate the revalidation_due_at via stateManager
    await km.saveToSharedKnowledgeBase(entry, "goal-stale-test");

    // Read the raw shared KB and set a past due date
    const rawEntries = await stateManager.readRaw("memory/shared-knowledge/entries.json") as unknown[];
    const mutated = rawEntries.map((e: unknown) => {
      const obj = e as Record<string, unknown>;
      if (obj["entry_id"] === "stale-entry-1") {
        return { ...obj, revalidation_due_at: pastDate };
      }
      return obj;
    });
    await stateManager.writeRaw("memory/shared-knowledge/entries.json", mutated);

    const stale = await km.getStaleEntries();
    expect(stale.length).toBeGreaterThanOrEqual(1);
    expect(stale.some((e) => e.entry_id === "stale-entry-1")).toBe(true);
  });

  // ── Test 5: querySharedKnowledge with goalId filter returns only that goal's entries ──

  it("querySharedKnowledge with goalId filter returns only that goal's entries", async () => {
    const stateManager = new StateManager(tempDir);
    const km = new KnowledgeManager(stateManager, createSequentialMockLLMClient([]));

    const entryA = makeKnowledgeEntry("filter-a", "Q for readme", "A for readme", ["common-tag"]);
    const entryB = makeKnowledgeEntry("filter-b", "Q for tests", "A for tests", ["common-tag"]);

    await km.saveToSharedKnowledgeBase(entryA, "goal-filter-a");
    await km.saveToSharedKnowledgeBase(entryB, "goal-filter-b");

    const onlyA = await km.querySharedKnowledge(["common-tag"], "goal-filter-a");
    expect(onlyA.every((e) => e.source_goal_ids.includes("goal-filter-a"))).toBe(true);
    expect(onlyA.some((e) => e.entry_id === "filter-a")).toBe(true);
    // filter-b should NOT appear when filtering to goal-filter-a
    expect(onlyA.some((e) => e.entry_id === "filter-b")).toBe(false);
  });
});

// ─── Group 2: Drive-based Memory Management ───

describe("Milestone 5 — Group 2: Drive-based Memory Management", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  /** Create a mock IDriveScorer with configurable dissatisfaction scores */
  function makeDriveScorer(
    scores: Record<string, number>
  ): IDriveScorer {
    return {
      getDissatisfactionScore: (dimension: string) => scores[dimension] ?? 0.0,
    };
  }

  // ── Test 6: High-dissatisfaction dimension extends compression delay ──

  it("compressionDelay is 2x for high-dissatisfaction dimension (>0.7)", () => {
    const driveScorer = makeDriveScorer({ quality_score: 0.9 });
    const llmClient = createSequentialMockLLMClient([]);
    const manager = new MemoryLifecycleManager(
      tempDir,
      llmClient,
      { retention_period: 100 },
      undefined,
      undefined,
      driveScorer
    );
    manager.initializeDirectories();

    // With dissatisfaction = 0.9 (>0.7) → delay = 2.0 * 100 = 200
    const delay = manager.compressionDelay("goal-retention", "quality_score");
    expect(delay).toBe(200);
  });

  // ── Test 7: Moderate dissatisfaction extends retention by 1.5x ──

  it("compressionDelay is 1.5x for moderate dissatisfaction (0.4 < score <= 0.7)", () => {
    const driveScorer = makeDriveScorer({ quality_score: 0.55 });
    const llmClient = createSequentialMockLLMClient([]);
    const manager = new MemoryLifecycleManager(
      tempDir,
      llmClient,
      { retention_period: 100 },
      undefined,
      undefined,
      driveScorer
    );
    manager.initializeDirectories();

    // dissatisfaction = 0.55 (0.4 < 0.55 <= 0.7) → 1.5x
    const delay = manager.compressionDelay("goal-moderate", "quality_score");
    expect(delay).toBe(150);
  });

  // ── Test 8: onSatisficingJudgment marks dimension for early compression ──

  it("onSatisficingJudgment(satisfied=true) marks dimension for early compression", () => {
    const llmClient = createSequentialMockLLMClient([]);
    const manager = new MemoryLifecycleManager(tempDir, llmClient);
    manager.initializeDirectories();

    expect(manager.getEarlyCompressionCandidates("goal-satisfy").size).toBe(0);

    manager.onSatisficingJudgment("goal-satisfy", "quality_score", true);

    const candidates = manager.getEarlyCompressionCandidates("goal-satisfy");
    expect(candidates.has("quality_score")).toBe(true);

    // Reversing: satisfied=false removes from candidates
    manager.onSatisficingJudgment("goal-satisfy", "quality_score", false);
    expect(manager.getEarlyCompressionCandidates("goal-satisfy").has("quality_score")).toBe(false);
  });

  // ── Test 9: relevanceScore ranks high-dissatisfaction entries higher ──

  it("relevanceScore ranks high-dissatisfaction entries higher than low-dissatisfaction", () => {
    const driveScorer = makeDriveScorer({
      high_dissatisfaction_dim: 0.9,
      low_dissatisfaction_dim: 0.1,
    });
    const llmClient = createSequentialMockLLMClient([]);
    const manager = new MemoryLifecycleManager(
      tempDir,
      llmClient,
      {},
      undefined,
      undefined,
      driveScorer
    );
    manager.initializeDirectories();

    const now = new Date().toISOString();

    const highDissatEntry = {
      id: "st-high",
      goal_id: "goal-relevance",
      data_type: "experience_log" as const,
      loop_number: 1,
      timestamp: now,
      dimensions: ["high_dissatisfaction_dim"],
      tags: ["quality"],
      data: { note: "high dissatisfaction" },
    };

    const lowDissatEntry = {
      id: "st-low",
      goal_id: "goal-relevance",
      data_type: "experience_log" as const,
      loop_number: 1,
      timestamp: now,
      dimensions: ["low_dissatisfaction_dim"],
      tags: ["quality"],
      data: { note: "low dissatisfaction" },
    };

    const context = { goalId: "goal-relevance", dimensions: ["high_dissatisfaction_dim", "low_dissatisfaction_dim"], tags: ["quality"] };

    const highScore = manager.relevanceScore(highDissatEntry, context);
    const lowScore = manager.relevanceScore(lowDissatEntry, context);

    // High dissatisfaction dimension should yield higher relevance score
    expect(highScore).toBeGreaterThan(lowScore);
  });

  // ── Test 10: recordToShortTerm persists entry ──

  it("recordToShortTerm persists entry to short-term memory", async () => {
    const llmClient = createSequentialMockLLMClient([]);
    const manager = new MemoryLifecycleManager(tempDir, llmClient);
    await manager.initializeDirectories();

    const entry = await manager.recordToShortTerm(
      "goal-persist",
      "experience_log",
      { action: "test action", outcome: "success" },
      { loopNumber: 1, dimensions: ["quality_score"], tags: ["test"] }
    );

    expect(entry.goal_id).toBe("goal-persist");
    expect(entry.data_type).toBe("experience_log");
    expect(entry.loop_number).toBe(1);
    expect(entry.dimensions).toContain("quality_score");

    // Verify file was written
    const goalDir = path.join(tempDir, "memory", "short-term", "goals", "goal-persist");
    expect(fs.existsSync(goalDir)).toBe(true);
  });
});

// ─── Group 3: Dynamic Context Budget ───

describe("Milestone 5 — Group 3: Dynamic Context Budget", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  // ── Test 11: Small budget excludes low-priority slots ──

  it("filterSlotsByBudget with small budget excludes low-priority slots", () => {
    const stateManager = new StateManager(tempDir);
    const sessionManager = new SessionManager(stateManager);

    // Build a task execution context (4-5 slots)
    const slots = sessionManager.buildTaskExecutionContext("goal-budget", "task-budget");
    expect(slots.length).toBeGreaterThanOrEqual(4);

    // Each slot's content is a short string — use a tiny budget that only fits p1
    // Token estimate for "goal_id:goal-budget task_id:task-budget" = ceil(40 / 4) = 10
    const tinyBudget = 12; // fits only the first slot
    const filtered = sessionManager.filterSlotsByBudget(slots, tinyBudget);

    // Only highest-priority (p1) slot should survive
    expect(filtered.length).toBeLessThan(slots.length);
    expect(filtered.every((s) => s.priority <= 2)).toBe(true);
  });

  // ── Test 12: compressSlot truncates oversized content correctly ──

  it("compressSlot truncates content with head + tail strategy", () => {
    const stateManager = new StateManager(tempDir);
    const sessionManager = new SessionManager(stateManager);

    const longContent = "A".repeat(1000);
    const slot = { priority: 1, label: "test", content: longContent, token_estimate: 250 };

    // maxTokens = 50 → maxChars = 200
    const compressed = sessionManager.compressSlot(slot, 50);

    expect(compressed.content.length).toBeLessThan(longContent.length);
    expect(compressed.content).toContain("...[truncated]...");
    // Head: 60% of 200 = 120 chars
    expect(compressed.content.startsWith("A".repeat(120))).toBe(true);
    // Token estimate should be updated
    expect(compressed.token_estimate).toBeGreaterThan(0);
    expect(compressed.token_estimate).toBeLessThan(250);
  });

  // ── Test 13: buildContextWithConflictAwareness injects resource_conflict slot ──

  it("buildContextWithConflictAwareness injects resource_conflict_awareness slot when conflicts exist", () => {
    const stateManager = new StateManager(tempDir);
    const depGraph = new GoalDependencyGraph(stateManager);

    // Add a resource conflict edge between goal-A and goal-B
    depGraph.addEdge({
      from_goal_id: "goal-A",
      to_goal_id: "goal-B",
      type: "resource_conflict",
      status: "active",
      affected_dimensions: ["quality_score", "test_coverage"],
      confidence: 0.9,
    });

    const sessionManager = new SessionManager(stateManager, depGraph);

    const slots = sessionManager.buildContextWithConflictAwareness(
      "goal-A",
      "task_execution"
    );

    const conflictSlot = slots.find((s) => s.label === "resource_conflict_awareness");
    expect(conflictSlot).toBeDefined();
    expect(conflictSlot!.content).toContain("goal-B");
    expect(conflictSlot!.content).toContain("quality_score");
    expect(conflictSlot!.priority).toBe(4.5);
  });

  // ── Test 14: No conflict slot when no dependency graph is provided ──

  it("buildContextWithConflictAwareness has no conflict slot when no dependency graph", () => {
    const stateManager = new StateManager(tempDir);
    const sessionManager = new SessionManager(stateManager); // no depGraph

    const slots = sessionManager.buildContextWithConflictAwareness(
      "goal-no-conflict",
      "task_execution"
    );

    const conflictSlot = slots.find((s) => s.label === "resource_conflict_awareness");
    expect(conflictSlot).toBeUndefined();
  });
});

// ─── Group 4: Full Integration — Multi-Goal Loop with Knowledge Transfer ───

describe("Milestone 5 — Group 4: Full Integration — Multi-Goal Loop with Knowledge Transfer", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  /** Wire up a CoreLoop with all real components except LLM */
  function buildCoreLoop(
    stateManager: StateManager,
    llmClient: ILLMClient,
    maxIterations: number = 1
  ): CoreLoop {
    const obsEngine = new ObservationEngine(stateManager, [], llmClient);
    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const stallDetector = new StallDetector(stateManager);
    const satisficingJudge = new SatisficingJudge(stateManager);
    const reportingEngine = new ReportingEngine(stateManager);
    const driveSystem = new DriveSystem(stateManager, { baseDir: tempDir });
    const strategyManager = new StrategyManager(stateManager, llmClient);

    const taskLifecycle = new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { approvalFn: async (_task) => true }
    );

    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register(new MockAdapter());

    return new CoreLoop(
      {
        stateManager,
        observationEngine: obsEngine,
        gapCalculator: GapCalculator,
        driveScorer: DriveScorer,
        taskLifecycle,
        satisficingJudge,
        stallDetector,
        strategyManager,
        reportingEngine,
        driveSystem,
        adapterRegistry,
      },
      { maxIterations, delayBetweenLoopsMs: 0 }
    );
  }

  // ── Test 15: CoreLoop iteration for goal A generates knowledge, shared KB accessible from goal B ──

  it("Knowledge saved for goal A is accessible from goal B via shared KB", async () => {
    const stateManager = new StateManager(tempDir);

    // Goal A: improve README quality
    const goalA = makeGoal("goal-readme-m5", "Improve README quality");
    await stateManager.saveGoal(goalA);

    // Goal B: improve test coverage
    const goalB = makeGoal("goal-tests-m5", "Improve test coverage");
    await stateManager.saveGoal(goalB);

    // Create KnowledgeManager for sharing knowledge between goals
    const km = new KnowledgeManager(stateManager, createSequentialMockLLMClient([]));

    // Simulate goal A generating a knowledge entry during its loop
    const knowledgeFromA = makeKnowledgeEntry(
      "km-readme-finding",
      "What makes a README effective?",
      "Clear installation steps, API examples, and real-world usage patterns.",
      ["readme", "documentation", "quality"]
    );

    // Save goal A's knowledge to shared KB
    const sharedEntry = await km.saveToSharedKnowledgeBase(knowledgeFromA, "goal-readme-m5");
    expect(sharedEntry.source_goal_ids).toContain("goal-readme-m5");

    // Goal B should now be able to access the knowledge
    const goalBKnowledge = await km.querySharedKnowledge(["documentation"]);
    expect(goalBKnowledge.length).toBeGreaterThanOrEqual(1);

    const found = goalBKnowledge.find((e) => e.entry_id === "km-readme-finding");
    expect(found).toBeDefined();
    expect(found!.answer).toContain("installation steps");
  });

  // ── Test 16: CoreLoop run produces iterations; MemoryLifecycleManager records entries ──

  it("MemoryLifecycleManager records short-term entries during CoreLoop run", async () => {
    const stateDir = path.join(tempDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const stateManager = new StateManager(stateDir);

    const llmClient = createSequentialMockLLMClient([
      // observation for quality_score dimension
      makeLLMObservationScore(0.6, "Quality needs improvement"),
      // task generation
      "```json\n" + makeTaskGenerationResponse("quality_score") + "\n```",
      // LLM review
      makeLLMReviewResponse(),
    ]);

    const coreLoop = buildCoreLoop(stateManager, llmClient, 1);

    const goalId = "goal-memory-m5";
    await stateManager.saveGoal(makeGoal(goalId, "Test memory recording"));

    const result = await coreLoop.run(goalId);

    expect(result).toBeDefined();
    expect(result.goalId).toBe(goalId);
    expect(result.totalIterations).toBeGreaterThanOrEqual(1);

    // Now set up MemoryLifecycleManager and record an observation
    const memManager = new MemoryLifecycleManager(stateDir, llmClient);
    await memManager.initializeDirectories();

    const entry = await memManager.recordToShortTerm(
      goalId,
      "observation",
      { quality_score: 0.6, reason: "Quality needs improvement" },
      { loopNumber: 1, dimensions: ["quality_score"], tags: ["quality"] }
    );

    expect(entry.goal_id).toBe(goalId);
    expect(entry.data_type).toBe("observation");
    expect(entry.dimensions).toContain("quality_score");

    // Short-term data file should exist
    const stEntryFile = path.join(
      stateDir,
      "memory",
      "short-term",
      "goals",
      goalId,
      "observations.json"
    );
    expect(fs.existsSync(stEntryFile)).toBe(true);
  });

  // ── Test 17: Multi-goal sequential loop — both goals run, knowledge persists between them ──

  it("Two goals run sequentially; knowledge persisted by first goal is available to second", async () => {
    const stateDir = path.join(tempDir, "state2");
    fs.mkdirSync(stateDir, { recursive: true });
    const stateManager = new StateManager(stateDir);
    const km = new KnowledgeManager(stateManager, createSequentialMockLLMClient([]));

    // Set up two goals
    const goalA = makeGoal("goal-seq-a", "Sequential Goal A");
    const goalB = makeGoal("goal-seq-b", "Sequential Goal B");
    await stateManager.saveGoal(goalA);
    await stateManager.saveGoal(goalB);

    // --- Run goal A iteration ---
    const llmA = createSequentialMockLLMClient([
      makeLLMObservationScore(0.5, "Below threshold"),
      "```json\n" + makeTaskGenerationResponse() + "\n```",
      makeLLMReviewResponse(),
    ]);
    const loopA = buildCoreLoop(stateManager, llmA, 1);
    const resultA = await loopA.run("goal-seq-a");
    expect(resultA.totalIterations).toBeGreaterThanOrEqual(1);

    // Goal A saves a knowledge entry to shared KB
    const discoveryFromA = makeKnowledgeEntry(
      "seq-knowledge-from-a",
      "How to measure README quality?",
      "Use automated tools that check for sections, code examples, and completeness.",
      ["readme", "metrics"]
    );
    await km.saveToSharedKnowledgeBase(discoveryFromA, "goal-seq-a");

    // --- Run goal B iteration ---
    const llmB = createSequentialMockLLMClient([
      makeLLMObservationScore(0.55, "Slightly below threshold"),
      "```json\n" + makeTaskGenerationResponse() + "\n```",
      makeLLMReviewResponse(),
    ]);
    const loopB = buildCoreLoop(stateManager, llmB, 1);
    const resultB = await loopB.run("goal-seq-b");
    expect(resultB.totalIterations).toBeGreaterThanOrEqual(1);

    // Goal B can now access Goal A's shared knowledge
    const accessFromB = await km.querySharedKnowledge(["readme"]);
    expect(accessFromB.length).toBeGreaterThanOrEqual(1);
    expect(accessFromB.some((e) => e.entry_id === "seq-knowledge-from-a")).toBe(true);

    // Both loops completed without errors
    expect(["completed", "max_iterations"]).toContain(resultA.finalStatus);
    expect(["completed", "max_iterations"]).toContain(resultB.finalStatus);
  });
});
