import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { z } from "zod";
import { StateManager } from "./state-manager.js";
import type { ILLMClient } from "./llm-client.js";
import { TaskSchema } from "./types/task.js";
import type { Task } from "./types/task.js";
import {
  KnowledgeEntrySchema,
  DomainKnowledgeSchema,
  KnowledgeGapSignalSchema,
  ContradictionResultSchema,
} from "./types/knowledge.js";
import type {
  KnowledgeEntry,
  DomainKnowledge,
  KnowledgeGapSignal,
  ContradictionResult,
} from "./types/knowledge.js";

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

/**
 * KnowledgeManager detects knowledge gaps, generates research tasks,
 * and persists/retrieves domain knowledge entries.
 *
 * File layout:
 *   <base>/goals/<goal_id>/domain_knowledge.json
 */
export class KnowledgeManager {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;

  constructor(stateManager: StateManager, llmClient: ILLMClient) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
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

    const response = await this.llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      {
        system:
          "You are a knowledge gap detector. Analyze contexts to identify missing domain knowledge. Respond with JSON only.",
        max_tokens: 512,
      }
    );

    try {
      const parsed = this.llmClient.parseJSON(
        response.content,
        GapDetectionResponseSchema
      );

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
    } catch {
      return null;
    }
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

    const response = await this.llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      {
        system:
          "You generate knowledge acquisition tasks. Produce 3-5 specific research questions. Respond with JSON only.",
        max_tokens: 1024,
      }
    );

    const fields = this.llmClient.parseJSON(
      response.content,
      AcquisitionTaskFieldsSchema
    );

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
    this.stateManager.writeRaw(`tasks/${goalId}/${taskId}.json`, task);

    return task;
  }

  // ─── saveKnowledge ───

  /**
   * Persist a KnowledgeEntry to ~/.motiva/goals/<goal_id>/domain_knowledge.json
   */
  async saveKnowledge(goalId: string, entry: KnowledgeEntry): Promise<void> {
    const parsed = KnowledgeEntrySchema.parse(entry);
    const domainKnowledge = await this.loadDomainKnowledge(goalId);

    domainKnowledge.entries.push(parsed);
    domainKnowledge.last_updated = new Date().toISOString();

    const validated = DomainKnowledgeSchema.parse(domainKnowledge);
    this.stateManager.writeRaw(
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
    const domainKnowledge = await this.loadDomainKnowledge(goalId);
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
    const domainKnowledge = await this.loadDomainKnowledge(goalId);
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

  // ─── Private Helpers ───

  private async loadDomainKnowledge(goalId: string): Promise<DomainKnowledge> {
    const raw = this.stateManager.readRaw(
      `goals/${goalId}/domain_knowledge.json`
    );

    if (raw === null) {
      return DomainKnowledgeSchema.parse({
        goal_id: goalId,
        domain: goalId,
        entries: [],
        last_updated: new Date().toISOString(),
      });
    }

    return DomainKnowledgeSchema.parse(raw);
  }
}
