import { StateManager } from "./state-manager.js";
import { computeRawGap, normalizeGap } from "./gap-calculator.js";
import type { Goal, Dimension } from "./types/goal.js";
import type {
  CompletionJudgment,
  DimensionSatisfaction,
  IterationConstraints,
  ThresholdAdjustmentProposal,
} from "./types/satisficing.js";

/**
 * SatisficingJudge implements the completion judgment logic defined in satisficing.md.
 *
 * Responsibility: determine whether a goal (or individual dimension) is "good enough"
 * to declare done, applying progress ceilings based on confidence tiers.
 *
 * Key design rules:
 * - Completion requires ALL dimensions satisfied AND no low-confidence dimensions.
 * - Progress ceiling: high >= 0.85 → 1.0 | medium >= 0.50 → 0.85 | low < 0.50 → 0.60
 * - These ceiling values are from satisficing.md (distinct from ObservationEngine ceilings).
 * - null current_value is treated as fully unsatisfied.
 */
export class SatisficingJudge {
  private readonly stateManager: StateManager;

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  // ─── Confidence Tier Helpers ───

  private getConfidenceTier(confidence: number): "high" | "medium" | "low" {
    if (confidence >= 0.85) return "high";
    if (confidence >= 0.50) return "medium";
    return "low";
  }

  private getCeiling(tier: "high" | "medium" | "low"): number {
    switch (tier) {
      case "high":
        return 1.0;
      case "medium":
        return 0.85;
      case "low":
        return 0.60;
    }
  }

  // ─── Progress Calculation (inverse of gap) ───

  /**
   * Compute actual progress (0–1) toward satisfying a dimension.
   * Progress = 1 - normalized_gap, clamped to [0, 1].
   * For binary thresholds (present/match), either 0 or 1.
   * null current_value = 0 progress.
   */
  private computeActualProgress(dim: Dimension): number {
    const { current_value, threshold } = dim;

    if (current_value === null) return 0;

    const rawGap = computeRawGap(current_value, threshold);
    const normalizedGap = normalizeGap(rawGap, threshold, current_value);

    // Clamp to [0, 1] and invert: progress = 1 - gap
    const clamped = Math.min(1, Math.max(0, normalizedGap));
    return 1 - clamped;
  }

  // ─── Satisfaction Check ───

  /**
   * Determine whether a dimension's current_value meets its threshold.
   * Uses raw boolean logic (not gap magnitude) for the is_satisfied flag.
   */
  private isSatisfiedRaw(dim: Dimension): boolean {
    const { current_value, threshold } = dim;

    if (current_value === null) return false;

    switch (threshold.type) {
      case "min":
        return toNumber(current_value) >= threshold.value;
      case "max":
        return toNumber(current_value) <= threshold.value;
      case "range":
        return (
          toNumber(current_value) >= threshold.low &&
          toNumber(current_value) <= threshold.high
        );
      case "present":
        return isTruthy(current_value);
      case "match":
        return current_value === threshold.value;
    }
  }

  // ─── Public API ───

  /**
   * Check if a single dimension is satisfied with appropriate confidence ceiling.
   */
  isDimensionSatisfied(dim: Dimension): DimensionSatisfaction {
    const isSatisfied = this.isSatisfiedRaw(dim);
    const tier = this.getConfidenceTier(dim.confidence);
    const ceiling = this.getCeiling(tier);
    const actualProgress = this.computeActualProgress(dim);
    const effectiveProgress = Math.min(actualProgress, ceiling);

    // threshold_value for the schema — use numeric representation where applicable
    const thresholdValue = getNumericThresholdValue(dim);

    return {
      dimension_name: dim.name,
      is_satisfied: isSatisfied,
      current_value: toNumberOrNull(dim.current_value),
      threshold_value: thresholdValue,
      confidence: dim.confidence,
      confidence_tier: tier,
      effective_progress: effectiveProgress,
      progress_ceiling: ceiling,
    };
  }

