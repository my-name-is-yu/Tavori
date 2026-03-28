import { StateManager } from "../state-manager.js";
import { StateError } from "../utils/errors.js";
import { SatisficingJudge, aggregateValues } from "../drive/satisficing-judge.js";
import { dimensionProgress } from "../drive/gap-calculator.js";
import type { Goal, Dimension } from "../types/goal.js";
import type { SatisficingAggregation } from "../types/goal.js";
import type { StateAggregationRule } from "../types/goal-tree.js";

/**
 * AggregatedState captures the result of rolling up child states into a parent.
 *
 * aggregated_gap is in [0, 1] where 0 = fully met and 1 = fully unmet.
 * aggregated_confidence is the conservative minimum across all children.
 */
export interface AggregatedState {
  parent_id: string;
  aggregated_gap: number;
  aggregated_confidence: number;
  child_gaps: Record<string, number>;
  child_completions: Record<string, boolean>;
  aggregation_method: SatisficingAggregation;
  timestamp: string;
}

/**
 * StateAggregator handles upward aggregation (children → parent) and
 * downward propagation (parent → children) of goal state, plus cascade
 * completion detection.
 *
 * Design ref: docs/design/goal-tree.md §5 (state aggregation) and §6 (state propagation).
 */
export class StateAggregator {
  private readonly stateManager: StateManager;
  private readonly satisficingJudge: SatisficingJudge;

  /**
   * In-memory registry of StateAggregationRules keyed by parent_id.
   * Rules are injected via registerAggregationRule().
   */
  private readonly aggregationRules: Map<string, StateAggregationRule> =
    new Map();

  constructor(stateManager: StateManager, satisficingJudge: SatisficingJudge) {
    this.stateManager = stateManager;
    this.satisficingJudge = satisficingJudge;
  }

  /**
   * Register (or replace) a StateAggregationRule for a parent goal.
   * The rule overrides the default "min" aggregation for that parent.
   */
  registerAggregationRule(rule: StateAggregationRule): void {
    this.aggregationRules.set(rule.parent_id, rule);
  }

  // ─── Upward Aggregation ───

