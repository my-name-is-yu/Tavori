import { StateManager } from "../../base/state/state-manager.js";
import { dimensionProgress } from "./gap-calculator.js";
import type { Goal, Dimension } from "../../base/types/goal.js";
import type {
  CompletionJudgment,
  DimensionSatisfaction,
  IterationConstraints,
  ThresholdAdjustmentProposal,
  MappingProposal,
  ConvergenceJudgment,
  SatisficingStatus,
} from "../../base/types/satisficing.js";
import type { IEmbeddingClient } from "../knowledge/embedding-client.js";
import {
  toNumber,
  isTruthy,
  toNumberOrNull,
  getNumericThresholdValue,
  getNumericThresholdValueForProposal,
} from "./satisficing-helpers.js";
import {
  judgeTreeCompletion as judgeTreeCompletionFn,
  propagateSubgoalCompletion as propagateSubgoalCompletionFn,
} from "./satisficing-propagation.js";
export { aggregateValues } from "./satisficing-helpers.js";

// ─── Convergence Detection Constants ───

const CONVERGENCE_WINDOW = 5;        // ring buffer size
const CONVERGENCE_EPSILON = 0.01;    // variance threshold
const ACCEPTABLE_RANGE_FACTOR = 1.5; // threshold × this = acceptable range ceiling

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
  private readonly embeddingClient?: IEmbeddingClient;
  private readonly onSatisficingJudgment?: (goalId: string, satisfiedDimensions: string[]) => void;

  // Ring buffers keyed by goalId+dimensionName to track recent gap values
  private readonly gapHistory: Map<string, number[]> = new Map();

  // P0: Satisficing double-confirmation guard (§4.4)
  // Tracks consecutive cycles where all dimensions are met, keyed by goalId
  private readonly satisficingStreak: Map<string, number> = new Map();

  constructor(
    stateManager: StateManager,
    embeddingClient?: IEmbeddingClient,  // Phase 2: for dimension mapping proposals
    onSatisficingJudgment?: (goalId: string, satisfiedDimensions: string[]) => void
  ) {
    this.stateManager = stateManager;
    this.embeddingClient = embeddingClient;
    this.onSatisficingJudgment = onSatisficingJudgment;
  }

  // ─── Convergence Detection ───

  /**
   * Compute the variance of an array of numbers. Returns null if fewer than 2 values.
   */
  private computeVariance(values: number[]): number | null {
    if (values.length < 2) return null;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const squaredDiffs = values.map((v) => (v - mean) ** 2);
    return squaredDiffs.reduce((s, v) => s + v, 0) / values.length;
  }

  /**
   * Record a gap observation for a goal dimension into the ring buffer.
   * Pushes the gap value and trims to CONVERGENCE_WINDOW.
   */
  private recordGap(key: string, gap: number): void {
    const buf = this.gapHistory.get(key) ?? [];
    buf.push(gap);
    if (buf.length > CONVERGENCE_WINDOW) {
      buf.shift();
    }
    this.gapHistory.set(key, buf);
  }

  /**
   * Judge convergence for a single gap value against a threshold.
   * Records the gap in the ring buffer, then evaluates:
   *   - gap < threshold → satisficed (existing behavior)
   *   - variance < ε AND gap ≤ threshold × 1.5 → converged_satisficed
   *   - variance < ε AND gap > threshold × 1.5 → stalled
   *   - otherwise → in_progress
   *
   * @param key      Unique key for the ring buffer (e.g., `${goalId}:${dimensionName}`)
   * @param gap      Current normalized gap value [0, 1]
   * @param threshold The satisficing threshold (normalized gap target, typically 0 means met)
   */
  judgeConvergence(key: string, gap: number, threshold: number): ConvergenceJudgment {
    this.recordGap(key, gap);
    const buf = this.gapHistory.get(key) ?? [];
    const variance = this.computeVariance(buf);

    let status: SatisficingStatus;

    if (gap < threshold) {
      status = "satisficed";
    } else if (variance !== null && variance < CONVERGENCE_EPSILON) {
      const acceptableRange = threshold * ACCEPTABLE_RANGE_FACTOR;
      status = gap <= acceptableRange ? "converged_satisficed" : "stalled";
    } else {
      status = "in_progress";
    }

    return {
      status,
      gap,
      variance,
      window_size: CONVERGENCE_WINDOW,
      samples_available: buf.length,
    };
  }

  /**
   * Clear the gap history ring buffer for a specific key.
   * Call this when a goal is reset or completed.
   */
  clearGapHistory(key: string): void {
    this.gapHistory.delete(key);
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
    if (dim.current_value === null) return 0;
    return dimensionProgress(dim.current_value, dim.threshold) ?? 0;
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
   * Propose dimension mappings between subgoal and parent goal dimensions
   * using embedding similarity.
   */
  async proposeDimensionMapping(
    subgoalDimensions: Array<{ name: string; description?: string }>,
    parentGoalDimensions: Array<{ name: string; description?: string }>
  ): Promise<MappingProposal[]> {
    if (!this.embeddingClient) return [];

    const proposals: MappingProposal[] = [];

    for (const subDim of subgoalDimensions) {
      const subText = subDim.description ? `${subDim.name}: ${subDim.description}` : subDim.name;
      const subVector = await this.embeddingClient.embed(subText);

      let bestMatch: { name: string; similarity: number } | null = null;

      for (const parentDim of parentGoalDimensions) {
        const parentText = parentDim.description ? `${parentDim.name}: ${parentDim.description}` : parentDim.name;
        const parentVector = await this.embeddingClient.embed(parentText);
        const similarity = this.embeddingClient.cosineSimilarity(subVector, parentVector);

        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = { name: parentDim.name, similarity };
        }
      }

      if (bestMatch && bestMatch.similarity > 0.5) {
        proposals.push({
          subgoal_dimension: subDim.name,
          parent_dimension: bestMatch.name,
          similarity_score: bestMatch.similarity,
          suggested_aggregation: "avg",  // default; could be smarter
          confidence: Math.min(bestMatch.similarity, 0.9),
          reasoning: `Dimension "${subDim.name}" is semantically similar to parent dimension "${bestMatch.name}" (similarity: ${bestMatch.similarity.toFixed(3)})`,
        });
      }
    }

    return proposals;
  }

  /**
   * Determine if a goal is fully complete.
   * Complete iff all dimensions are satisfied AND no dimension has low confidence.
   *
   * @param goal The goal to check.
   * @param convergenceStatuses Optional map of dimension key → SatisficingStatus from judgeConvergence().
   *   When a dimension's convergence status is "converged_satisficed", it is treated as satisfied
   *   (gap has stabilized within acceptable range — good enough).
   *   Keys should match the format used with judgeConvergence(): `${goalId}:${dimensionName}`.
   */
  isGoalComplete(
    goal: Goal,
    convergenceStatuses?: Map<string, SatisficingStatus>
  ): CompletionJudgment {
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

    const satisfactions = dims.map((d) => {
      const base = this.isDimensionSatisfied(d);
      // If not already satisfied, check if convergence status marks it as converged_satisficed
      if (!base.is_satisfied && convergenceStatuses) {
        const key = `${goal.id}:${d.name}`;
        const status = convergenceStatuses.get(key);
        if (status === "converged_satisficed") {
          return { ...base, is_satisfied: true, confidence_tier: base.confidence_tier === "low" ? "medium" : base.confidence_tier };
        }
      }
      return base;
    });

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

    // P0: Satisficing double-confirmation guard (§4.4)
    // Require 2 consecutive cycles of gap <= threshold before declaring complete
    const allDimensionsMet = blockingDimensions.length === 0 && lowConfidenceDimensions.length === 0;
    let isComplete = false;
    if (allDimensionsMet) {
      const streak = (this.satisficingStreak.get(goal.id) ?? 0) + 1;
      this.satisficingStreak.set(goal.id, streak);
      if (streak >= 2) {
        isComplete = true;
        this.satisficingStreak.delete(goal.id);  // Reset after confirmed completion
      }
    } else {
      this.satisficingStreak.set(goal.id, 0);  // Reset streak
    }

    if (this.onSatisficingJudgment) {
      const satisfiedDims = satisfactions
        .filter(s => s.is_satisfied)
        .map(s => s.dimension_name);
      if (satisfiedDims.length > 0) {
        this.onSatisficingJudgment(goal.id, satisfiedDims);
      }
    }

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
  async detectThresholdAdjustmentNeeded(
    goal: Goal,
    failureCounts: Map<string, number>
  ): Promise<ThresholdAdjustmentProposal[]> {
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

      // Condition 3: Resource undershoot — tasks complete much faster than estimated
      // but goal progress is stagnant, suggesting the threshold may be too ambitious.
      // Requires task cost history (actual_elapsed_ms + estimated_duration_ms fields).
      {
        const rawHistory = await this.stateManager.readRaw(`tasks/${goal.id}/task-history.json`);
        const taskHistory = Array.isArray(rawHistory) ? rawHistory : [];

        const dimHistory = taskHistory.filter(
          (h: Record<string, unknown>) =>
            h.primary_dimension === dim.name &&
            typeof h.actual_elapsed_ms === "number" &&
            typeof h.estimated_duration_ms === "number" &&
            (h.estimated_duration_ms as number) > 0
        ) as Array<{ actual_elapsed_ms: number; estimated_duration_ms: number }>;

        if (dimHistory.length >= 3) {
          const avgEstimated =
            dimHistory.reduce((s, h) => s + h.estimated_duration_ms, 0) / dimHistory.length;
          const avgActual =
            dimHistory.reduce((s, h) => s + h.actual_elapsed_ms, 0) / dimHistory.length;

          if (avgActual < 0.5 * avgEstimated && progress < 0.5) {
            const currentThreshold = getNumericThresholdValueForProposal(dim);
            if (
              currentThreshold !== null &&
              !proposals.some((p) => p.dimension_name === dim.name)
            ) {
              proposals.push({
                goal_id: goal.id,
                dimension_name: dim.name,
                current_threshold: currentThreshold,
                proposed_threshold: currentThreshold * 0.85,
                reason: "resource_undershoot",
                evidence: `${dimHistory.length} tasks averaged ${Math.round(avgActual)}ms vs ${Math.round(avgEstimated)}ms estimated; goal progress at ${Math.round(progress * 100)}%`,
              });
            }
          }
        }
      }

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
   * Judge completion of an entire goal tree by checking all children recursively.
   * Non-leaf nodes are complete when all children are completed or cancelled(merged).
   *
   * @param rootId The ID of the root goal of the tree.
   * @returns CompletionJudgment for the root node.
   */
  async judgeTreeCompletion(
    rootId: string,
    convergenceStatuses?: Map<string, SatisficingStatus>
  ): Promise<CompletionJudgment> {
    // judgeTreeCompletion advances the streak by one per call (same as flat goals).
    // Callers (e.g. CoreLoop) must invoke this across two separate cycles for the
    // double-confirmation guard to confirm completion — matching flat-goal behaviour.
    return await judgeTreeCompletionFn(
      rootId,
      this.stateManager,
      (goal, cs) => this.isGoalComplete(goal, cs),
      convergenceStatuses
    );
  }

  /**
   * Propagate subgoal completion to the parent goal's matching dimension.
   *
   * Phase 2: supports dimension_mapping for aggregation-based propagation.
   * - If any subgoal dimension has dimension_mapping set, use aggregation path.
   * - Mixed: mapped dimensions use aggregation; unmapped dimensions fall back to name matching.
   * - Backwards compatible: if no dimensions have dimension_mapping, behaves like MVP.
   *
   * @param subgoalId The subgoal's ID (used for name matching in MVP path).
   * @param parentGoalId The parent goal's ID to update.
   * @param subgoalDimensions Optional subgoal dimensions for aggregation mapping.
   *   When omitted, falls back to MVP name-based matching only.
   */
  async propagateSubgoalCompletion(
    subgoalId: string,
    parentGoalId: string,
    subgoalDimensions?: import("../../base/types/goal.js").Dimension[]
  ): Promise<void> {
    await propagateSubgoalCompletionFn(
      subgoalId,
      parentGoalId,
      this.stateManager,
      (dim) => this.computeActualProgress(dim),
      subgoalDimensions
    );
  }
}
