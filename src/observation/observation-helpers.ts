import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ObservationLogEntrySchema, ObservationLogSchema } from "../types/state.js";
import type { ObservationLogEntry, ObservationLog } from "../types/state.js";
import type { ObservationLayer, ObservationMethod, ObservationTrigger, ConfidenceTier } from "../types/core.js";
import { KnowledgeGapSignalSchema } from "../types/knowledge.js";
import type { KnowledgeGapSignal } from "../types/knowledge.js";
import type { VectorIndex } from "../knowledge/vector-index.js";
import type { Logger } from "../runtime/logger.js";

// ─── Options ───

export interface ObservationEngineOptions {
  crossValidationEnabled?: boolean; // default: false
  divergenceThreshold?: number;     // default: 0.20
  /** Injectable override for git diff context (used in tests). */
  gitContextFetcher?: (maxChars: number) => string | Promise<string>;
  /** Optional VectorIndex for indexing dimension names after observation. */
  vectorIndex?: VectorIndex;
}

// ─── Cross-Validation Result ───

export interface CrossValidationResult {
  dimensionName: string;
  mechanicalValue: number;
  llmValue: number;
  diverged: boolean;
  divergenceRatio: number;
  resolution: "mechanical_wins";
}

// ─── Layer Configuration ───

interface LayerConfig {
  ceiling: number;
  tier: ConfidenceTier;
  range: [number, number];
}

export const LAYER_CONFIG: Record<ObservationLayer, LayerConfig> = {
  mechanical: {
    ceiling: 1.0,
    tier: "mechanical",
    range: [0.85, 1.0],
  },
  independent_review: {
    ceiling: 0.90,
    tier: "independent_review",
    range: [0.50, 0.84],
  },
  self_report: {
    ceiling: 0.70,
    tier: "self_report",
    range: [0.10, 0.49],
  },
};

// ─── Layer Priority ───

export const LAYER_PRIORITY: Record<ObservationLayer, number> = {
  mechanical: 3,
  independent_review: 2,
  self_report: 1,
};

// Zod schema for LLM observation response
export const LLMObservationResponseSchema = z.object({
  score: z.number().min(0).max(1),
  reason: z.string(),
});

// ─── Pure Helper Functions ───

/**
 * Apply progress ceiling based on observation layer.
 * Returns min(progress, ceiling).
 */
export function applyProgressCeiling(progress: number, layer: ObservationLayer): number {
  const config = LAYER_CONFIG[layer];
  return Math.min(progress, config.ceiling);
}

/**
 * Return the ConfidenceTier and valid confidence range for a given layer.
 */
export function getConfidenceTier(layer: ObservationLayer): { tier: ConfidenceTier; range: [number, number] } {
  const config = LAYER_CONFIG[layer];
  return { tier: config.tier, range: config.range };
}

/**
 * Construct a new ObservationLogEntry.
 * Confidence is clamped to the layer's valid range.
 */
export function createObservationEntry(params: {
  goalId: string;
  dimensionName: string;
  layer: ObservationLayer;
  method: ObservationMethod;
  trigger: ObservationTrigger;
  rawResult: unknown;
  extractedValue: number | string | boolean | null;
  confidence: number;
  notes?: string;
}): ObservationLogEntry {
  const config = LAYER_CONFIG[params.layer];
  const [minConf, maxConf] = config.range;
  const clampedConfidence = Math.min(maxConf, Math.max(minConf, params.confidence));

  const entry = ObservationLogEntrySchema.parse({
    observation_id: randomUUID(),
    timestamp: new Date().toISOString(),
    trigger: params.trigger,
    goal_id: params.goalId,
    dimension_name: params.dimensionName,
    layer: params.layer,
    method: params.method,
    raw_result: params.rawResult,
    extracted_value: params.extractedValue,
    confidence: clampedConfidence,
    notes: params.notes ?? null,
  });

  return entry;
}