  /**
   * Aggregate the current states of all direct children of parentId into a
   * single AggregatedState.
   *
   * Algorithm (goal-tree.md §5):
   *   1. Load parent goal to get children_ids.
   *   2. For each child, compute a normalized gap (average of per-dimension gaps).
   *   3. Determine aggregation method from registered rule or default "min".
   *   4. Aggregate child gaps with the chosen method.
   *   5. Confidence = min(child confidences) — conservative.
   *
   * @throws if the parent goal cannot be found.
   */
  async aggregateChildStates(parentId: string): Promise<AggregatedState> {
    const parent = await this.stateManager.loadGoal(parentId);
    if (parent === null) {
      throw new StateError(
        `StateAggregator.aggregateChildStates: parent goal "${parentId}" not found`
      );
    }

    const childIds = parent.children_ids;
    const childGaps: Record<string, number> = {};
    const childCompletions: Record<string, boolean> = {};
    const childConfidences: number[] = [];

    for (const childId of childIds) {
      const child = await this.stateManager.loadGoal(childId);
      if (child === null) {
        // Missing child: treat as fully incomplete with low confidence
        childGaps[childId] = 1.0;
        childCompletions[childId] = false;
        childConfidences.push(0);
        continue;
      }

      const gap = computeChildGap(child);
      childGaps[childId] = gap;
      childCompletions[childId] = child.status === "completed";

      const minConf = minChildConfidence(child);
      childConfidences.push(minConf);
    }

    const aggregationMethod = this.resolveAggregationMethod(parentId);

    let aggregatedGap: number;
    if (childIds.length === 0) {
      aggregatedGap = 0;
    } else {
      const gapValues = childIds.map((id) => childGaps[id] ?? 1.0);

      if (aggregationMethod === "all_required") {
        // all_required: parent is blocked as long as any child is incomplete
        // Express as minimum fulfillment ratio (1 - gap)
        const fulfillmentRatios = gapValues.map((g) => 1 - g);
        const minFulfillment = aggregateValues(
          fulfillmentRatios,
          "all_required"
        );
        aggregatedGap = 1 - minFulfillment;
      } else {
        aggregatedGap = aggregateValues(gapValues, aggregationMethod);
      }
    }

    const aggregatedConfidence =
      childConfidences.length > 0 ? Math.min(...childConfidences) : 1.0;

    const clampedGap = Math.min(1, Math.max(0, aggregatedGap));

    // Persist aggregated progress back to the parent goal so that
    // `pulseed status --goal <id>` shows progress rather than "not yet measured".
    if (childIds.length > 0) {
      const freshParent = await this.stateManager.loadGoal(parentId);
      if (freshParent !== null && freshParent.dimensions.length > 0) {
        const now = new Date().toISOString();
        const updatedDimensions = freshParent.dimensions.map((dim) => {
          const t = dim.threshold;
          // Only update numeric threshold dimensions
          if (t.type === "present" || t.type === "match") return dim;

          // Derive a synthetic current_value from the aggregated progress (1 - gap)
          let syntheticValue: number;
          if (t.type === "min") {
            syntheticValue = t.value * (1 - clampedGap);
          } else if (t.type === "max") {
            // For max threshold: gap=0 means at/below cap (best), gap=1 means far above cap (worst).
            // syntheticValue must be ABOVE threshold when gap > 0, so use (1 + clampedGap).
            syntheticValue = t.value * (1 + clampedGap);
          } else {
            // range: use midpoint as reference
            const mid = (t.low + t.high) / 2;
            syntheticValue = mid * (1 - clampedGap);
          }

          return {
            ...dim,
            current_value: syntheticValue,
            confidence: aggregatedConfidence,
            last_updated: now,
          };
        });

        await this.stateManager.saveGoal({
          ...freshParent,
          dimensions: updatedDimensions,
          updated_at: now,
        });
      }
    }

    return {
      parent_id: parentId,
      aggregated_gap: clampedGap,
      aggregated_confidence: aggregatedConfidence,
      child_gaps: childGaps,
      child_completions: childCompletions,
      aggregation_method: aggregationMethod,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Downward Propagation ───

  /**
   * Propagate parent-level state changes down to all direct children.
   *
   * Two propagation types (goal-tree.md §5):
   *   a. Constraint propagation: new parent constraints are appended to children
   *      that don't already have them (idempotent).
   *   b. Deadline propagation: if the parent deadline differs from the children's
   *      proportional position, adjust each child's deadline proportionally.
   *
   * Note: this method reads the parent goal's CURRENT deadline; to propagate a
   * deadline change the caller must first save the updated parent, then call
   * propagateStateDown().
   *
   * @throws if the parent goal cannot be found.
   */
  async propagateStateDown(parentId: string): Promise<void> {
    const parent = await this.stateManager.loadGoal(parentId);
    if (parent === null) {
      throw new StateError(
        `StateAggregator.propagateStateDown: parent goal "${parentId}" not found`
      );
    }

    const parentDeadlineMs = parseDeadlineMs(parent.deadline);
    const now = Date.now();

    for (const childId of parent.children_ids) {
      const child = await this.stateManager.loadGoal(childId);
      if (child === null) continue;

      let updated = { ...child };

      // ─── a. Constraint propagation ───
      const existingConstraints = new Set(child.constraints);
      const newConstraints = parent.constraints.filter(
        (c) => !existingConstraints.has(c)
      );
      if (newConstraints.length > 0) {
        updated = {
          ...updated,
          constraints: [...child.constraints, ...newConstraints],
        };
      }

      // ─── b. Deadline propagation ───
      if (parentDeadlineMs !== null) {
        const childDeadlineMs = parseDeadlineMs(child.deadline);

        if (childDeadlineMs !== null) {
          // Proportional adjustment:
          //   remaining_parent = parentDeadline - now
          //   remaining_child  = childDeadline - now
          //   ratio = remaining_parent / original_remaining_parent
          // Since we don't store the "original" parent deadline, we derive
          // the ratio from how much of the parent's window is left relative
          // to the child's remaining window.  The simplest safe approach
          // (matching goal-tree.md §5) is:
          //   new_child_deadline = now + (childRemainingMs / parentRemainingMs) * parentRemainingMs
          // which simplifies to: keep child proportional within parent's window.
          //
          // Concretely: child gets the same ratio of parent's deadline window
          // as the child's remaining time relative to the parent.
          const parentRemainingMs = parentDeadlineMs - now;
          const childRemainingMs = childDeadlineMs - now;

          if (parentRemainingMs > 0 && childRemainingMs !== parentRemainingMs) {
            // New child deadline = now + min(childRemainingMs, parentRemainingMs)
            // so the child is never later than the parent.
            const newChildRemainingMs = Math.min(
              childRemainingMs,
              parentRemainingMs
            );
            const newChildDeadlineMs = now + newChildRemainingMs;
            updated = {
              ...updated,
              deadline: new Date(newChildDeadlineMs).toISOString(),
            };
          }
        }
      }

      if (
        updated.constraints !== child.constraints ||
        updated.deadline !== child.deadline
      ) {
        await this.stateManager.saveGoal({
          ...updated,
          updated_at: new Date().toISOString(),
        });
      }
    }
  }

  // ─── Completion Cascade ───

  /**
   * Walk up the tree from goalId and return IDs of ancestors that have
   * become eligible for completion because ALL of their children are either
   * "completed" or cancelled (treated as pruned-and-done).
   *
   * The starting goalId is treated as if it were already completed — this
   * allows callers to invoke checkCompletionCascade immediately after deciding
   * to complete a goal, before the status has been persisted.
   *
   * This method does NOT mutate any goal status — the caller decides what to
   * do with the returned list (e.g. mark them "completed").
   *
   * @param goalId Starting point (usually the goal that just completed).
   * @returns Ordered array of newly-completable ancestor IDs (bottom-up order).
   */
  async checkCompletionCascade(goalId: string): Promise<string[]> {
    const completable: string[] = [];

    // Track which goals are effectively complete for the purpose of this walk.
    // The starting goal is treated as complete even if its DB status is "active".
    const effectivelyComplete = new Set<string>([goalId]);

    let currentId: string | null = goalId;

    // Walk up the parent chain
    while (currentId !== null) {
      const current = await this.stateManager.loadGoal(currentId);
      if (current === null) break;

      const parentId = current.parent_id;
      if (parentId === null) break; // reached root — stop (root itself has no parent to cascade to)

      const parent = await this.stateManager.loadGoal(parentId);
      if (parent === null) break;

      // Check whether ALL children of the parent are done
      let allChildrenDone = true;
      for (const childId of parent.children_ids) {
        if (effectivelyComplete.has(childId)) continue; // treated as complete
        const child = await this.stateManager.loadGoal(childId);
        if (child === null) { allChildrenDone = false; break; }
        if (child.status === "completed" || child.status === "cancelled" || child.status === "abandoned") continue;
        allChildrenDone = false;
        break;
      }

      if (!allChildrenDone) break; // stop cascade — parent still blocked

      completable.push(parentId);
      // Mark parent as effectively complete so its own parent sees it as done
      effectivelyComplete.add(parentId);
      currentId = parentId;
    }

    return completable;
  }

  // ─── Helpers ───

  private resolveAggregationMethod(parentId: string): SatisficingAggregation {
    const rule = this.aggregationRules.get(parentId);
    return rule?.aggregation ?? "min";
  }
}

// ─── Module-level pure helpers ───

/**
 * Compute a normalized gap in [0, 1] for a goal by averaging the normalized
 * gap of each of its dimensions.
 *
 * Per-dimension formula (simplified, matches task spec):
 *   min threshold: max(0, (target - current) / target)  [guard: target=0 → 0 or 1]
 *   max threshold: max(0, (current - target) / target)  [guard: target=0 → 0 or 1]
 *   default:       |current - target| / max(|target|, 1)
 *
 * When current_value is null, the dimension gap is 1 (fully unmet).
 * When there are no dimensions, gap = 0 (consider it done).
 */
function computeChildGap(goal: Goal): number {
  if (goal.dimensions.length === 0) return 0;

  // If the goal is already completed/cancelled, gap = 0
  if (goal.status === "completed" || goal.status === "cancelled" || goal.status === "abandoned") return 0;

  const dimGaps = goal.dimensions.map((dim) => computeDimensionGapSimple(dim));
  const sum = dimGaps.reduce((acc, g) => acc + g, 0);
  return Math.min(1, Math.max(0, sum / dimGaps.length));
}

/**
 * Compute a simple normalized gap [0,1] for a single dimension.
 * Uses the formulas from the task spec rather than the full
 * confidence-weighted pipeline (which is used by GapCalculator for drive scoring).
 */
function computeDimensionGapSimple(dim: Dimension): number {
  if (dim.current_value === null) return 1;
  const prog = dimensionProgress(dim.current_value, dim.threshold);
  return prog === null ? 1 : 1 - prog;
}

/**
 * Compute the minimum confidence across all dimensions of a goal.
 * Returns 1.0 when there are no dimensions (nothing uncertain).
 */
function minChildConfidence(goal: Goal): number {
  if (goal.dimensions.length === 0) return 1.0;
  return Math.min(...goal.dimensions.map((d) => d.confidence));
}

/**
 * Parse an ISO 8601 deadline string into milliseconds since epoch.
 * Returns null if the deadline is null or unparseable.
 */
function parseDeadlineMs(deadline: string | null): number | null {
  if (deadline === null) return null;
  const ms = Date.parse(deadline);
  return isNaN(ms) ? null : ms;
}
