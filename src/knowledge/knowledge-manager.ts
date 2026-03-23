import { randomUUID } from "node:crypto";
import { z } from "zod";
import { StateManager } from "../state-manager.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { IPromptGateway } from "../prompt/gateway.js";
import { TaskSchema } from "../types/task.js";
import type { Task } from "../types/task.js";
import {
  KnowledgeEntrySchema,
  DomainKnowledgeSchema,
  KnowledgeGapSignalSchema,
  ContradictionResultSchema,
  SharedKnowledgeEntrySchema,
  REVALIDATION_SCHEDULE,
} from "../types/knowledge.js";
import type {
  KnowledgeEntry,
  DomainKnowledge,
  KnowledgeGapSignal,
  ContradictionResult,
  SharedKnowledgeEntry,
  DomainStability,
  DecisionRecord,
} from "../types/knowledge.js";
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

// ─── LLM response schemas ───

const GapDetectionResponseSchema = z.object({
  has_gap: z.boolean(),
  signal_type: z
    .enum([
      "interpretation_difficulty",
      "strategy_deadlock",
      "stall_information_deficit",
      "new_domain",
      "prerequisite_missing",
    ])
    .optional(),
  missing_knowledge: z.string().optional(),
  source_step: z.string().optional(),
  related_dimension: z.string().nullable().optional(),
});

const AcquisitionTaskFieldsSchema = z.object({
  knowledge_target: z.string(),
  // Allow up to 6 from LLM; we clamp to 5 in generateAcquisitionTask
  knowledge_questions: z.array(z.string()).min(3),
  in_scope: z.array(z.string()),
  out_of_scope: z.array(z.string()),
});

