import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { ObservationLogEntrySchema } from "../types/state.js";

const execFile = promisify(execFileCb);
import type { ObservationLogEntry } from "../types/state.js";
import type { ILLMClient } from "../llm/llm-client.js";
import { LLMObservationResponseSchema } from "./observation-helpers.js";
import type { ObservationEngineOptions } from "./observation-helpers.js";
import type { Logger } from "../runtime/logger.js";
import { wrapXmlTag, formatObservationHistory } from "../prompt/formatters.js";
import { OBSERVATION_SYSTEM_PROMPT } from "../prompt/purposes/observation.js";
import type { IPromptGateway } from "../prompt/gateway.js";

/**
 * Fetch a concise workspace context via git diff when no contextProvider is available.
 * Returns an empty string if git commands fail (e.g., not a git repo).
 *
 * Uses execFile (not exec/execSync) to avoid shell-injection risks and event-loop blocking.
 *
 * @param options   Engine options (may contain gitContextFetcher override).
 * @param maxChars  Maximum characters to return (default: 3000).
 */
export async function fetchGitDiffContext(options: ObservationEngineOptions, maxChars = 3000): Promise<string> {
  // Allow test injection via options
  if (options.gitContextFetcher) {
    return options.gitContextFetcher(maxChars);
  }

  const parts: string[] = [];

  try {
    const { stdout: stat } = await execFile("git", ["diff", "--stat"], { timeout: 10000, encoding: "utf8" });
    if (stat.trim()) {
      parts.push("[git diff --stat]");
      parts.push(stat.trim());
    }
  } catch {
    // not a git repo or git unavailable
  }

  try {
    const { stdout: diff } = await execFile("git", ["diff"], { timeout: 10000, encoding: "utf8" });
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
 * Infer the direction of change from a history of score values.
 */
function inferDirection(history: Array<{ value: number }>): string {
  if (history.length < 2) return "insufficient_data";
  const last = history[history.length - 1]!.value;
  const prev = history[history.length - 2]!.value;
  if (last > prev) return "improving";
  if (last < prev) return "declining";
  return "stable";
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
 * @param logger             Optional logger.
 * @param dimensionHistory   Optional history of prior observations for this dimension.
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
  logger?: Logger,
  dimensionHistory?: Array<{ value: number; timestamp?: string; date?: string }>,
  gateway?: IPromptGateway
): Promise<ObservationLogEntry> {
  logger?.info(
    `[ObservationEngine] LLM observation for dimension "${dimensionLabel}" (goal: ${goalId})`
  );

  // Resolve workspace context: use provided context, fall back to git diff, or warn.
  let resolvedContext = workspaceContext;
  if (!resolvedContext || resolvedContext.trim().length === 0) {
    const gitCtx = await fetchGitDiffContext(options, 3000);
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

  // Build optional observation history block
  let historyBlock = "";
  if (dimensionHistory && dimensionHistory.length > 0) {
    const direction = inferDirection(dimensionHistory);
    historyBlock = wrapXmlTag(
      "observation_history",
      formatObservationHistory(
        dimensionHistory.map((h) => ({
          timestamp: h.timestamp ?? h.date ?? "",
          score: h.value,
        })),
        direction
      )
    );
  }

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
    (historyBlock ? `${historyBlock}\n\n` : "") +
    `FEW-SHOT CALIBRATION:\n` +
    `- Context: grep shows 0 unfinished item matches → {"score": 1.0, "reason": "No unfinished items; target achieved"}\n` +
    `- Context: grep shows 3 matches: src/foo.ts:42: unfinished item fix this → {"score": 0.0, "reason": "3 unfinished items remain"}\n\n` +
    `WORKSPACE CONTENT:\n` +
    `${contextContent}\n\n` +
    `Score now based strictly on the above content.`;

  let parsed: { score: number; reason: string };
  if (gateway) {
    try {
      parsed = await gateway.execute({
        purpose: "observation",
        goalId,
        dimensionName,
        additionalContext: { observation_prompt: prompt },
        responseSchema: LLMObservationResponseSchema,
        maxTokens: 512,
        temperature: 0,
      });
    } catch (err) {
      // Fallback to direct LLM call if gateway fails
      logger?.warn(`[ObservationEngine] PromptGateway failed for "${dimensionLabel}", falling back to direct LLM: ${String(err)}`);
      const response = await llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { system: OBSERVATION_SYSTEM_PROMPT, max_tokens: 512, temperature: 0, model_tier: 'light' }
      );
      parsed = llmClient.parseJSON(response.content, LLMObservationResponseSchema);
    }
  } else {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      { system: OBSERVATION_SYSTEM_PROMPT, max_tokens: 512, temperature: 0, model_tier: 'light' }
    );
    parsed = llmClient.parseJSON(response.content, LLMObservationResponseSchema);
  }

  // P0: Score-evidence consistency check (§4.3)
  // If no evidence (no context, no git diff), LLM score > 0.0 is unreliable.
  // Skip this check in dryRun (cross-validation) mode — the caller needs the
  // raw LLM score to compare against the mechanical value.
  let score = parsed.score;
  if (!hasContext && score > 0.0 && !dryRun) {
    logger?.warn(
      `score overridden to 0.0 (no evidence available, LLM returned ${score})`
    );
    score = 0.0;
  }

  // §3.3: Observation score jump suppression (±0.4/cycle)
  // When no mechanical source is available and the LLM score jumps more than 0.4
  // from the previous score, suppress the change and lower confidence.
  const MAX_SCORE_DELTA = 0.4;
  let resolvedConfidence = !hasContext ? 0.1 : 0.70;
  if (
    typeof previousScore === "number" &&
    previousScore !== null &&
    Math.abs(score - previousScore) > MAX_SCORE_DELTA
  ) {
    const delta = Math.abs(score - previousScore);
    logger?.warn(
      `WARN: observation score jump suppressed: prev=${previousScore.toFixed(3)}, proposed=${score.toFixed(3)}, delta=${delta.toFixed(3)}`
    );
    score = previousScore;
    resolvedConfidence = 0.3;
  }

  logger?.info(
    `[ObservationEngine] LLM observation result for "${dimensionLabel}": score=${score.toFixed(3)}`
  );

  // Scale LLM 0-1 score to threshold's native scale for min/max types.
  // LLM returns 0.0-1.0 (normalized), but gap-calculator expects the raw
  // value in the threshold's scale (e.g., min:5 expects value >= 5).
  let extractedValue: number = score;
  try {
    const threshold = JSON.parse(thresholdDescription);
    if (threshold.type === "min" && typeof threshold.value === "number" && threshold.value > 1) {
      extractedValue = score * threshold.value;
      const clampMax = threshold.value * 2;
      if (extractedValue > clampMax) {
        logger?.warn(
          `WARN: extractedValue clamped for min threshold: raw=${extractedValue.toFixed(3)}, clampMax=${clampMax}, threshold=${threshold.value}`
        );
        extractedValue = clampMax;
      } else if (extractedValue > threshold.value * 1.5) {
        logger?.warn(
          `WARN: extractedValue suspiciously high for min threshold: value=${extractedValue.toFixed(3)}, threshold=${threshold.value}`
        );
      }
    } else if (threshold.type === "max" && typeof threshold.value === "number" && threshold.value > 1) {
      // Invert: score=1.0 means current is AT the max (gap=0); score=0.0 means far above max.
      // formula: value = threshold * (2 - score)
      // score=1.0 → threshold (exactly at max, gap=0)
      // score=0.0 → 2*threshold (double the max, clearly not met)
      extractedValue = threshold.value * (2 - score);
      const clampMax = threshold.value * 2;
      if (extractedValue > clampMax) {
        logger?.warn(
          `WARN: extractedValue clamped for max threshold: raw=${extractedValue.toFixed(3)}, clampMax=${clampMax}, threshold=${threshold.value}`
        );
        extractedValue = clampMax;
      } else if (extractedValue > threshold.value * 1.5) {
        logger?.warn(
          `WARN: extractedValue suspiciously high for max threshold: value=${extractedValue.toFixed(3)}, threshold=${threshold.value}`
        );
      }
    }
  } catch { /* keep original score if threshold parsing fails */ }

  const entry = ObservationLogEntrySchema.parse({
    observation_id: randomUUID(),
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
    raw_result: { score, reason: parsed.reason },
    extracted_value: extractedValue,
    confidence: resolvedConfidence,
    notes: `LLM evaluation: ${parsed.reason}`,
  });

  if (!dryRun) {
    try {
      await applyObservation(goalId, entry);
    } catch (persistErr) {
      // Persistence failed (e.g., dimension name mismatch in applyObservation).
      // Wrap the error with the successfully-observed entry so callers can
      // recover the LLM score rather than silently falling back to null.
      throw new ObservationPersistenceError(
        `Failed to persist LLM observation for dimension "${dimensionName}": ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
        entry,
        persistErr instanceof Error ? persistErr : new Error(String(persistErr))
      );
    }
  }

  return entry;
}

/**
 * Thrown when the LLM observation succeeded but persistence (applyObservation) failed.
 * Carries the successfully-observed entry so callers can recover the value.
 */
export class ObservationPersistenceError extends Error {
  constructor(
    message: string,
    public readonly entry: ObservationLogEntry,
    public readonly cause: Error
  ) {
    super(message);
    this.name = "ObservationPersistenceError";
  }
}
