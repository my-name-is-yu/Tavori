import { z } from "zod";
import type { Task } from "../../../base/types/task.js";
import type { AgentResult } from "../adapter-layer.js";
import type { Logger } from "../../../runtime/logger.js";
import type { LLMResponse } from "../../../base/llm/llm-client.js";
import type { VerifierDeps } from "./task-verifier-types.js";
import { CompletionJudgerResponseSchema } from "./task-verifier-types.js";

// ─── withTimeout ───

/**
 * Wrap a promise with a timeout. Rejects with a TimeoutError if the promise
 * does not resolve within `ms` milliseconds.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`completion_judger timeout after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// ─── withRetry ───

/**
 * Call an async function with retry + exponential backoff.
 * On each failure (including timeout), wait `backoffMs * 2^attempt` before retrying.
 * After `maxRetries` retries, the last error is re-thrown.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  backoffMs: number,
  logger?: Logger,
  label?: string
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = backoffMs * Math.pow(2, attempt);
        const msg = err instanceof Error ? err.message : String(err);
        logger?.warn(`[completion_judger] ${label ?? "LLM call"} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${msg} — retrying in ${delay}ms`);
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }
  throw lastErr;
}

// ─── runLLMReview ───

export async function runLLMReview(
  deps: VerifierDeps,
  task: Task,
  executionResult: AgentResult,
  knowledgeBlock = "",
  stateBlock = "",
  modelTier: 'main' | 'light' = 'light'
): Promise<{ passed: boolean; partial: boolean; description: string; confidence: number; criteria_met?: number; criteria_total?: number; tokensUsed: number }> {
  const timeoutMs = deps.completionJudgerConfig?.timeoutMs ?? 30_000;
  const maxRetries = deps.completionJudgerConfig?.maxRetries ?? 2;
  const retryBackoffMs = deps.completionJudgerConfig?.retryBackoffMs ?? 1_000;

  // Create review session
  const reviewSession = await deps.sessionManager.createSession(
    "task_review",
    task.goal_id,
    task.id
  );

  // Build review context (excludes executor self-report for bias prevention)
  const reviewContext = deps.sessionManager.buildTaskReviewContext(
    task.goal_id,
    task.id
  );

  const criteriaList = task.success_criteria
    .map(
      (c, i) =>
        `${i + 1}. ${c.description} (blocking: ${c.is_blocking}, method: ${c.verification_method})`
    )
    .join("\n");

  const enrichmentBlocks = [knowledgeBlock, stateBlock].filter(Boolean).join("\n");

  const prompt = `Evaluate task execution against success criteria.

Task: ${task.work_description}
Approach: ${task.approach}

Criteria:
${criteriaList}
${enrichmentBlocks ? `\n${enrichmentBlocks}\n` : ""}
Output (first 2000 chars):
${executionResult.output.slice(0, 2000)}

Status: ${executionResult.stopped_reason} | Success: ${executionResult.success}
Context: ${reviewContext.map((s) => s.content).join(" ")}

Return JSON:
{"verdict": "pass"|"partial"|"fail", "reasoning": "...", "criteria_met": #, "criteria_total": #}`;

  // Gateway path: route through PromptGateway when available
  if (deps.gateway) {
    let parsed: z.infer<typeof CompletionJudgerResponseSchema>;
    try {
      parsed = await withRetry(
        () => withTimeout(
          deps.gateway!.execute({
            purpose: "verification",
            goalId: task.goal_id,
            additionalContext: { review_prompt: prompt },
            responseSchema: CompletionJudgerResponseSchema as z.ZodSchema<z.infer<typeof CompletionJudgerResponseSchema>>,
            maxTokens: 1024,
          }),
          timeoutMs
        ),
        maxRetries,
        retryBackoffMs,
        deps.logger,
        `completion_judger for task ${task.id}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.logger?.error(`[completion_judger] All retries exhausted for task ${task.id}: ${msg}`);
      await deps.sessionManager.endSession(reviewSession.id, `completion_judger failed: ${msg}`);
      return {
        passed: false,
        partial: false,
        description: `completion_judger failed after ${maxRetries + 1} attempt(s): ${msg}`,
        confidence: 0.0,
        tokensUsed: 0,
      };
    }
    const verdictStr = parsed.verdict;
    const result = {
      passed: verdictStr === "pass",
      partial: verdictStr === "partial",
      description: parsed.reasoning || "LLM review completed",
      confidence: verdictStr === "pass" ? 0.8 : verdictStr === "partial" ? 0.6 : 0.8,
      criteria_met: parsed.criteria_met,
      criteria_total: parsed.criteria_total,
      tokensUsed: 0, // TODO: PromptGateway does not expose usage data
    };
    await deps.sessionManager.endSession(reviewSession.id, `LLM review: ${verdictStr}`);
    return result;
  }

  // Direct LLM path (fallback when no gateway)
  let response: LLMResponse;
  try {
    response = await withRetry(
      () => withTimeout(
        (deps.reviewerLlmClient ?? deps.llmClient).sendMessage(
          [{ role: "user", content: prompt }],
          {
            system: "Review task results objectively against criteria. Ignore executor self-assessment.",
            max_tokens: 1024,
            model_tier: modelTier,
          }
        ),
        timeoutMs
      ),
      maxRetries,
      retryBackoffMs,
      deps.logger,
      `completion_judger for task ${task.id}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger?.error(`[completion_judger] All retries exhausted for task ${task.id}: ${msg}`);
    await deps.sessionManager.endSession(reviewSession.id, `completion_judger failed: ${msg}`);
    return {
      passed: false,
      partial: false,
      description: `completion_judger failed after ${maxRetries + 1} attempt(s): ${msg}`,
      confidence: 0.0,
      tokensUsed: 0,
    };
  }

  const verifierTokens = response.usage ? (response.usage.input_tokens + response.usage.output_tokens) : 0;
  try {
    const rawJson = response.content.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    const parseResult = CompletionJudgerResponseSchema.safeParse(JSON.parse(rawJson));
    if (!parseResult.success) {
      deps.logger?.warn(`[completion_judger] Zod parse failed for task ${task.id}: ${parseResult.error.message}`);
      await deps.sessionManager.endSession(reviewSession.id, "Failed to parse LLM review result");
      return {
        passed: false,
        partial: false,
        description: "Failed to parse LLM review result",
        confidence: 0.3,
        tokensUsed: verifierTokens,
      };
    }
    const parsed = parseResult.data;
    const verdictStr = parsed.verdict;
    const result = {
      passed: verdictStr === "pass",
      partial: verdictStr === "partial",
      description: parsed.reasoning || "LLM review completed",
      confidence: verdictStr === "pass" ? 0.8 : verdictStr === "partial" ? 0.6 : 0.8,
      criteria_met: parsed.criteria_met,
      criteria_total: parsed.criteria_total,
      tokensUsed: verifierTokens,
    };
    await deps.sessionManager.endSession(reviewSession.id, `LLM review: ${verdictStr}`);
    return result;
  } catch {
    deps.logger?.warn(`[completion_judger] JSON.parse failed for task ${task.id}`);
    await deps.sessionManager.endSession(reviewSession.id, "Failed to parse LLM review result");
    return {
      passed: false,
      partial: false,
      description: "Failed to parse LLM review result",
      confidence: 0.3,
      tokensUsed: verifierTokens,
    };
  }
}
