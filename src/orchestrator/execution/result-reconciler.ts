// ─── ResultReconciler ───
//
// Detects semantic contradictions between parallel subtask results using LLM.
// Fails open: on any LLM error, returns no contradictions with confidence 0.

import { z } from "zod";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { IPromptGateway } from "../../prompt/gateway.js";
import type { Logger } from "../../runtime/logger.js";
import type { SubtaskResult } from "./parallel-executor.js";

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

// ─── Pairwise Check ───

interface LLMContradictionItem {
  description: string;
  severity: string;
}

const ReconciliationResponseSchema = z.object({
  contradictions: z.array(z.object({
    description: z.string(),
    severity: z.string(),
  })),
});

async function checkPair(
  deps: ReconcilerDeps,
  resultA: SubtaskResult,
  resultB: SubtaskResult
): Promise<Contradiction[]> {
  const prompt = buildReconciliationPrompt(resultA, resultB);

  let parsed: { contradictions: LLMContradictionItem[] };
  if (deps.gateway) {
    try {
      parsed = await deps.gateway.execute({
        purpose: "result_reconciliation",
        additionalContext: { reconciliation_prompt: prompt },
        responseSchema: ReconciliationResponseSchema,
        maxTokens: 512,
        temperature: 0,
      });
    } catch {
      deps.logger?.warn("[ResultReconciler] gateway call failed", {
        taskAId: resultA.task_id,
        taskBId: resultB.task_id,
      });
      return [];
    }
  } else {
    const response = await deps.llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      { max_tokens: 512, temperature: 0 }
    );

    try {
      parsed = JSON.parse(response.content);
    } catch {
      deps.logger?.warn("[ResultReconciler] Failed to parse LLM response as JSON", {
        taskAId: resultA.task_id,
        taskBId: resultB.task_id,
      });
      return [];
    }
  }

  const items: LLMContradictionItem[] = Array.isArray(parsed?.contradictions)
    ? parsed.contradictions
    : [];

  const validSeverities = new Set(["critical", "warning", "info"]);

  return items
    .filter((c) => c.description && validSeverities.has(c.severity))
    .map((c) => ({
      task_a_id: resultA.task_id,
      task_b_id: resultB.task_id,
      description: c.description,
      severity: c.severity as Contradiction["severity"],
    }));
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
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const found = await checkPair(deps, results[i], results[j]);
        allContradictions.push(...found);
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    deps.logger?.warn("[ResultReconciler] LLM call failed, failing open", { error });
    return { has_contradictions: false, contradictions: [], confidence: 0.0 };
  }

  return {
    has_contradictions: allContradictions.length > 0,
    contradictions: allContradictions,
    confidence: 1.0,
  };
}