/**
 * Returns true when effective progress meets the threshold but confidence
 * is below 0.85, meaning a mechanical verification task should be generated.
 */
export function needsVerificationTask(effectiveProgress: number, confidence: number, threshold: number): boolean {
  return effectiveProgress >= threshold && confidence < 0.85;
}

/**
 * Resolve contradictions among multiple observation entries.
 *
 * Resolution rules:
 *   1. Higher-priority layer wins (mechanical > independent_review > self_report).
 *   2. Within the same layer, take the pessimistic (lower) numeric value.
 *   3. For non-numeric values, take the first entry in the winning layer.
 *
 * Returns the single "winning" entry.
 * Throws if entries array is empty.
 */
export function resolveContradiction(entries: ObservationLogEntry[]): ObservationLogEntry {
  if (entries.length === 0) {
    throw new Error("resolveContradiction: entries array must not be empty");
  }
  if (entries.length === 1) {
    return entries[0]!;
  }

  // Find highest priority layer present
  let maxPriority = -1;
  for (const entry of entries) {
    const priority = LAYER_PRIORITY[entry.layer];
    if (priority > maxPriority) {
      maxPriority = priority;
    }
  }

  // Collect all entries at the winning layer
  const winningLayer = entries.filter(
    (e) => LAYER_PRIORITY[e.layer] === maxPriority
  );

  if (winningLayer.length === 1) {
    return winningLayer[0]!;
  }

  // Within same layer: pessimistic (lowest numeric value)
  let best = winningLayer[0]!;
  for (let i = 1; i < winningLayer.length; i++) {
    const candidate = winningLayer[i]!;
    const bestVal = best.extracted_value;
    const candidateVal = candidate.extracted_value;
    if (typeof bestVal === "number" && typeof candidateVal === "number") {
      if (candidateVal < bestVal) {
        best = candidate;
      }
    }
  }

  return best;
}

/**
 * Strip trailing _2, _3, ... _N suffixes that LLMs sometimes append to
 * deduplicate JSON keys.  Only applied to names from external (LLM) input.
 *
 * Examples:
 *   "todo_count_2"  → "todo_count"
 *   "quality_3"     → "quality"
 *   "step_count"    → "step_count"  (trailing token is not a digit-only suffix)
 *   "coverage"      → "coverage"
 */
export function normalizeDimensionName(name: string, logger?: Logger): string {
  const stripped = name.replace(/_\d+$/, "");
  if (stripped !== name) {
    logger?.warn(`[ObservationEngine] normalizeDimensionName: stripped "${name}" → "${stripped}"`);
  }
  return stripped;
}

/**
 * Detect whether a set of observation entries indicates a knowledge gap.
 *
 * Rule: if ALL entries have confidence < 0.3, interpretation is too
 * uncertain — emit an `interpretation_difficulty` signal.
 *
 * Returns null when confidence is sufficient (no gap detected).
 */
export function detectKnowledgeGap(
  entries: ObservationLogEntry[],
  dimensionName?: string
): KnowledgeGapSignal | null {
  if (entries.length === 0) return null;

  const allLowConfidence = entries.every((e) => e.confidence < 0.3);
  if (!allLowConfidence) return null;

  return KnowledgeGapSignalSchema.parse({
    signal_type: "interpretation_difficulty",
    missing_knowledge:
      "Observation confidence is too low to interpret results reliably",
    source_step: "gap_recognition",
    related_dimension: dimensionName ?? null,
  });
}

/**
 * Load the observation log for a goal, returning an empty log if none exists.
 * Pure function — requires stateManager passed in.
 */
export async function loadOrEmptyObservationLog(
  stateManager: { loadObservationLog: (goalId: string) => Promise<ObservationLog | null> },
  goalId: string
): Promise<ObservationLog> {
  const existing = await stateManager.loadObservationLog(goalId);
  if (existing !== null) {
    return existing;
  }
  return ObservationLogSchema.parse({ goal_id: goalId, entries: [] });
}
