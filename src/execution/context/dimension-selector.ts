import { scoreAllDimensions, rankDimensions } from "../../platform/drive/drive-scorer.js";
import type { GapVector } from "../../base/types/gap.js";
import type { DriveContext } from "../../base/types/drive.js";
import type { Dimension } from "../../base/types/goal.js";

/**
 * Confidence-tier weights for dimension selection.
 * Mechanically-observable dimensions are prioritized over LLM-only ones.
 */
const CONFIDENCE_WEIGHTS: Record<string, number> = {
  mechanical: 1.0,
  verified: 0.9,
  independent_review: 0.7,
  self_report: 0.3,
};

function getConfidenceWeight(dim: Dimension): number {
  const tier = dim.observation_method.confidence_tier;
  return CONFIDENCE_WEIGHTS[tier] ?? 0.3;
}

/**
 * Select the highest-priority dimension to work on based on drive scoring,
 * weighted by observation confidence tier so that mechanically-observable
 * dimensions are preferred over LLM-only ones at equal gap severity.
 *
 * @param gapVector - current gap state for the goal
 * @param driveContext - per-dimension timing/deadline/opportunity context
 * @param dimensions - optional goal dimensions used to apply confidence-tier weighting
 * @returns the name of the top-ranked dimension
 * @throws if gapVector has no gaps (empty)
 */
export function selectTargetDimension(
  gapVector: GapVector,
  driveContext: DriveContext,
  dimensions?: Dimension[]
): string {
  if (gapVector.gaps.length === 0) {
    throw new Error("selectTargetDimension: gapVector has no gaps (empty gap vector)");
  }

  const scores = scoreAllDimensions(gapVector, driveContext);
  const ranked = rankDimensions(scores);

  if (!dimensions || dimensions.length === 0) {
    // No dimension metadata available — fall back to drive-score ranking only
    // ranked is non-empty: gapVector.gaps.length === 0 guard above ensures at least one gap
    return ranked[0]?.dimension_name ?? gapVector.gaps[0]?.dimension_name ?? "";
  }

  // Build a lookup from dimension name → confidence weight
  const weightByName = new Map<string, number>();
  for (const dim of dimensions) {
    weightByName.set(dim.name, getConfidenceWeight(dim));
  }

  // Apply confidence-tier weighting to final_score for selection only
  const weighted = ranked.map((score) => ({
    dimension_name: score.dimension_name,
    weighted_score: score.final_score * (weightByName.get(score.dimension_name) ?? 0.3),
  }));

  weighted.sort((a, b) => {
    const scoreDiff = b.weighted_score - a.weighted_score;
    if (scoreDiff !== 0) return scoreDiff;
    return a.dimension_name < b.dimension_name ? -1 : a.dimension_name > b.dimension_name ? 1 : 0;
  });

  // weighted is non-empty: ranked is non-empty (gapVector guard above), weighted maps ranked 1:1
  return weighted[0]?.dimension_name ?? gapVector.gaps[0]?.dimension_name ?? "";
}
