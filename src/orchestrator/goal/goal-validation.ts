/**
 * goal-validation.ts — Validation helpers and dimension transformation utilities
 * used by GoalNegotiator and related modules.
 */

import type { Dimension } from "../../base/types/goal.js";
import type { DimensionDecomposition } from "../../base/types/negotiation.js";

// ─── Helper: convert DimensionDecomposition to Dimension ───

export function decompositionToDimension(d: DimensionDecomposition): Dimension {
  const threshold = buildThreshold(d.threshold_type, d.threshold_value);
  return {
    name: d.name,
    label: d.label,
    current_value: null,
    threshold,
    confidence: 0,
    observation_method: {
      type: "llm_review",
      source: d.observation_method_hint,
      schedule: null,
      endpoint: null,
      confidence_tier: "self_report",
    },
    last_updated: null,
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok",
    dimension_mapping: null,
  };
}

export function buildThreshold(
  thresholdType: "min" | "max" | "range" | "present" | "match",
  thresholdValue: number | string | boolean | (number | string)[] | null
): Dimension["threshold"] {
  switch (thresholdType) {
    case "min":
      return { type: "min", value: typeof thresholdValue === "number" ? thresholdValue : 0 };
    case "max":
      return { type: "max", value: typeof thresholdValue === "number" ? thresholdValue : 100 };
    case "range": {
      if (Array.isArray(thresholdValue)) {
        const low = typeof thresholdValue[0] === "number" ? thresholdValue[0] : 0;
        const high = typeof thresholdValue[1] === "number" ? thresholdValue[1] : 100;
        return { type: "range", low, high };
      }
      return { type: "range", low: 0, high: typeof thresholdValue === "number" ? thresholdValue : 100 };
    }
    case "present":
      return { type: "present" };
    case "match":
      return {
        type: "match",
        value:
          thresholdValue !== null && !Array.isArray(thresholdValue)
            ? (thresholdValue as string | number | boolean)
            : "",
      };
  }
}

// ─── Helper: deduplicate dimension keys ───

/**
 * When the LLM returns multiple dimensions with the same `name` (key),
 * append `_2`, `_3`, … suffixes to the duplicates so every key is unique.
 * All dimensions are preserved — none are dropped.
 */
export function deduplicateDimensionKeys(dimensions: DimensionDecomposition[]): DimensionDecomposition[] {
  const seen = new Map<string, number>(); // key → count so far
  for (const dim of dimensions) {
    const base = dim.name;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    if (count > 0) {
      // Second occurrence → `_2`, third → `_3`, etc.
      dim.name = `${base}_${count + 1}`;
    }
  }
  return dimensions;
}

/**
 * Find the best matching DataSource dimension name for a given dimension name.
 * Uses simple keyword overlap matching.
 */
export function findBestDimensionMatch(name: string, candidates: string[]): string | null {
  const nameTokens = name.toLowerCase().split(/[_\s-]+/);
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const candidateTokens = candidate.toLowerCase().split(/[_\s-]+/);
    // Count overlapping tokens
    const overlap = nameTokens.filter(t => candidateTokens.includes(t)).length;
    const score = overlap / Math.max(nameTokens.length, candidateTokens.length);
    if (score > bestScore && score >= 0.6) {  // At least 60% token overlap
      bestScore = score;
      bestMatch = candidate;
    }
  }

  return bestMatch;
}
