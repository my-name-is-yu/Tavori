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
import {
  AgentMemoryEntrySchema,
  AgentMemoryStoreSchema,
} from "./types/agent-memory.js";
import type { AgentMemoryEntry, AgentMemoryType } from "./types/agent-memory.js";


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

const AGENT_MEMORY_PATH = "memory/agent-memory/entries.json";

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

  // ─── Agent Memory ───

  /**
   * Upsert an agent memory entry by key.
   * If a matching key exists, update value/tags/category/memory_type/updated_at.
   * If not, create a new entry with a UUID id and timestamps.
   */
  async saveAgentMemory(entry: {
    key: string;
    value: string;
    tags?: string[];
    category?: string;
    memory_type?: AgentMemoryType;
  }): Promise<AgentMemoryEntry> {
    const store = await this._loadAgentMemoryStore();
    const now = new Date().toISOString();
    const existing = store.entries.findIndex((e) => e.key === entry.key);

    let saved: AgentMemoryEntry;
    if (existing >= 0) {
      const prev = store.entries[existing]!;
      saved = AgentMemoryEntrySchema.parse({
        ...prev,
        value: entry.value,
        tags: entry.tags ?? prev.tags,
        category: entry.category ?? prev.category,
        memory_type: entry.memory_type ?? prev.memory_type,
        updated_at: now,
      });
      store.entries[existing] = saved;
    } else {
      saved = AgentMemoryEntrySchema.parse({
        id: crypto.randomUUID(),
        key: entry.key,
        value: entry.value,
        tags: entry.tags ?? [],
        category: entry.category,
        memory_type: entry.memory_type ?? "fact",
        created_at: now,
        updated_at: now,
      });
      store.entries.push(saved);
    }

    await this.stateManager.writeRaw(AGENT_MEMORY_PATH, store);
    return saved;
  }

  /**
   * Search agent memory entries by keyword or exact key match.
   * exact=true: filter where entry.key === query.
   * exact=false (default): case-insensitive substring match on key + value + tags.
   * Optionally filter by category and/or memory_type.
   * Excludes archived entries unless include_archived=true.
   * Tiered sort: compiled entries first, then raw, both by updated_at desc.
   */
  async recallAgentMemory(
    query: string,
    opts?: {
      exact?: boolean;
      category?: string;
      memory_type?: AgentMemoryType;
      limit?: number;
      include_archived?: boolean;
    }
  ): Promise<AgentMemoryEntry[]> {
    const store = await this._loadAgentMemoryStore();
    const { exact = false, category, memory_type, limit = 10, include_archived = false } = opts ?? {};
    const lower = query.toLowerCase();

    let results = store.entries.filter((e) => {
      // Exclude archived entries unless explicitly requested
      if (!include_archived && e.status === "archived") return false;

      const matchesQuery = exact
        ? e.key === query
        : e.key.toLowerCase().includes(lower) ||
          e.value.toLowerCase().includes(lower) ||
          e.tags.some((t) => t.toLowerCase().includes(lower));

      const matchesCategory = category ? e.category === category : true;
      const matchesType = memory_type ? e.memory_type === memory_type : true;
      return matchesQuery && matchesCategory && matchesType;
    });

    // Tiered sort: compiled entries first, then raw, both sorted by updated_at desc
    results.sort((a, b) => {
      const aIsCompiled = a.status === "compiled" ? 0 : 1;
      const bIsCompiled = b.status === "compiled" ? 0 : 1;
      if (aIsCompiled !== bIsCompiled) return aIsCompiled - bIsCompiled;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
    return results.slice(0, limit);
  }

  /**
   * List all agent memory entries, optionally filtered by category and/or memory_type.
   * Sorted by updated_at desc.
   */
  async listAgentMemory(opts?: {
    category?: string;
    memory_type?: AgentMemoryType;
    limit?: number;
  }): Promise<AgentMemoryEntry[]> {
    const store = await this._loadAgentMemoryStore();
    const { category, memory_type, limit = 10 } = opts ?? {};

    let results = store.entries.filter((e) => {
      const matchesCategory = category ? e.category === category : true;
      const matchesType = memory_type ? e.memory_type === memory_type : true;
      return matchesCategory && matchesType;
    });

    results.sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
    return results.slice(0, limit);
  }

  /**
   * Delete an agent memory entry by key.
   * Returns true if the entry was found and removed, false otherwise.
   */
  async deleteAgentMemory(key: string): Promise<boolean> {
    const store = await this._loadAgentMemoryStore();
    const idx = store.entries.findIndex((e) => e.key === key);
    if (idx < 0) return false;

    store.entries.splice(idx, 1);
    await this.stateManager.writeRaw(AGENT_MEMORY_PATH, store);
    return true;
  }

  // ─── consolidateAgentMemory ───

  /**
   * Consolidate raw agent memory entries into compiled entries via LLM.
   * Groups entries by category+memory_type; groups with 2+ entries are consolidated.
   * Source entries are archived after consolidation.
   */
  async consolidateAgentMemory(opts: {
    category?: string;
    memory_type?: AgentMemoryType;
    llmCall: (prompt: string) => Promise<string>;
  }): Promise<{ compiled: AgentMemoryEntry[]; archived: number }> {
    const store = await this._loadAgentMemoryStore();
    const now = new Date().toISOString();

    // Filter raw entries
    let rawEntries = store.entries.filter((e) => e.status === "raw");
    if (opts.category) rawEntries = rawEntries.filter((e) => e.category === opts.category);
    if (opts.memory_type) rawEntries = rawEntries.filter((e) => e.memory_type === opts.memory_type);

    // Group by category+memory_type
    const groups = new Map<string, AgentMemoryEntry[]>();
    for (const entry of rawEntries) {
      const groupKey = `${entry.category ?? "_"}::${entry.memory_type}`;
      const group = groups.get(groupKey) ?? [];
      group.push(entry);
      groups.set(groupKey, group);
    }

    const compiledSchema = z.object({
      key: z.string(),
      value: z.string(),
      summary: z.string(),
      tags: z.array(z.string()),
    });

    const compiled: AgentMemoryEntry[] = [];
    const archivedIds = new Set<string>();

    for (const [, group] of groups) {
      if (group.length < 2) continue;

      const entryLines = group
        .map((e) => `- [${e.key}]: ${e.value} (tags: ${e.tags.join(", ")})`)
        .join("\n");

      const prompt = [
        "Consolidate the following memory entries into a single entry.",
        "Return ONLY a JSON object with these fields:",
        "- key: a descriptive key for the consolidated memory",
        "- value: the consolidated content (comprehensive but concise)",
        "- summary: a one-line summary (under 100 chars)",
        "- tags: relevant tags as string array",
        "",
        "Entries to consolidate:",
        entryLines,
      ].join("\n");

      let llmRaw: string;
      try {
        llmRaw = await opts.llmCall(prompt);
      } catch (err) {
        console.warn("[KnowledgeManager] consolidateAgentMemory: llmCall failed, skipping group", err);
        continue;
      }

      // Strip markdown fences and trim
      const sanitized = llmRaw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();

      let parsedResult: z.infer<typeof compiledSchema>;
      try {
        parsedResult = compiledSchema.parse(JSON.parse(sanitized));
      } catch (err) {
        console.warn("[KnowledgeManager] consolidateAgentMemory: failed to parse LLM response, skipping group", err);
        continue;
      }

      const firstEntry = group[0]!;
      const newEntry = AgentMemoryEntrySchema.parse({
        id: crypto.randomUUID(),
        key: parsedResult.key,
        value: parsedResult.value,
        summary: parsedResult.summary,
        tags: parsedResult.tags,
        category: firstEntry.category,
        memory_type: firstEntry.memory_type,
        status: "compiled",
        compiled_from: group.map((e) => e.id),
        created_at: now,
        updated_at: now,
      });

      compiled.push(newEntry);
      store.entries.push(newEntry);

      for (const src of group) {
        archivedIds.add(src.id);
      }
    }

    // Archive source entries
    for (const entry of store.entries) {
      if (archivedIds.has(entry.id)) {
        entry.status = "archived";
        entry.updated_at = now;
      }
    }

    if (compiled.length > 0) {
      store.last_consolidated_at = now;
      await this.stateManager.writeRaw(AGENT_MEMORY_PATH, store);
    }

    return { compiled, archived: archivedIds.size };
  }

  // ─── archiveAgentMemory ───

  /**
   * Archive agent memory entries by IDs.
   * Returns the count of entries actually archived (skips already-archived).
   */
  async archiveAgentMemory(ids: string[]): Promise<number> {
    const store = await this._loadAgentMemoryStore();
    const now = new Date().toISOString();
    let count = 0;

    for (const entry of store.entries) {
      if (ids.includes(entry.id) && entry.status !== "archived") {
        entry.status = "archived";
        entry.updated_at = now;
        count++;
      }
    }

    if (count > 0) {
      await this.stateManager.writeRaw(AGENT_MEMORY_PATH, store);
    }
    return count;
  }

  // ─── getAgentMemoryStats ───

  /**
   * Return counts of agent memory entries grouped by status.
   */
  async getAgentMemoryStats(): Promise<{
    raw: number;
    compiled: number;
    archived: number;
    total: number;
  }> {
    const store = await this._loadAgentMemoryStore();
    const stats = { raw: 0, compiled: 0, archived: 0, total: store.entries.length };
    for (const e of store.entries) {
      if (e.status === "raw") stats.raw++;
      else if (e.status === "compiled") stats.compiled++;
      else if (e.status === "archived") stats.archived++;
    }
    return stats;
  }

  // ─── Private Helpers ───

  private async _loadAgentMemoryStore(): Promise<import('./types/agent-memory.js').AgentMemoryStore> {
    const raw = await this.stateManager.readRaw(AGENT_MEMORY_PATH);
    if (!raw) return AgentMemoryStoreSchema.parse({ entries: [], last_consolidated_at: null });
    return AgentMemoryStoreSchema.parse(raw);
  }

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
    // Sanitize: cap length and validate element shape (CLAUDE.md: sanitize LLM responses)
    const MAX_TOOL_CALLS = 10;
    const validCalls = toolCalls
      .slice(0, MAX_TOOL_CALLS)
      .filter((tc): tc is { toolName: string; input: unknown } =>
        typeof tc === "object" && tc !== null && typeof tc.toolName === "string",
      );
    if (validCalls.length === 0) return [];

    // Step 3: Execute batch
    const results = await toolExecutor.executeBatch(validCalls, context);
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
        sources: validCalls.map((tc) => ({
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