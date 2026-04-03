import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TaskSchema } from "../types/task.js";
import type { Task } from "../types/task.js";
import {
  DomainStabilitySchema,
  REVALIDATION_SCHEDULE,
} from "../types/knowledge.js";
import type {
  KnowledgeEntry,
  SharedKnowledgeEntry,
  DomainStability,
} from "../types/knowledge.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { IPromptGateway } from "../prompt/gateway.js";
import { loadSharedEntries } from "./knowledge-search.js";
import type { StateManager } from "../state/state-manager.js";

// ─── LLM response schema ───

const DomainStabilityResponseSchema = z.object({
  stability: DomainStabilitySchema,
  rationale: z.string().optional(),
});

// ─── Deps interface ───

export interface RevalidationDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  gateway?: IPromptGateway;
}

// ─── Revalidation functions ───

/**
 * Classify the domain stability of a set of knowledge entries via LLM.
 * Returns "stable", "moderate", or "volatile".
 */
export async function classifyDomainStability(
  deps: RevalidationDeps,
  domain: string,
  entries: KnowledgeEntry[]
): Promise<DomainStability> {
  const sampleAnswers = entries
    .slice(0, 5)
    .map((e) => `Q: ${e.question}\nA: ${e.answer}`)
    .join("\n\n");

  const prompt = `You are classifying how quickly knowledge in a domain becomes outdated.

Domain: ${domain}
Sample knowledge entries:
${sampleAnswers || "(no entries yet)"}

Classify the domain stability:
- "stable"   — knowledge rarely changes (math, history, established science)
- "moderate" — knowledge changes every few months to a year (best practices, frameworks)
- "volatile" — knowledge changes frequently (current events, fast-moving tech, prices)

Respond with JSON:
{ "stability": "stable" | "moderate" | "volatile", "rationale": "brief explanation" }`;

  if (deps.gateway) {
    try {
      const parsed = await deps.gateway.execute({
        purpose: "knowledge_stability",
        additionalContext: { stability_prompt: prompt },
        responseSchema: DomainStabilityResponseSchema,
        maxTokens: 256,
      });
      return parsed.stability;
    } catch {
      return "moderate";
    }
  } else {
    const response = await deps.llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      {
        system:
          "You classify knowledge domain stability. Respond with JSON only.",
        max_tokens: 256,
      }
    );

    try {
      const parsed = deps.llmClient.parseJSON(
        response.content,
        DomainStabilityResponseSchema
      );
      return parsed.stability;
    } catch {
      return "moderate";
    }
  }
}

/**
 * Return shared knowledge entries whose revalidation_due_at is in the past.
 */
export async function getStaleEntries(stateManager: StateManager): Promise<SharedKnowledgeEntry[]> {
  const all = await loadSharedEntries(stateManager);
  const now = new Date();

  return all.filter((entry) => {
    if (!entry.revalidation_due_at) {
      // No due date — consider stale based on stability interval from acquired_at
      const acquiredAt = new Date(entry.acquired_at);
      const intervalDays = REVALIDATION_SCHEDULE[entry.domain_stability];
      const dueAt = new Date(
        acquiredAt.getTime() + intervalDays * 24 * 60 * 60 * 1000
      );
      return now > dueAt;
    }
    return now > new Date(entry.revalidation_due_at);
  });
}

/**
 * Generate KnowledgeAcquisitionTask-style Task objects for each stale entry,
 * re-asking the original question.
 */
export async function generateRevalidationTasks(
  staleEntries: SharedKnowledgeEntry[]
): Promise<Task[]> {
  const tasks: Task[] = [];

  for (const entry of staleEntries) {
    const goalId = entry.source_goal_ids[0] ?? "shared";
    const taskId = randomUUID();
    const now = new Date().toISOString();

    const task = TaskSchema.parse({
      id: taskId,
      goal_id: goalId,
      strategy_id: null,
      target_dimensions: entry.tags,
      primary_dimension: entry.tags[0] ?? "knowledge",
      work_description: `Revalidate knowledge: ${entry.question}`,
      rationale: `Entry ${entry.entry_id} is stale (domain_stability: ${entry.domain_stability}, due: ${entry.revalidation_due_at ?? "overdue"})`,
      approach: `Re-research the following question and verify whether the answer has changed:\n${entry.question}\n\nPrevious answer: ${entry.answer}`,
      success_criteria: [
        {
          description: `Confirm or update answer to: "${entry.question}"`,
          verification_method: "Compare new answer to existing answer with cited sources",
          is_blocking: true,
        },
      ],
      scope_boundary: {
        in_scope: ["Information collection", "Web search", "Document reading"],
        out_of_scope: ["System modifications", "Code changes", "Data mutations"],
        blast_radius: "None — read-only revalidation task",
      },
      constraints: [
        "No system modifications allowed",
        `Original entry_id: ${entry.entry_id}`,
      ],
      reversibility: "reversible",
      estimated_duration: { value: 2, unit: "hours" },
      task_category: "knowledge_acquisition",
      status: "pending",
      created_at: now,
    });

    tasks.push(task);
  }

  return tasks;
}

/** Compute revalidation due date based on stability and a base date. */
export function computeRevalidationDue(base: Date, stability: DomainStability): string {
  const days = REVALIDATION_SCHEDULE[stability];
  const due = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  return due.toISOString();
}
