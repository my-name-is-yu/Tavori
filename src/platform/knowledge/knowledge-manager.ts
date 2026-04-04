import { z } from "zod";
import { StateManager } from "../../base/state/state-manager.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { IPromptGateway } from "../../prompt/gateway.js";
import { TaskSchema } from "../../base/types/task.js";
import type { Task } from "../../base/types/task.js";
import {
  KnowledgeEntrySchema,
  DomainKnowledgeSchema,
  KnowledgeGapSignalSchema,
  ContradictionResultSchema,
  SharedKnowledgeEntrySchema,
  REVALIDATION_SCHEDULE,
} from "../../base/types/knowledge.js";
import type {
  KnowledgeEntry,
  DomainKnowledge,
  KnowledgeGapSignal,
  ContradictionResult,
  SharedKnowledgeEntry,
  DomainStability,
  DecisionRecord,
} from "../../base/types/knowledge.js";
import type { VectorIndex } from "./vector-index.js";
import type { IEmbeddingClient } from "./embedding-client.js";
import {
  searchKnowledge,
  searchAcrossGoals,
  searchByEmbedding,
  querySharedKnowledge,
  loadSharedEntries,
  loadDomainKnowledge,
} from "./knowledge-search.js";
import {
  classifyDomainStability,
  getStaleEntries,
  generateRevalidationTasks,
  computeRevalidationDue,
} from "./knowledge-revalidation.js";
import {
  recordDecision,
  enrichDecisionRecord,
  queryDecisions,
  updateDecisionOutcome,
  purgeOldDecisions,
} from "./knowledge-decisions.js";
import {
  detectKnowledgeGap as _detectKnowledgeGap,
  generateAcquisitionTask as _generateAcquisitionTask,
  checkContradiction as _checkContradiction,
} from "./knowledge-manager-query.js";
import type { ToolExecutor } from "../../tools/executor.js";
import type { ToolCallContext } from "../../tools/types.js";


// Re-export for backward compatibility
export {
  searchKnowledge,
  searchAcrossGoals,
  searchByEmbedding,
  querySharedKnowledge,
  classifyDomainStability,
  getStaleEntries,
  generateRevalidationTasks,
  computeRevalidationDue,
};

// Re-export standalone LLM query functions
export { detectKnowledgeGap, generateAcquisitionTask, checkContradiction } from "./knowledge-manager-query.js";

// ─── KnowledgeManager ───

/** Key used to store all SharedKnowledgeEntries as a flat array. */
const SHARED_KB_PATH = "memory/shared-knowledge/entries.json";

/**
 * KnowledgeManager detects knowledge gaps, generates research tasks,
 * and persists/retrieves domain knowledge entries.
 *
 * File layout:
 *   <base>/goals/<goal_id>/domain_knowledge.json
 *   <base>/memory/shared-knowledge/entries.json  (Phase 2 shared KB)
 */
