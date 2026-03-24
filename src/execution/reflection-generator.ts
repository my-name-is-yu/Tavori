import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ReflectionNoteSchema, type ReflectionNote } from "../types/reflection.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { Task } from "../types/task.js";
import type { VerificationResult } from "../types/task.js";
import type { KnowledgeManager } from "../knowledge/knowledge-manager.js";
import type { KnowledgeEntry } from "../types/knowledge.js";
import { extractJSON } from "../llm/llm-client.js";
import type { IPromptGateway } from "../prompt/gateway.js";

interface ReflectionLogger {
  debug?: (message: string, context?: Record<string, unknown>) => void;
  warn?: (message: string, context?: Record<string, unknown>) => void;
}

const LLMReflectionSchema = z.object({
  what_was_attempted: z.string(),
  outcome: z.enum(["success", "partial", "fail"]),
  why_it_worked_or_failed: z.string(),
  what_to_do_differently: z.string(),
});

function mapVerdict(verdict: string): "success" | "partial" | "fail" {
  if (verdict === "pass") return "success";
  if (verdict === "partial") return "partial";
  return "fail";
}

function mapVerdictToConfidence(verdict: string): number {
  if (verdict === "pass") return 0.9;
  if (verdict === "partial") return 0.6;
  return 0.3;
}

// --- generateReflection ---

export async function generateReflection(params: {
  task: Task;
  verificationResult: VerificationResult;
  goalId: string;
  strategyId?: string;
  llmClient: ILLMClient;
  logger?: ReflectionLogger;
  gateway?: IPromptGateway;
}): Promise<ReflectionNote> {
  const { task, verificationResult, goalId, strategyId, llmClient, logger, gateway } = params;

  const prompt = `You are analyzing the result of an AI agent task execution. Generate a structured reflection.

Task: ${task.work_description}
Verdict: ${verificationResult.verdict}
Confidence: ${verificationResult.confidence}
Evidence: ${verificationResult.evidence.map((e) => e.description).join("; ")}

Respond with JSON only:
{
  "what_was_attempted": "brief description of what was done",
  "outcome": "${mapVerdict(verificationResult.verdict)}",
  "why_it_worked_or_failed": "root cause analysis",
  "what_to_do_differently": "actionable improvement for next time"
}`;

  try {
    let parsed: z.infer<typeof LLMReflectionSchema>;
    if (gateway) {
      parsed = await gateway.execute({
        purpose: "reflection_generation",
        goalId,
        additionalContext: { prompt },
        responseSchema: LLMReflectionSchema,
        maxTokens: 512,
      });
    } else {
      const response = await llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { max_tokens: 512, model_tier: 'light' }
      );
      const jsonText = extractJSON(response.content);
      const raw = JSON.parse(jsonText) as unknown;
      parsed = LLMReflectionSchema.parse(raw);
    }

    return ReflectionNoteSchema.parse({
      reflection_id: randomUUID(),
      goal_id: goalId,
      strategy_id: strategyId ?? null,
      task_id: task.id,
      what_was_attempted: parsed.what_was_attempted,
      outcome: parsed.outcome,
      why_it_worked_or_failed: parsed.why_it_worked_or_failed,
      what_to_do_differently: parsed.what_to_do_differently,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    logger?.warn?.("generateReflection: LLM parse failed, using fallback", { error: String(err) });
    return ReflectionNoteSchema.parse({
      reflection_id: randomUUID(),
      goal_id: goalId,
      strategy_id: strategyId ?? null,
      task_id: task.id,
      what_was_attempted: task.work_description,
      outcome: mapVerdict(verificationResult.verdict),
      why_it_worked_or_failed: "Analysis unavailable",
      what_to_do_differently: "Review task and retry",
      created_at: new Date().toISOString(),
    });
  }
}

// --- saveReflectionAsKnowledge ---

export async function saveReflectionAsKnowledge(
  knowledgeManager: KnowledgeManager,
  goalId: string,
  reflection: ReflectionNote,
  taskDescription: string,
): Promise<void> {
  const tags = ["reflection", `goal:${goalId}`];
  if (reflection.strategy_id) {
    tags.push(`strategy:${reflection.strategy_id}`);
  }

  const entry: KnowledgeEntry = {
    entry_id: randomUUID(),
    question: `Reflection: ${taskDescription}`,
    answer: JSON.stringify({
      what_was_attempted: reflection.what_was_attempted,
      outcome: reflection.outcome,
      why_it_worked_or_failed: reflection.why_it_worked_or_failed,
      what_to_do_differently: reflection.what_to_do_differently,
    }),
    sources: [],
    confidence: mapVerdictToConfidence(reflection.outcome === "success" ? "pass" : reflection.outcome),
    acquired_at: reflection.created_at,
    acquisition_task_id: reflection.task_id,
    superseded_by: null,
    tags,
    embedding_id: null,
  };

  await knowledgeManager.saveKnowledge(goalId, entry);
}

// --- getReflectionsForGoal ---

export async function getReflectionsForGoal(
  knowledgeManager: KnowledgeManager,
  goalId: string,
  limit = 5,
): Promise<ReflectionNote[]> {
  const entries = await knowledgeManager.loadKnowledge(goalId, ["reflection"]);

  const reflections: ReflectionNote[] = [];
  for (const entry of entries) {
    try {
      const raw = JSON.parse(entry.answer) as unknown;
      const note = ReflectionNoteSchema.parse({
        reflection_id: entry.entry_id,
        goal_id: goalId,
        strategy_id: null,
        task_id: entry.acquisition_task_id,
        ...(raw as object),
        created_at: entry.acquired_at,
      });
      reflections.push(note);
    } catch {
      // skip malformed entries
    }
  }

  return reflections
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

// --- formatReflectionsForPrompt ---

export function formatReflectionsForPrompt(reflections: ReflectionNote[]): string {
  if (reflections.length === 0) return "";

  const lines = reflections.map(
    (r) => `- [${r.outcome}] Attempted: ${r.what_was_attempted} → Why: ${r.why_it_worked_or_failed} → Next time: ${r.what_to_do_differently}`
  );

  return "## Past Reflections (learn from these)\n" + lines.join("\n");
}
