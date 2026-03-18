import { execFileSync } from "child_process";
import { ObservationLogEntrySchema } from "../types/state.js";
import type { ObservationLogEntry } from "../types/state.js";
import type { ILLMClient } from "../llm/llm-client.js";
import { LLMObservationResponseSchema } from "./observation-helpers.js";
import type { ObservationEngineOptions } from "./observation-helpers.js";
import type { Logger } from "../runtime/logger.js";

/**
 * Fetch a concise workspace context via git diff when no contextProvider is available.
 * Returns an empty string if git commands fail (e.g., not a git repo).
 *
 * Uses execFileSync (not exec/execSync) to avoid shell-injection risks.
 *
 * @param options   Engine options (may contain gitContextFetcher override).
 * @param maxChars  Maximum characters to return (default: 3000).
 */
export function fetchGitDiffContext(options: ObservationEngineOptions, maxChars = 3000): string {
  // Allow test injection via options
  if (options.gitContextFetcher) {
    return options.gitContextFetcher(maxChars);
  }

  const parts: string[] = [];

  try {
    const stat = execFileSync("git", ["diff", "--stat"], { timeout: 10000, encoding: "utf8" });
    if (stat.trim()) {
      parts.push("[git diff --stat]");
      parts.push(stat.trim());
    }
  } catch {
    // not a git repo or git unavailable
  }

  try {
    const diff = execFileSync("git", ["diff"], { timeout: 10000, encoding: "utf8" });
    if (diff.trim()) {
      parts.push("[git diff]");
      // Reserve space: subtract what we've already accumulated
      const alreadyUsed = parts.join("\n\n").length;
      const remaining = Math.max(0, maxChars - alreadyUsed - 20); // 20 for separator
      const truncated = diff.length > remaining ? diff.slice(0, remaining) + "\n...(truncated)" : diff;
      parts.push(truncated.trim());
    }
  } catch {
    // ignore
  }

  return parts.join("\n\n");
}

/**
 * Observe a goal dimension using the LLM client.
 *
 * The LLM is asked to score the dimension from 0.0 to 1.0.
 * The score is used as extractedValue, and confidence is fixed at 0.70
 * (middle of the independent_review range [0.50, 0.84]).
 *
 * If workspaceContext is not provided, a git diff fallback is attempted
 * so the LLM has actual evidence to evaluate. If that also fails,
 * the prompt includes an explicit warning and the LLM must score 0.0.
 *
 * @param goalId             The goal being observed.
 * @param dimensionName      The dimension name (snake_case).
 * @param goalDescription    Human-readable goal description.
 * @param dimensionLabel     Human-readable dimension label.
 * @param thresholdDescription  JSON-stringified threshold for context.
 * @param llmClient          The LLM client to use.
 * @param options            Engine options (for git diff fallback).
 * @param applyObservation   Callback to persist the entry (skipped if dryRun).
 * @param workspaceContext   Optional pre-fetched workspace context.
 * @param previousScore      Previous observed score for trend context.
 * @param dryRun             If true, do not write to state.
 */
export async function observeWithLLM(
  goalId: string,
  dimensionName: string,
  goalDescription: string,
  dimensionLabel: string,
  thresholdDescription: string,
  llmClient: ILLMClient,
  options: ObservationEngineOptions,
  applyObservation: (goalId: string, entry: ObservationLogEntry) => void,
  workspaceContext?: string,
  previousScore?: number | null,
  dryRun?: boolean,
  logger?: Logger
): Promise<ObservationLogEntry> {
  logger?.info(
    `[ObservationEngine] LLM observation for dimension "${dimensionLabel}" (goal: ${goalId})`
  );

  // Resolve workspace context: use provided context, fall back to git diff, or warn.
  let resolvedContext = workspaceContext;
  if (!resolvedContext || resolvedContext.trim().length === 0) {
    const gitCtx = fetchGitDiffContext(options, 3000);
    if (gitCtx.trim().length > 0) {
      resolvedContext = gitCtx;
      logger?.info(
        `[ObservationEngine] No contextProvider output — using git diff fallback for "${dimensionLabel}"`
      );
    }
  }

  // Truncate to 4000 chars max to avoid token waste
  const MAX_CONTEXT_CHARS = 4000;
  if (resolvedContext && resolvedContext.length > MAX_CONTEXT_CHARS) {
    resolvedContext = resolvedContext.slice(0, MAX_CONTEXT_CHARS) + "\n...(truncated)";
  }

  const hasContext = !!resolvedContext && resolvedContext.trim().length > 0;

  const previousScoreText =
    previousScore !== undefined && previousScore !== null
      ? previousScore.toFixed(2)
      : "none";

  const contextContent = hasContext
    ? resolvedContext!
    : "WARNING: No workspace content was provided. Score MUST be 0.0 per Rule 2.";

  const prompt =
    `Score a goal dimension 0.0 (not achieved) to 1.0 (fully achieved).\n\n` +
    `CRITICAL RULES:\n` +
    `1. Use ONLY the evidence below. Do not invent or assume.\n` +
    `2. If no workspace content is provided, score MUST be 0.0.\n` +
    `3. Return ONLY valid JSON: {"score": <0.0-1.0>, "reason": "<one sentence>"}\n\n` +
    `Goal: ${goalDescription}\n` +
    `Dimension: ${dimensionLabel}\n` +
    `Target: ${thresholdDescription}\n` +
    `Previous score: ${previousScoreText}\n\n` +
    `FEW-SHOT CALIBRATION:\n` +
    `- Context: grep shows 0 TODO matches → {"score": 1.0, "reason": "No TODOs; target achieved"}\n` +
    `- Context: grep shows 3 matches: src/foo.ts:42: TODO fix this → {"score": 0.0, "reason": "3 TODOs remain"}\n\n` +
    `WORKSPACE CONTENT:\n` +
    `${contextContent}\n\n` +
    `Score now based strictly on the above content.`;

  const response = await llmClient.sendMessage([
    { role: "user", content: prompt },
  ]);

  const parsed = llmClient.parseJSON(response.content, LLMObservationResponseSchema);

  logger?.info(
    `[ObservationEngine] LLM observation result for "${dimensionLabel}": score=${parsed.score.toFixed(3)}`
  );

  // Scale LLM 0-1 score to threshold's native scale for min/max types.
  // LLM returns 0.0-1.0 (normalized), but gap-calculator expects the raw
  // value in the threshold's scale (e.g., min:5 expects value >= 5).
  let extractedValue: number = parsed.score;
  try {
    const threshold = JSON.parse(thresholdDescription);
    if (threshold.type === "min" && typeof threshold.value === "number" && threshold.value > 1) {
      extractedValue = parsed.score * threshold.value;
    } else if (threshold.type === "max" && typeof threshold.value === "number" && threshold.value > 1) {
      extractedValue = parsed.score * threshold.value;
    }
  } catch { /* keep original score if threshold parsing fails */ }

  const entry = ObservationLogEntrySchema.parse({
    observation_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    trigger: "periodic",
    goal_id: goalId,
    dimension_name: dimensionName,
    layer: "independent_review",
    method: {
      type: "llm_review",
      source: "llm",
      schedule: null,
      endpoint: null,
      confidence_tier: "independent_review",
    },
    raw_result: { score: parsed.score, reason: parsed.reason },
    extracted_value: extractedValue,
    confidence: 0.70,
    notes: `LLM evaluation: ${parsed.reason}`,
  });

  if (!dryRun) {
    await applyObservation(goalId, entry);
  }

  return entry;
}