export class KnowledgeManager {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;
  private readonly vectorIndex?: VectorIndex;
  private readonly embeddingClient?: IEmbeddingClient;
  private readonly gateway?: IPromptGateway;

  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    vectorIndex?: VectorIndex,
    embeddingClient?: IEmbeddingClient,
    gateway?: IPromptGateway
  ) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
    this.vectorIndex = vectorIndex;
    this.embeddingClient = embeddingClient;
    this.gateway = gateway;
  }

  // ─── detectKnowledgeGap ───

  async detectKnowledgeGap(context: {
    observations: unknown[];
    strategies: unknown[] | null | undefined;
    confidence: number;
  }): Promise<KnowledgeGapSignal | null> {
    return _detectKnowledgeGap(
      { llmClient: this.llmClient, gateway: this.gateway, stateManager: this.stateManager },
      context
    );
  }

  // ─── generateAcquisitionTask ───

  async generateAcquisitionTask(
    signal: KnowledgeGapSignal,
    goalId: string
  ): Promise<Task> {
    return _generateAcquisitionTask(
      { llmClient: this.llmClient, gateway: this.gateway, stateManager: this.stateManager },
      signal,
      goalId
    );
  }

  // ─── saveKnowledge ───

  /**
   * Persist a KnowledgeEntry to ~/.pulseed/goals/<goal_id>/domain_knowledge.json
   */
  async saveKnowledge(goalId: string, entry: KnowledgeEntry): Promise<void> {
    const parsed = KnowledgeEntrySchema.parse(entry);
    const domainKnowledge = await this._loadDomainKnowledge(goalId);

    // Phase 2: attempt vector indexing first — if the embedding API fails,
    // we avoid writing a stale disk state that is out of sync with the index.
    if (this.vectorIndex) {
      await this.vectorIndex.add(
        parsed.entry_id,
        `${parsed.question} ${parsed.answer}`,
        { goal_id: goalId, tags: parsed.tags }
      );
    }

    domainKnowledge.entries.push(parsed);
    domainKnowledge.last_updated = new Date().toISOString();

    const validated = DomainKnowledgeSchema.parse(domainKnowledge);

    // Phase 2: index in VectorIndex first so writeRaw is the commit point.
    // If writeRaw fails, roll back the vector index entry to keep consistency.
    if (this.vectorIndex) {
      await this.vectorIndex.add(
        parsed.entry_id,
        `${parsed.question} ${parsed.answer}`,
        { goal_id: goalId, tags: parsed.tags }
      );
    }

    try {
      await this.stateManager.writeRaw(
        `goals/${goalId}/domain_knowledge.json`,
        validated
      );
    } catch (err) {
      if (this.vectorIndex) {
        await this.vectorIndex.remove(parsed.entry_id);
      }
      throw err;
    }
  }

  // ─── loadKnowledge ───

  /**
   * Load knowledge entries for a goal, optionally filtered by tags (exact match).
   *
   * An entry matches if ALL provided tags appear in the entry's tags array.
   */
  async loadKnowledge(
    goalId: string,
    tags?: string[]
  ): Promise<KnowledgeEntry[]> {
    const domainKnowledge = await this._loadDomainKnowledge(goalId);
    const entries = domainKnowledge.entries;

    if (!tags || tags.length === 0) {
      return entries;
    }

    return entries.filter((entry) =>
      tags.every((tag) => entry.tags.includes(tag))
    );
  }

  // ─── checkContradiction ───

  async checkContradiction(
    goalId: string,
    newEntry: KnowledgeEntry
  ): Promise<ContradictionResult> {
    return _checkContradiction(
      { llmClient: this.llmClient, gateway: this.gateway, stateManager: this.stateManager },
      goalId,
      newEntry
    );
  }

  // ─── getRelevantKnowledge ───

  /**
   * Returns knowledge entries whose tags include the given dimension name.
   */
  async getRelevantKnowledge(
    goalId: string,
    dimensionName: string
  ): Promise<KnowledgeEntry[]> {
    return this.loadKnowledge(goalId, [dimensionName]);
  }

  // ─── searchKnowledge (Phase 2) ───

  /**
   * Semantic search within a single goal's knowledge entries via VectorIndex.
   * Falls back to an empty array when no VectorIndex is configured.
   */
  async searchKnowledge(
    query: string,
    topK: number = 5
  ): Promise<KnowledgeEntry[]> {
    return searchKnowledge(
      { stateManager: this.stateManager, vectorIndex: this.vectorIndex },
      query,
      topK
    );
  }

  // ─── searchAcrossGoals (Phase 2) ───

  /**
   * Cross-goal semantic search. Leverages the VectorIndex which is global
   * across all goals. Returns entries from any goal ordered by similarity.
   * Falls back to an empty array when no VectorIndex is configured.
   */
  async searchAcrossGoals(
    query: string,
    topK: number = 5
  ): Promise<KnowledgeEntry[]> {
    return searchAcrossGoals(
      { stateManager: this.stateManager, vectorIndex: this.vectorIndex },
      query,
      topK
    );
  }

  // ─── 5.1a: Shared Knowledge Base ───

  /**
   * Save a KnowledgeEntry into the shared knowledge base, associating it with
   * the given goalId. If VectorIndex is available the entry is also embedded
   * and the embedding_id is stored on the returned SharedKnowledgeEntry.
   */
  async saveToSharedKnowledgeBase(
    entry: KnowledgeEntry,
    goalId: string
  ): Promise<SharedKnowledgeEntry> {
    const now = new Date();

    // Build shared entry (default stability: moderate)
    const shared = SharedKnowledgeEntrySchema.parse({
      ...entry,
      source_goal_ids: [goalId],
      domain_stability: "moderate" as DomainStability,
      revalidation_due_at: computeRevalidationDue(now, "moderate"),
      embedding_id: null,
    });

    // Load existing entries and merge / append
    const all = await loadSharedEntries(this.stateManager);
    const existingIdx = all.findIndex((e) => e.entry_id === entry.entry_id);

    let merged: SharedKnowledgeEntry;
    if (existingIdx >= 0) {
      const existing = all[existingIdx]!;
      const mergedGoalIds = Array.from(
        new Set([...existing.source_goal_ids, goalId])
      );
      merged = SharedKnowledgeEntrySchema.parse({
        ...existing,
        source_goal_ids: mergedGoalIds,
      });
      all[existingIdx] = merged;
    } else {
      merged = shared;
      all.push(merged);
    }

    // Auto-register in VectorIndex if available
    if (this.vectorIndex) {
      const text = `${entry.question} ${entry.answer} ${entry.tags.join(" ")}`;
      const vectorEntry = await this.vectorIndex.add(entry.entry_id, text, {
        goal_id: goalId,
        tags: entry.tags,
        shared: true,
      });
      // Attach the embedding id (same as entry_id in our VectorIndex)
      merged = SharedKnowledgeEntrySchema.parse({
        ...merged,
        embedding_id: vectorEntry.id,
      });
      // Update stored copy with embedding_id (use already-known index to avoid double scan)
      const targetIdx = existingIdx >= 0 ? existingIdx : all.length - 1;
      all[targetIdx] = merged;
    }

    await this.stateManager.writeRaw(SHARED_KB_PATH, all);
    return merged;
  }

  /**
   * Query the shared knowledge base by tags (AND logic).
   * Optionally filter to entries contributed by a specific goal.
   */
  async querySharedKnowledge(
    tags: string[],
    goalId?: string
  ): Promise<SharedKnowledgeEntry[]> {
    return querySharedKnowledge(this.stateManager, tags, goalId);
  }

  // ─── 5.1b: Vector Search for Knowledge Sharing ───

  /**
   * Semantic search across the shared knowledge base using VectorIndex.
   * Falls back to an empty array when no VectorIndex is configured.
   */
  async searchByEmbedding(
    query: string,
    topK: number = 5
  ): Promise<{ entry: SharedKnowledgeEntry; similarity: number }[]> {
    return searchByEmbedding(
      { stateManager: this.stateManager, vectorIndex: this.vectorIndex },
      query,
      topK
    );
  }

  // ─── 5.1c: Domain Stability Auto-Revalidation ───

  /**
   * Classify the domain stability of a set of knowledge entries via LLM.
   * Returns "stable", "moderate", or "volatile".
   */
  async classifyDomainStability(
    domain: string,
    entries: KnowledgeEntry[]
  ): Promise<DomainStability> {
    return classifyDomainStability(
      { stateManager: this.stateManager, llmClient: this.llmClient },
      domain,
      entries
    );
  }

  /**
   * Return shared knowledge entries whose revalidation_due_at is in the past.
   */
  async getStaleEntries(): Promise<SharedKnowledgeEntry[]> {
    return getStaleEntries(this.stateManager);
  }

  /**
   * Generate KnowledgeAcquisitionTask-style Task objects for each stale entry,
   * re-asking the original question.
   */
  async generateRevalidationTasks(staleEntries: SharedKnowledgeEntry[]): Promise<Task[]> {
    return generateRevalidationTasks(staleEntries);
  }

  // ─── Decision History (M14-S3) ───

  /**
   * Save a DecisionRecord to ~/.pulseed/decisions/<goalId>-<timestamp>.json
   * For completed records (outcome !== "pending"), enriches with LLM-extracted
   * what_worked/what_failed/suggested_next before saving.
   */
  async recordDecision(record: DecisionRecord): Promise<void> {
    return recordDecision(
      { stateManager: this.stateManager, llmClient: this.llmClient },
      record
    );
  }

  /**
   * Enrich a completed DecisionRecord by extracting what_worked/what_failed/suggested_next via LLM.
   * Falls back to default empty arrays on LLM failure.
   */
  async enrichDecisionRecord(record: DecisionRecord): Promise<DecisionRecord> {
    return enrichDecisionRecord(
      { stateManager: this.stateManager, llmClient: this.llmClient },
      record
    );
  }

  /**
   * Load decision records filtered by goal_type, sorted by recency.
   * Applies time-decay scoring (1.0 at day 0, 0.0 at day 30+).
   */
  async queryDecisions(goalType: string, limit: number = 20): Promise<DecisionRecord[]> {
    return queryDecisions(
      { stateManager: this.stateManager, llmClient: this.llmClient },
      goalType,
      limit
    );
  }

  /**
   * Update the outcome of a DecisionRecord identified by strategy_id.
   * Finds the most recent pending record for the given strategy and rewrites it.
   * No-op when no matching pending record is found.
   */
  async updateDecisionOutcome(
    strategyId: string,
    outcome: "success" | "failure"
  ): Promise<void> {
    return updateDecisionOutcome(
      { stateManager: this.stateManager, llmClient: this.llmClient },
      strategyId,
      outcome
    );
  }

  /**
   * Remove decision records older than 90 days.
   * Returns the count of purged records.
   */
  async purgeOldDecisions(): Promise<number> {
    return purgeOldDecisions({
      stateManager: this.stateManager,
      llmClient: this.llmClient,
    });
  }

  // ─── Private Helpers ───

  private async _loadDomainKnowledge(goalId: string): Promise<DomainKnowledge> {
    return loadDomainKnowledge(this.stateManager, goalId);
  }


  // ─── acquireWithTools (Phase 3-B) ───

  /**
   * Acquire knowledge by planning and executing tool calls, then synthesizing results via LLM.
   * Uses read-only tools (glob, grep, read, http_fetch, json_query, shell) to gather data.
   */
  async acquireWithTools(
    question: string,
    goalId: string,
    toolExecutor: ToolExecutor,
    context: ToolCallContext,
  ): Promise<KnowledgeEntry[]> {
    // Step 1: Plan tool calls via LLM
    const planResponse = await this.llmClient.sendMessage(
      [{ role: "user", content: `Question: ${question}\nWorkspace: ${context.cwd}` }],
      { system: "You are a research planner. Given a question, plan tool calls to gather information.\nAvailable read-only tools: glob (find files), grep (search content), read (read file), http_fetch (GET URL), json_query (query JSON file), shell (read-only commands like wc, git log, npm ls).\nReturn a JSON array of { toolName, input } objects. Return [] if the question cannot be answered with these tools." }
    );

    // Step 2: Parse plan, return [] on error or empty
    let toolCalls: Array<{ toolName: string; input: unknown }>;
    try { toolCalls = JSON.parse(planResponse.content); } catch { return []; }
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];

    // Step 3: Execute batch
    const results = await toolExecutor.executeBatch(toolCalls, context);
    const successfulResults = results
      .filter((r) => r.success)
      .map((r) => r.summary + "\n" + String(r.data).slice(0, 2000));
    if (successfulResults.length === 0) return [];

    // Step 4: Synthesize via LLM
    const synthesisResponse = await this.llmClient.sendMessage(
      [{ role: "user", content: `Question: ${question}\n\nTool outputs:\n${successfulResults.join("\n---\n")}` }],
      { system: "Synthesize the following tool outputs to answer the question. Return a JSON object with: { answer: string, confidence: number (0-1), tags: string[] }" }
    );
    try {
      const synthesis = JSON.parse(synthesisResponse.content);
      return [{
        entry_id: crypto.randomUUID(),
        question,
        answer: synthesis.answer,
        sources: toolCalls.map((tc) => ({
          type: "data_analysis" as const,
          reference: `tool:${tc.toolName}`,
          reliability: "high" as const,
        })),
        confidence: Math.min(synthesis.confidence, 0.92),
        acquired_at: new Date().toISOString(),
        acquisition_task_id: "tool_direct",
        superseded_by: null,
        tags: synthesis.tags ?? [],
        embedding_id: null,
      }];
    } catch { return []; }
  }

}