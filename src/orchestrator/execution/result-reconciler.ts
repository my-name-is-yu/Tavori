// ─── ResultReconciler ───
//
// Detects semantic contradictions between parallel subtask results using LLM.
// Fails open: on any LLM error, returns no contradictions with confidence 0.

import { z } from "zod";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { IPromptGateway } from "../../prompt/gateway.js";
import { RESULT_RECONCILIATION_SYSTEM_PROMPT } from "../../prompt/purposes/final-migration.js";
import type { Logger } from "../../runtime/logger.js";
import type { SubtaskResult } from "./parallel-execution-types.js";

// ─── Types ───

export interface Contradiction {
  task_a_id: string;
  task_b_id: string;
  description: string;
  severity: "critical" | "warning" | "info";
}

export interface ContradictionReport {
  has_contradictions: boolean;
  contradictions: Contradiction[];
  confidence: number; // 0-1
}

// ─── Deps ───

export interface ReconcilerDeps {
  llmClient: ILLMClient;
  logger?: Logger;
  gateway?: IPromptGateway;
}

// ─── Prompt Builder ───

export function buildReconciliationPrompt(
  resultA: SubtaskResult,
  resultB: SubtaskResult
): string {
  return `You are a contradiction detector for parallel agent task outputs.

Compare these two task outputs and identify any semantic contradictions — cases where
the outputs conflict, produce incompatible changes, or make inconsistent assumptions.

Task A (id: ${resultA.task_id}, verdict: ${resultA.verdict}):
${resultA.output || "(no output)"}

Task B (id: ${resultB.task_id}, verdict: ${resultB.verdict}):
${resultB.output || "(no output)"}

Respond with JSON only (no markdown):
{
  "contradictions": [
    {
      "description": "brief description of the contradiction",
      "severity": "critical" | "warning" | "info"
    }
  ]
}

If there are no contradictions, return: { "contradictions": [] }`;
}

interface LLMContradictionItem {
  task_a_id: string;
  task_b_id: string;
  description: string;
  severity: string;
}

const ReconciliationResponseSchema = z.object({
  contradictions: z.unknown().transform((value) => (Array.isArray(value) ? value : [])),
});

function serializeResults(results: SubtaskResult[]): string {
  return JSON.stringify(
    results.map((result) => ({
      task_id: result.task_id,
      verdict: result.verdict,
      output: result.output || "(no output)",
    })),
    null,
    2
  );
}

function buildBatchReconciliationPrompt(results: SubtaskResult[]): string {
  return `Review these parallel task results and identify every semantic contradiction between any pair of tasks.

Task results:
${serializeResults(results)}

Return JSON only (no markdown) with this shape:
{
  "contradictions": [
    {
      "task_a_id": "task-1",
      "task_b_id": "task-2",
      "description": "brief description of the contradiction",
      "severity": "critical" | "warning" | "info"
    }
  ]
}

Use only task IDs that appear in the input. If there are no contradictions, return: { "contradictions": [] }`;
}

// ─── Main Export ───

export async function reconcileResults(
  deps: ReconcilerDeps,
  results: SubtaskResult[]
): Promise<ContradictionReport> {
  if (results.length <= 1) {
    return { has_contradictions: false, contradictions: [], confidence: 1.0 };
  }

  const allContradictions: Contradiction[] = [];

  try {
    const prompt = buildBatchReconciliationPrompt(results);
    const parsed = deps.gateway
      ? await deps.gateway.execute({
          purpose: "result_reconciliation",
          additionalContext: { recentTaskResults: prompt },
          responseSchema: ReconciliationResponseSchema,
          maxTokens: 512,
          temperature: 0,
        })
      : await deps.llmClient.parseJSON(
          (
            await deps.llmClient.sendMessage(
              [{ role: "user", content: prompt }],
              {
                system: RESULT_RECONCILIATION_SYSTEM_PROMPT,
                max_tokens: 512,
                temperature: 0,
              }
            )
          ).content,
          ReconciliationResponseSchema
        );

    const validTaskIds = new Set(results.map((result) => result.task_id));
    const validSeverities = new Set(["critical", "warning", "info"]);
    const seen = new Set<string>();

    const rawContradictions = Array.isArray(parsed.contradictions)
      ? parsed.contradictions
      : [];

    for (const rawContradiction of rawContradictions) {
      if (!rawContradiction || typeof rawContradiction !== "object") {
        continue;
      }

      const contradiction = rawContradiction as Partial<LLMContradictionItem>;
      if (
        typeof contradiction.task_a_id !== "string" ||
        typeof contradiction.task_b_id !== "string" ||
        typeof contradiction.description !== "string" ||
        typeof contradiction.severity !== "string" ||
        !validTaskIds.has(contradiction.task_a_id) ||
        !validTaskIds.has(contradiction.task_b_id) ||
        contradiction.task_a_id === contradiction.task_b_id ||
        !validSeverities.has(contradiction.severity) ||
        !contradiction.description
      ) {
        continue;
      }

      const taskIds = [contradiction.task_a_id, contradiction.task_b_id].sort();
      const key = [
        taskIds[0],
        taskIds[1],
        contradiction.severity,
        contradiction.description,
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);

      allContradictions.push({
        task_a_id: contradiction.task_a_id,
        task_b_id: contradiction.task_b_id,
        description: contradiction.description,
        severity: contradiction.severity as Contradiction["severity"],
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    deps.logger?.warn("[ResultReconciler] reconciliation call failed, failing open", { error });
    return { has_contradictions: false, contradictions: [], confidence: 0.0 };
  }

  return {
    has_contradictions: allContradictions.length > 0,
    contradictions: allContradictions,
    confidence: 1.0,
  };
}