  /**
   * Determine if a goal is fully complete.
   * Complete iff all dimensions are satisfied AND no dimension has low confidence.
   */
  isGoalComplete(goal: Goal): CompletionJudgment {
    const dims = goal.dimensions;

    if (dims.length === 0) {
      return {
        is_complete: true,
        blocking_dimensions: [],
        low_confidence_dimensions: [],
        needs_verification_task: false,
        checked_at: new Date().toISOString(),
      };
    }

    const satisfactions = dims.map((d) => this.isDimensionSatisfied(d));

    const blockingDimensions = satisfactions
      .filter((s) => !s.is_satisfied)
      .map((s) => s.dimension_name);

    const lowConfidenceDimensions = satisfactions
      .filter((s) => s.confidence_tier === "low")
      .map((s) => s.dimension_name);

    // needs_verification_task: any dimension appears to meet threshold but confidence < 0.85
    const needsVerification = satisfactions.some(
      (s) => s.is_satisfied && s.confidence < 0.85
    );

    const isComplete =
      blockingDimensions.length === 0 && lowConfidenceDimensions.length === 0;

    return {
      is_complete: isComplete,
      blocking_dimensions: blockingDimensions,
      low_confidence_dimensions: lowConfidenceDimensions,
      needs_verification_task: needsVerification,
      checked_at: new Date().toISOString(),
    };
  }

  /**
   * Apply progress ceiling based on confidence tier.
   * Returns min(actualProgress, ceiling).
   */
  applyProgressCeiling(actualProgress: number, confidence: number): number {
    const tier = this.getConfidenceTier(confidence);
    const ceiling = this.getCeiling(tier);
    return Math.min(actualProgress, ceiling);
  }

  /**
   * Select dimensions to focus on in the next iteration.
   *
   * Algorithm:
   * 1. Exclude already-satisfied dimensions.
   * 2. Among remaining, sort by drive score (highest first).
   * 3. Take top max_dimensions.
   */
  selectDimensionsForIteration(
    dimensions: Dimension[],
    driveScores: Array<{ dimension_name: string; score: number }>,
    constraints?: IterationConstraints
  ): string[] {
    const maxDimensions = constraints?.max_dimensions ?? 3;
    const uncertaintyThreshold = constraints?.uncertainty_threshold ?? 0.50;

    // Build score lookup
    const scoreMap = new Map<string, number>(
      driveScores.map((ds) => [ds.dimension_name, ds.score])
    );

    // Filter out satisfied dimensions; mark low-confidence as needing observation first
    const candidates = dimensions
      .filter((dim) => !this.isSatisfiedRaw(dim))
      .filter((dim) => dim.confidence >= uncertaintyThreshold);

    // Sort by drive score descending
    candidates.sort((a, b) => {
      const scoreA = scoreMap.get(a.name) ?? 0;
      const scoreB = scoreMap.get(b.name) ?? 0;
      return scoreB - scoreA;
    });

    return candidates.slice(0, maxDimensions).map((d) => d.name);
  }

  /**
   * Detect dimensions where threshold adjustment may be warranted.
   *
   * Condition 1: >= 3 failures AND normalized_gap has not improved (no progress).
   * Condition 2: all other dimensions satisfied, this one is still far from threshold.
   */
  detectThresholdAdjustmentNeeded(
    goal: Goal,
    failureCounts: Map<string, number>
  ): ThresholdAdjustmentProposal[] {
    const proposals: ThresholdAdjustmentProposal[] = [];
    const dims = goal.dimensions;

    if (dims.length === 0) return proposals;

    const satisfactions = dims.map((d) => this.isDimensionSatisfied(d));
    const satisfiedSet = new Set(
      satisfactions.filter((s) => s.is_satisfied).map((s) => s.dimension_name)
    );

    for (const dim of dims) {
      const failures = failureCounts.get(dim.name) ?? 0;
      const progress = this.computeActualProgress(dim);

      // Condition 1: high failure count + no meaningful progress (< 10%)
      if (failures >= 3 && progress < 0.10) {
        const currentThreshold = getNumericThresholdValueForProposal(dim);
        if (currentThreshold !== null) {
          const proposedThreshold = currentThreshold * 0.8; // propose 20% reduction
          proposals.push({
            goal_id: goal.id,
            dimension_name: dim.name,
            current_threshold: currentThreshold,
            proposed_threshold: proposedThreshold,
            reason: "high_failure_no_progress",
            evidence: `${failures} failures with ${Math.round(progress * 100)}% progress toward threshold`,
          });
        }
      }

      // TODO: condition 3 (resource undershoot) deferred — requires task cost history

      // Condition 2: bottleneck — all other dimensions satisfied, this one is far (< 30%)
      const othersAllSatisfied = dims
        .filter((d) => d.name !== dim.name)
        .every((d) => satisfiedSet.has(d.name));

      if (othersAllSatisfied && !satisfiedSet.has(dim.name) && progress < 0.30) {
        const currentThreshold = getNumericThresholdValueForProposal(dim);
        if (currentThreshold !== null && !proposals.some((p) => p.dimension_name === dim.name)) {
          const proposedThreshold = currentThreshold * 0.8;
          proposals.push({
            goal_id: goal.id,
            dimension_name: dim.name,
            current_threshold: currentThreshold,
            proposed_threshold: proposedThreshold,
            reason: "bottleneck_dimension",
            evidence: `All other dimensions satisfied; this dimension at ${Math.round(progress * 100)}% progress`,
          });
        }
      }
    }

    return proposals;
  }

