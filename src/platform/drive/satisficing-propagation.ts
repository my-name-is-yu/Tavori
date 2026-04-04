import { StateManager } from "../../base/state/state-manager.js";
import type { Goal } from "../../base/types/goal.js";
import type {
  CompletionJudgment,
  SatisficingStatus,
} from "../../base/types/satisficing.js";
import { aggregateValues, getSatisfiedValue } from "./satisficing-helpers.js";
import type { Logger } from "../../runtime/logger.js";

/**
 * Judge completion of an entire goal tree by checking all children recursively.
 * Non-leaf nodes are complete when all children are completed or cancelled(merged).
 *
 * @param rootId The ID of the root goal of the tree.
 * @param stateManager StateManager instance for loading goals.
 * @param isGoalComplete Function to check leaf node completion.
 * @returns CompletionJudgment for the root node.
 */
export async function judgeTreeCompletion(
  rootId: string,
  stateManager: StateManager,
  isGoalComplete: (goal: Goal, convergenceStatuses?: Map<string, SatisficingStatus>) => CompletionJudgment,
  convergenceStatuses?: Map<string, SatisficingStatus>
): Promise<CompletionJudgment> {
  const goal = await stateManager.loadGoal(rootId);
  if (goal === null) {
    return {
      is_complete: false,
      blocking_dimensions: [],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    };
  }

  // Leaf node (no children): delegate to existing isGoalComplete
  if (!goal.children_ids || goal.children_ids.length === 0) {
    return isGoalComplete(goal, convergenceStatuses);
  }

  // Non-leaf node: check all children recursively
  const blockingDimensions: string[] = [];
  const lowConfidenceDimensions: string[] = [];
  let needsVerification = false;

  for (const childId of goal.children_ids) {
    const child = await stateManager.loadGoal(childId);

    // Missing child is treated as blocking
    if (child === null) {
      blockingDimensions.push(childId);
      continue;
    }

    // Cancelled children count as complete (covers "merged" prune reason)
    if (child.status === "cancelled") {
      continue;
    }

    // Recurse into child
    const childJudgment = await judgeTreeCompletion(childId, stateManager, isGoalComplete, convergenceStatuses);

    if (!childJudgment.is_complete) {
      // Aggregate child's blocking and low-confidence dimensions
      for (const dim of childJudgment.blocking_dimensions) {
        if (!blockingDimensions.includes(dim)) {
          blockingDimensions.push(dim);
        }
      }
      for (const dim of childJudgment.low_confidence_dimensions) {
        if (!lowConfidenceDimensions.includes(dim)) {
          lowConfidenceDimensions.push(dim);
        }
      }
    }

    if (childJudgment.needs_verification_task) {
      needsVerification = true;
    }
  }

  const isComplete = blockingDimensions.length === 0 && lowConfidenceDimensions.length === 0;

  return {
    is_complete: isComplete,
    blocking_dimensions: blockingDimensions,
    low_confidence_dimensions: lowConfidenceDimensions,
    needs_verification_task: needsVerification,
    checked_at: new Date().toISOString(),
  };
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
 * @param stateManager StateManager instance.
 * @param computeActualProgress Function to compute progress for a dimension.
 * @param subgoalDimensions Optional subgoal dimensions for aggregation mapping.
 */
export async function propagateSubgoalCompletion(
  subgoalId: string,
  parentGoalId: string,
  stateManager: StateManager,
  computeActualProgress: (dim: import("../../base/types/goal.js").Dimension) => number,
  subgoalDimensions?: import("../../base/types/goal.js").Dimension[],
  logger?: Logger
): Promise<void> {
  const parentGoal = await stateManager.loadGoal(parentGoalId);
  if (parentGoal === null) {
    throw new Error(
      `propagateSubgoalCompletion: parent goal "${parentGoalId}" not found`
    );
  }

  const now = new Date().toISOString();

  // Phase 2: if subgoalDimensions are provided and any has dimension_mapping, use aggregation path
  if (subgoalDimensions && subgoalDimensions.length > 0) {
    const mappedDims = subgoalDimensions.filter((d) => d.dimension_mapping !== null);
    const unmappedDims = subgoalDimensions.filter((d) => d.dimension_mapping === null);

    // Process mapped dimensions: group by parent_dimension
    const parentDimUpdates = new Map<string, number>();

    if (mappedDims.length > 0) {
      // Group subgoal dimensions by target parent_dimension
      const grouped = new Map<string, import("../../base/types/goal.js").Dimension[]>();
      for (const dim of mappedDims) {
        // dimension_mapping is non-null: mappedDims is filtered to only include dims with non-null mapping
        const mapping = dim.dimension_mapping ?? { parent_dimension: "", aggregation: "average" as const };
        const existing = grouped.get(mapping.parent_dimension) ?? [];
        existing.push(dim);
        grouped.set(mapping.parent_dimension, existing);
      }

      // Compute aggregated value for each parent dimension
      for (const [parentDimName, dims] of grouped) {
        // dims is non-empty (grouped entries are only created when pushing to them above)
        // dimension_mapping is non-null for all dims in this group (filtered by mappedDims)
        const firstDim = dims[0];
        const aggregation = firstDim?.dimension_mapping?.aggregation ?? "avg";

        const numericValues: number[] = [];
        const fulfillmentRatios: number[] = [];

        for (const dim of dims) {
          const cv = dim.current_value;
          if (typeof cv === "number") {
            numericValues.push(cv);
          } else if (typeof cv === "boolean") {
            numericValues.push(cv ? 1 : 0);
          } else if (typeof cv === "string") {
            const parsed = Number(cv);
            if (!isNaN(parsed)) {
              numericValues.push(parsed);
            } else {
              // Non-numeric in avg mode: skip with warning
              if (aggregation === "avg") {
                logger?.warn(
                  `propagateSubgoalCompletion: skipping non-numeric current_value "${cv}" for dimension "${dim.name}" in avg aggregation`
                );
              }
            }
          }
          // For all_required: also compute fulfillment ratio
          if (aggregation === "all_required") {
            const progress = computeActualProgress(dim);
            fulfillmentRatios.push(progress);
          }
        }

        const thresholds = dims.map((d) => {
          const th = d.threshold;
          if (th.type === "min") return th.value;
          if (th.type === "max") return th.value;
          if (th.type === "range") return th.high;
          return 1;
        });

        const aggregated =
          aggregation === "all_required"
            ? aggregateValues(fulfillmentRatios, aggregation, thresholds)
            : aggregateValues(numericValues, aggregation, thresholds);

        parentDimUpdates.set(parentDimName, aggregated);
      }
    }

    // Build updated dimensions array for the parent goal
    let updatedDimensions = parentGoal.dimensions.map((d) => {
      if (parentDimUpdates.has(d.name)) {
        return { ...d, current_value: parentDimUpdates.get(d.name)!, last_updated: now };
      }
      return d;
    });

    // Process unmapped dimensions: fall back to name-based matching (MVP path)
    for (const unmappedDim of unmappedDims) {
      const matchedIndex = updatedDimensions.findIndex(
        (d) => d.name === unmappedDim.name || d.name.includes(unmappedDim.name)
      );
      if (matchedIndex !== -1) {
        const matchedDim = updatedDimensions[matchedIndex]!;
        const satisfiedValue = getSatisfiedValue(matchedDim);
        updatedDimensions = updatedDimensions.map((d, i) =>
          i === matchedIndex ? { ...d, current_value: satisfiedValue, last_updated: now } : d
        );
      }
    }

    await stateManager.saveGoal({
      ...parentGoal,
      dimensions: updatedDimensions,
      updated_at: now,
    });
    return;
  }

  // MVP path: name-based matching (backwards compatible)
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

  const updatedDimensions = parentGoal.dimensions.map((d, i) =>
    i === matchedDimIndex
      ? { ...d, current_value: satisfiedValue, last_updated: now }
      : d
  );

  await stateManager.saveGoal({
    ...parentGoal,
    dimensions: updatedDimensions,
    updated_at: now,
  });
}
