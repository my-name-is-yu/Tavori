/**
 * Difficulty-based curriculum ordering for subgoal selection.
 * Prioritizes medium-complexity (0.3-0.7) subgoals using gap × (1 - confidence).
 */

import type { Goal } from "../types/goal.js";
import {
  calculateDimensionGap,
  aggregateGaps,
} from "../drive/gap-calculator.js";

/** Preferred difficulty band for curriculum-based selection. */
export const MEDIUM_BAND = { min: 0.3, max: 0.7 };

/** Goals with aggregated gap below this threshold are treated as medium difficulty to avoid starvation. */
export const NEAR_COMPLETE_GAP_THRESHOLD = 0.1;

/**
 * Estimate difficulty for a single goal.
 * difficulty = aggregatedGap × (1 - minConfidence), clamped to [0, 1].
 * Uses calculateDimensionGap for consistent gap computation, aggregateGaps for aggregation.
 * Returns 0.5 (medium) when dimensions is empty or goal is near-complete.
 */
export function estimateDifficulty(goal: Goal): number {
  const dims = goal.dimensions;
  if (dims.length === 0) return 0.5;

  const weightedGaps = dims.map((d) =>
    calculateDimensionGap(
      {
        name: d.name,
        current_value: d.current_value,
        threshold: d.threshold,
        confidence: d.confidence,
        uncertainty_weight: d.uncertainty_weight,
      },
      goal.uncertainty_weight
    )
  );

  // Use normalized_gap (pre-uncertainty-weighting) so the confidence multiplier
  // below applies uniformly, including for null current_value (which yields 1.0).
  const gapValues = weightedGaps.map((wg) => wg.normalized_gap);
  const weights = dims.map((d) => d.weight ?? 1.0);
  const minConfidence = Math.min(...dims.map((d) => d.confidence));

  const aggregatedGap = aggregateGaps(gapValues, goal.gap_aggregation, weights);

  // Near-complete goals (gap < threshold) should not be starved — treat as medium difficulty
  if (aggregatedGap < NEAR_COMPLETE_GAP_THRESHOLD) return 0.5;

  const difficulty = aggregatedGap * (1 - minConfidence);
  return Math.min(1, Math.max(0, difficulty));
}

/**
 * Sort subgoal entries in-place using center-biased curriculum ordering.
 * Primary: |difficulty - 0.5| ascending (closest to medium first).
 * Tiebreaker: depth descending (deeper first).
 */
export function curriculumSort(
  entries: Array<{ id: string; depth: number; difficulty: number }>
): void {
  entries.sort((a, b) => {
    const aDist = Math.abs(a.difficulty - 0.5);
    const bDist = Math.abs(b.difficulty - 0.5);
    if (aDist !== bDist) return aDist - bDist;
    return b.depth - a.depth;
  });
}
