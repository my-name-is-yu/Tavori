import type { Dimension } from "../types/goal.js";
import type { Threshold } from "../types/core.js";
import type { RawGap, NormalizedGap, WeightedGap, GapVector } from "../types/gap.js";

/**
 * GapCalculator implements the gap calculation pipeline defined in gap-calculation.md:
 *   raw_gap -> normalized_gap -> normalized_weighted_gap
 *
 * All functions are pure (no side effects).
 *
 * Key design constraints:
 * - Confidence adjustment applies ONLY at the normalized_weighted_gap stage (section 3).
 * - null current_value => maximum gap, no confidence weighting applied.
 * - Zero-division guards: if denominator is 0, normalized_gap = 1.0 (if raw_gap > 0) or 0.0.
 */

// ─── Step 1: Raw Gap Calculation ───

/**
 * Compute raw gap for a single dimension based on its threshold type.
 *
 * Formulas from gap-calculation.md section 1:
 *   min(N):        max(0, threshold - current)
 *   max(N):        max(0, current - threshold)
 *   range(lo, hi): max(0, lo - current) + max(0, current - hi)
 *   present:       0 if truthy, 1 if falsy
 *   match(value):  0 if current == value, 1 otherwise
 *
 * Guard: current_value = null => maximum gap
 *   numeric types: threshold value (representing full undershoot)
 *   binary types:  1
 */
export function computeRawGap(
  currentValue: number | string | boolean | null,
  threshold: Threshold
): number {
  // Guard: null current_value
  if (currentValue === null) {
    switch (threshold.type) {
      case "min":
        return threshold.value; // full gap = threshold itself
      case "max":
        // null current_value on a max threshold: unknown exceedance.
        // Formula for max is `current - threshold`; with null current we
        // return a positive sentinel so normalizeGap's null guard (→ 1.0)
        // takes over. Use max(threshold.value, 1) to stay positive when
        // threshold.value = 0.
        return threshold.value > 0 ? threshold.value : 1;
      case "range":
        return threshold.high - threshold.low; // full range span
      case "present":
        return 1;
      case "match":
        return 1;
    }
  }

  switch (threshold.type) {
    case "min": {
      const current = toNumber(currentValue);
      return Math.max(0, threshold.value - current);
    }
    case "max": {
      const current = toNumber(currentValue);
      return Math.max(0, current - threshold.value);
    }
    case "range": {
      const current = toNumber(currentValue);
      return (
        Math.max(0, threshold.low - current) +
        Math.max(0, current - threshold.high)
      );
    }
    case "present": {
      return isTruthy(currentValue) ? 0 : 1;
    }
    case "match": {
      // Strict equality comparison for match type
      return currentValue === threshold.value ? 0 : 1;
    }
  }
}

// ─── Step 2: Normalization ───

/**
 * Normalize raw gap to [0, 1] range.
 *
 * Formulas from gap-calculation.md section 2:
 *   min(N):        raw_gap / threshold (guard: if threshold=0 and raw_gap>0 -> 1.0)
 *   max(N):        raw_gap / threshold (guard: if threshold=0 -> cap at 1.0)
 *   range(lo, hi): min(1.0, raw_gap / ((high - low) / 2))
 *   present:       raw_gap (already 0 or 1)
 *   match:         raw_gap (already 0 or 1)
 *
 * null current_value => normalized_gap = 1.0
 */
export function normalizeGap(
  rawGap: number,
  threshold: Threshold,
  currentValue: number | string | boolean | null
): number {
  // Guard: null current_value => maximum gap
  if (currentValue === null) {
    return 1.0;
  }

  switch (threshold.type) {
    case "min": {
      if (threshold.value === 0) {
        return rawGap > 0 ? 1.0 : 0.0;
      }
      return rawGap / threshold.value;
    }
    case "max": {
      if (threshold.value === 0) {
        return Math.min(rawGap, 1.0);
      }
      return rawGap / threshold.value;
    }
    case "range": {
      const halfWidth = (threshold.high - threshold.low) / 2;
      if (halfWidth === 0) {
        return rawGap > 0 ? 1.0 : 0.0;
      }
      return Math.min(1.0, rawGap / halfWidth);
    }
    case "present":
    case "match":
      return rawGap; // already 0 or 1
  }
}

// ─── Step 3: Confidence-Weighted Gap ───