  /**
   * Propagate subgoal completion to the parent goal's matching dimension.
   *
   * MVP: name-based matching only.
   * Finds the first dimension whose name matches subgoalId (or contains it),
   * and sets its current_value to the threshold value (fully satisfied).
   */
  propagateSubgoalCompletion(subgoalId: string, parentGoalId: string): void {
    const parentGoal = this.stateManager.loadGoal(parentGoalId);
    if (parentGoal === null) {
      throw new Error(
        `propagateSubgoalCompletion: parent goal "${parentGoalId}" not found`
      );
    }

    const matchedDimIndex = parentGoal.dimensions.findIndex(
      (d) => d.name === subgoalId || d.name.includes(subgoalId)
    );

    if (matchedDimIndex === -1) {
      // No matching dimension — nothing to propagate
      return;
    }

    const matchedDim = parentGoal.dimensions[matchedDimIndex]!;

    // Set current_value to threshold value so isDimensionSatisfied returns true
    const satisfiedValue = getSatisfiedValue(matchedDim);
    const now = new Date().toISOString();

    const updatedDimensions = parentGoal.dimensions.map((d, i) =>
      i === matchedDimIndex
        ? { ...d, current_value: satisfiedValue, last_updated: now }
        : d
    );

    this.stateManager.saveGoal({
      ...parentGoal,
      dimensions: updatedDimensions,
      updated_at: now,
    });
  }
}

// ─── Helpers (non-exported) ───

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

function toNumberOrNull(value: number | string | boolean | null): number | null {
  if (value === null) return null;
  return toNumber(value);
}

/**
 * Extract a representative numeric threshold value for the DimensionSatisfaction schema.
 * Returns null for "present" (no numeric threshold).
 */
function getNumericThresholdValue(dim: Dimension): number | null {
  const { threshold } = dim;
  switch (threshold.type) {
    case "min":
      return threshold.value;
    case "max":
      return threshold.value;
    case "range":
      return threshold.high; // use upper bound as representative
    case "present":
      return null;
    case "match":
      return typeof threshold.value === "number" ? threshold.value : null;
  }
}

/**
 * Returns the numeric threshold for adjustment proposals.
 * Only applicable to numeric thresholds (min/max/range).
 */
function getNumericThresholdValueForProposal(dim: Dimension): number | null {
  const { threshold } = dim;
  switch (threshold.type) {
    case "min":
      return threshold.value;
    case "max":
      return threshold.value;
    case "range":
      return threshold.high;
    case "present":
    case "match":
      return null; // adjustment not meaningful for binary thresholds
  }
}

/**
 * Compute the value that fully satisfies the threshold (for propagation).
 */
function getSatisfiedValue(dim: Dimension): number | string | boolean | null {
  const { threshold } = dim;
  switch (threshold.type) {
    case "min":
      return threshold.value;
    case "max":
      return threshold.value;
    case "range":
      return (threshold.low + threshold.high) / 2;
    case "present":
      return true;
    case "match":
      return threshold.value;
  }
}