const ContradictionCheckResponseSchema = z.object({
  has_contradiction: z.boolean(),
  conflicting_entry_id: z.string().nullable().default(null),
  resolution: z.string().nullable().default(null),
});

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

  /**
   * Detect whether the given context reveals a knowledge gap.
   *
   * Fast-path heuristics:
   *   - confidence < 0.3 → interpretation_difficulty
   *   - strategies empty  → strategy_deadlock
   *
   * Otherwise, delegate to LLM for deeper analysis.
   */
  async detectKnowledgeGap(context: {
    observations: unknown[];
    strategies: unknown[] | null | undefined;
    confidence: number;
  }): Promise<KnowledgeGapSignal | null> {
    // Fast-path: low confidence → interpretation difficulty
    if (context.confidence < 0.3) {
      return KnowledgeGapSignalSchema.parse({
        signal_type: "interpretation_difficulty",
        missing_knowledge:
          "Observation confidence is too low to interpret results reliably",
        source_step: "gap_recognition",
        related_dimension: null,
      });
    }

    // Fast-path: strategies is an explicit empty array (tried and found none) → strategy deadlock.
    // null/undefined means "not yet available" and must NOT trigger this fast-path.
    if (Array.isArray(context.strategies) && context.strategies.length === 0) {
      return KnowledgeGapSignalSchema.parse({
        signal_type: "strategy_deadlock",
        missing_knowledge:
          "No strategies available — domain knowledge needed to generate hypotheses",
        source_step: "strategy_selection",
        related_dimension: null,
      });
    }

    // LLM-based detection for borderline cases
    const prompt = `Analyze the following context and determine whether there is a knowledge gap that would prevent effective progress.

Observations (${context.observations.length} items): ${JSON.stringify(context.observations).slice(0, 500)}
Strategies (${(context.strategies ?? []).length} items): ${JSON.stringify(context.strategies ?? []).slice(0, 500)}
Confidence: ${context.confidence}

Determine if there is a knowledge gap. Respond with JSON:
{
  "has_gap": boolean,
  "signal_type": "interpretation_difficulty" | "strategy_deadlock" | "stall_information_deficit" | "new_domain" | "prerequisite_missing" | null,
  "missing_knowledge": "description of what is missing" | null,
  "source_step": "gap_recognition" | "strategy_selection" | "task_generation" | null,
  "related_dimension": "dimension name" | null
}`;

    let parsed: z.infer<typeof GapDetectionResponseSchema>;
    if (this.gateway) {
      try {
        parsed = await this.gateway.execute({
          purpose: "knowledge_gap_detection",
          additionalContext: { gap_detection_prompt: prompt },
          responseSchema: GapDetectionResponseSchema,
          maxTokens: 512,
        });
      } catch {
        return null;
      }
    } else {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        {
          system:
            "You are a knowledge gap detector. Analyze contexts to identify missing domain knowledge. Respond with JSON only.",
          max_tokens: 512,
        }
      );

      try {
        parsed = this.llmClient.parseJSON(
          response.content,
          GapDetectionResponseSchema
        );
      } catch {
        return null;
      }
    }

    if (!parsed.has_gap) {
      return null;
    }

    return KnowledgeGapSignalSchema.parse({
      signal_type: parsed.signal_type ?? "interpretation_difficulty",
      missing_knowledge:
        parsed.missing_knowledge ?? "Unspecified knowledge gap detected",
      source_step: parsed.source_step ?? "gap_recognition",
      related_dimension: parsed.related_dimension ?? null,
    });
  }

  // ─── generateAcquisitionTask ───

  /**
   * Generate a knowledge acquisition Task for the given signal and goal.
   * The task will have task_category: "knowledge_acquisition", 3-5 research
   * questions, and explicit scope limits.
   */
  async generateAcquisitionTask(
    signal: KnowledgeGapSignal,
    goalId: string
  ): Promise<Task> {
    const prompt = `You are generating a knowledge acquisition task for an AI orchestrator.

Goal ID: ${goalId}
Knowledge Gap Signal:
  Type: ${signal.signal_type}
  Missing Knowledge: ${signal.missing_knowledge}
  Source Step: ${signal.source_step}
  Related Dimension: ${signal.related_dimension ?? "none"}

Generate a research task with 3-5 specific questions that, when answered, will resolve this knowledge gap.
The task must be scoped to information collection only — no system changes.

Respond with JSON:
{
  "knowledge_target": "concise description of what knowledge is needed",
  "knowledge_questions": ["question 1", "question 2", "question 3"],
  "in_scope": ["item 1", "item 2"],
  "out_of_scope": ["item 1", "item 2"]
}`;

    let fields: z.infer<typeof AcquisitionTaskFieldsSchema>;
    if (this.gateway) {
      fields = await this.gateway.execute({
        purpose: "knowledge_acquisition",
        goalId,
        additionalContext: { acquisition_prompt: prompt },
        responseSchema: AcquisitionTaskFieldsSchema,
        maxTokens: 1024,
      });
    } else {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        {
          system:
            "You generate knowledge acquisition tasks. Produce 3-5 specific research questions. Respond with JSON only.",
          max_tokens: 1024,
        }
      );

      fields = this.llmClient.parseJSON(
        response.content,
        AcquisitionTaskFieldsSchema
      );
    }

    // Clamp questions to 3-5
    const questions = fields.knowledge_questions.slice(0, 5);

    const taskId = randomUUID();
    const now = new Date().toISOString();

    const criteriaDescription = `All ${questions.length} research questions are answered with cited sources: ${questions.join("; ")}`;

    const task = TaskSchema.parse({
      id: taskId,
      goal_id: goalId,
      strategy_id: null,
      target_dimensions: signal.related_dimension
        ? [signal.related_dimension]
        : [],
      primary_dimension: signal.related_dimension ?? "knowledge",
      work_description: `Research task: ${fields.knowledge_target}`,
      rationale: `Knowledge gap detected (${signal.signal_type}): ${signal.missing_knowledge}`,
      approach: `Research the following questions using web search and document analysis:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
      success_criteria: [
        {
          description: criteriaDescription,
          verification_method:
            "Verify each question has a cited answer in the task output",
          is_blocking: true,
        },
      ],
      scope_boundary: {
        in_scope: ["Information collection", "Web search", "Document reading", ...fields.in_scope],
        out_of_scope: [
          "System modifications",
          "Code changes",
          "Data mutations",
          ...fields.out_of_scope,
        ],
        blast_radius: "None — read-only research task",
      },
      constraints: [
        `In scope: ${fields.in_scope.join(", ")}. Out of scope: ${fields.out_of_scope.join(", ")}`,
        "No system modifications allowed",
        "Maximum 3-5 research questions per task",
      ],
      reversibility: "reversible",
      estimated_duration: { value: 4, unit: "hours" },
      task_category: "knowledge_acquisition",
      status: "pending",
      created_at: now,
    });

    // Persist
    await this.stateManager.writeRaw(`tasks/${goalId}/${taskId}.json`, task);

    return task;
  }

  // ─── saveKnowledge ───

  /**
   * Persist a KnowledgeEntry to ~/.tavori/goals/<goal_id>/domain_knowledge.json
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
    await this.stateManager.writeRaw(
      `goals/${goalId}/domain_knowledge.json`,
      validated
    );
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

  /**
   * Check whether a new entry contradicts existing same-tag entries.
   * Uses LLM to compare answers for entries sharing tags with the new entry.
   */
  async checkContradiction(
    goalId: string,
    newEntry: KnowledgeEntry
  ): Promise<ContradictionResult> {
    // Load entries that share at least one tag with the new entry
    const domainKnowledge = await this._loadDomainKnowledge(goalId);
    const candidateEntries = domainKnowledge.entries.filter(
      (existing) =>
        existing.entry_id !== newEntry.entry_id &&
        existing.tags.some((tag) => newEntry.tags.includes(tag)) &&
        existing.superseded_by === null
    );

    if (candidateEntries.length === 0) {
      return ContradictionResultSchema.parse({
        has_contradiction: false,
        conflicting_entry_id: null,
        resolution: null,
      });
    }

    const existingSummary = candidateEntries
      .map(
        (e) =>
          `Entry ${e.entry_id}:\n  Question: ${e.question}\n  Answer: ${e.answer}\n  Tags: ${e.tags.join(", ")}`
      )
      .join("\n\n");

    const prompt = `Check whether the new knowledge entry contradicts any existing entries.

New Entry:
  Question: ${newEntry.question}
  Answer: ${newEntry.answer}
  Tags: ${newEntry.tags.join(", ")}

Existing Entries (same tags):
${existingSummary}

Determine if there is a factual contradiction. Respond with JSON:
{
  "has_contradiction": boolean,
  "conflicting_entry_id": "entry_id of the conflicting entry" | null,
  "resolution": "explanation of the contradiction and suggested resolution" | null
}`;

    if (this.gateway) {
      try {
        const parsed = await this.gateway.execute({
          purpose: "knowledge_contradiction",
          goalId,
          additionalContext: { contradiction_prompt: prompt },
          responseSchema: ContradictionCheckResponseSchema,
          maxTokens: 512,
        });
        return ContradictionResultSchema.parse(parsed);
      } catch {
        return ContradictionResultSchema.parse({
          has_contradiction: false,
          conflicting_entry_id: null,
          resolution: null,
        });
      }
    } else {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        {
          system:
            "You are a knowledge consistency checker. Detect factual contradictions between knowledge entries. Respond with JSON only.",
          max_tokens: 512,
        }
      );

      try {
        const parsed = this.llmClient.parseJSON(
          response.content,
          ContradictionCheckResponseSchema
        );
        return ContradictionResultSchema.parse(parsed);
      } catch {
        return ContradictionResultSchema.parse({
          has_contradiction: false,
          conflicting_entry_id: null,
          resolution: null,
        });
      }
    }
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
   * Save a DecisionRecord to ~/.tavori/decisions/<goalId>-<timestamp>.json
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
}