/**
 * Apply confidence weighting to the normalized gap.
 *
 * Formula from gap-calculation.md section 3:
 *   normalized_weighted_gap = normalized_gap * (1 + (1 - confidence) * uncertainty_weight)
 *
 * Key constraint: if current_value is null, skip confidence weighting
 * (null already produces max gap via section 1 guard; don't double-inflate).
 */
export function applyConfidenceWeight(
  normalizedGap: number,
  confidence: number,
  uncertaintyWeight: number,
  currentValueIsNull: boolean
): number {
  if (currentValueIsNull) {
    return normalizedGap; // Do not apply confidence weighting for null values
  }

  const weighted = normalizedGap * (1 + (1 - confidence) * uncertaintyWeight);
  return Math.min(1.0, weighted);
}

// ─── Full Pipeline for a Single Dimension ───

export interface DimensionGapInput {
  name: string;
  current_value: number | string | boolean | null;
  threshold: Threshold;
  confidence: number;
  /** Per-dimension override; null = use global */
  uncertainty_weight: number | null;
}

/**
 * Calculate the complete gap pipeline for a single dimension.
 * Returns all intermediate values for transparency.
 */
export function calculateDimensionGap(
  input: DimensionGapInput,
  globalUncertaintyWeight: number = 1.0
): WeightedGap {
  const { name, current_value, threshold, confidence, uncertainty_weight } =
    input;

  const effectiveWeight = uncertainty_weight ?? globalUncertaintyWeight;
  const rawGap = computeRawGap(current_value, threshold);
  const normalizedGap = normalizeGap(rawGap, threshold, current_value);
  const normalizedWeightedGap = applyConfidenceWeight(
    normalizedGap,
    confidence,
    effectiveWeight,
    current_value === null
  );

  return {
    dimension_name: name,
    raw_gap: rawGap,
    normalized_gap: normalizedGap,
    normalized_weighted_gap: normalizedWeightedGap,
    confidence,
    uncertainty_weight: effectiveWeight,
  };
}

// ─── Full Pipeline for a Goal ───

/**
 * Calculate gap vector for all dimensions of a goal.
 */
export function calculateGapVector(
  goalId: string,
  dimensions: Dimension[],
  globalUncertaintyWeight: number = 1.0
): GapVector {
  const gaps = dimensions.map((dim) =>
    calculateDimensionGap(
      {
        name: dim.name,
        current_value: dim.current_value,
        threshold: dim.threshold,
        confidence: dim.confidence,
        uncertainty_weight: dim.uncertainty_weight,
      },
      globalUncertaintyWeight
    )
  );

  return {
    goal_id: goalId,
    gaps,
    timestamp: new Date().toISOString(),
  };
}

// ─── Parent Gap Aggregation ───

/**
 * Aggregate child gap vectors into a parent gap value.
 *
 * gap-calculation.md section 6:
 *   Default: bottleneck aggregation = max(normalized_weighted_gap)
 *   Alternative: weighted_avg, sum
 *
 * Operates on normalized_weighted_gap values.
 */
export function aggregateGaps(
  childGaps: number[],
  method: "max" | "weighted_avg" | "sum" = "max",
  weights?: number[]
): number {
  if (childGaps.length === 0) return 0;

  switch (method) {
    case "max":
      return Math.max(...childGaps);
    case "weighted_avg": {
      const w = weights ?? childGaps.map(() => 1);
      const totalWeight = w.reduce((sum, wi) => sum + wi, 0);
      if (totalWeight === 0) return 0;
      const weightedSum = childGaps.reduce(
        (sum, gap, i) => sum + gap * (w[i] ?? 1),
        0
      );
      return weightedSum / totalWeight;
    }
    case "sum":
      return childGaps.reduce((sum, gap) => sum + gap, 0);
  }
}

// ─── Convenience Helper ───

/**
 * Compute normalized progress [0,1] for a dimension.
 * Returns null if value or threshold is missing.
 *
 * Progress = 1 - clamp(normalizedGap, 0, 1), where normalizedGap is derived
 * from the raw gap pipeline (computeRawGap → normalizeGap).
 */
export function dimensionProgress(
  currentValue: number | string | boolean | null | undefined,
  threshold: Threshold | null | undefined
): number | null {
  if (currentValue === null || currentValue === undefined || !threshold) return null;
  const rawGap = computeRawGap(currentValue, threshold);
  const normalizedGap = normalizeGap(rawGap, threshold, currentValue);
  return 1 - Math.max(0, Math.min(1, normalizedGap));
}

// ─── Helpers ───

function toNumber(value: number | string | boolean | null): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function isTruthy(value: number | string | boolean | null): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  return false;
}
