/**
 * portfolio-rebalance.ts
 *
 * Pure/stateless helpers for PortfolioManager rebalancing logic.
 * Functions here take configuration and data as explicit parameters
 * and return results without side effects (except via the provided
 * callbacks).
 */

import type {
  PortfolioConfig,
  EffectivenessRecord,
  RebalanceResult,
  AllocationAdjustment,
  RebalanceTrigger,
  TaskSelectionResult,
} from "../../base/types/portfolio.js";
import type { Strategy, WaitStrategy } from "../../base/types/strategy.js";

/**
 * Get the current gap value for a specific dimension of a goal.
 * Reads from gap data provided by the caller (StateManager.readRaw).
 */
export async function getCurrentGapForDimension(
  goalId: string,
  dimension: string,
  readRaw: (path: string) => unknown | Promise<unknown>
): Promise<number | null> {
  const raw = await readRaw(`gaps/${goalId}/current.json`);
  if (!raw || typeof raw !== "object") return null;

  const gaps = raw as Record<string, unknown>;
  const dimensionGap = gaps[dimension];
  if (typeof dimensionGap === "number") return dimensionGap;

  const dimensions = gaps["dimensions"];
  if (dimensions && typeof dimensions === "object") {
    const dimData = (dimensions as Record<string, unknown>)[dimension];
    if (dimData && typeof dimData === "object") {
      const nwg = (dimData as Record<string, unknown>)["normalized_weighted_gap"];
      if (typeof nwg === "number") return nwg;
    }
  }

  return null;
}

/**
 * Calculate gap delta attributed to a strategy using dimension-target matching.
 * Sums gap improvements across the strategy's target_dimensions.
 */
export async function calculateGapDeltaForStrategy(
  strategy: Strategy,
  goalId: string,
  readRaw: (path: string) => unknown | Promise<unknown>
): Promise<number> {
  let totalDelta = 0;

  for (const dimension of strategy.target_dimensions) {
    const currentGap = await getCurrentGapForDimension(goalId, dimension, readRaw);
    if (currentGap === null) continue;

    const baseline = strategy.gap_snapshot_at_start ?? 1.0;
    const delta = baseline - currentGap;
    totalDelta += delta;
  }

  return totalDelta;
}

/**
 * Calculate initial equal-split allocations for N strategies.
 * Single strategy: [1.0].
 * Multiple: equal split clamped to [min_allocation, max_allocation], sum = 1.0.
 */
export function calculateInitialAllocations(
  count: number,
  config: Pick<PortfolioConfig, "min_allocation" | "max_allocation">
): number[] {
  if (count === 1) return [1.0];

  const { min_allocation, max_allocation } = config;
  let base = 1.0 / count;

  base = Math.max(min_allocation, Math.min(max_allocation, base));

  const allocations = new Array<number>(count).fill(base);

  const sum = allocations.reduce((a, b) => a + b, 0);
  if (sum > 0 && Math.abs(sum - 1.0) > 0.001) {
    const factor = 1.0 / sum;
    for (let i = 0; i < allocations.length; i++) {
      allocations[i] = Math.max(
        min_allocation,
        Math.min(max_allocation, allocations[i] * factor)
      );
    }
    const finalSum = allocations.slice(0, -1).reduce((a, b) => a + b, 0);
    allocations[allocations.length - 1] = Math.max(
      min_allocation,
      1.0 - finalSum
    );
  }

  return allocations;
}

/**
 * Count how many consecutive recent rebalances a strategy has been the lowest scorer
 * (i.e., was adjusted down to min_allocation).
 */
export function countConsecutiveLowestRebalances(
  strategyId: string,
  history: RebalanceResult[],
  minAllocation: number
): number {
  let count = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const rebalance = history[i];
    const adjustment = rebalance.adjustments.find(
      (a) => a.strategy_id === strategyId
    );
    if (adjustment && adjustment.new_allocation <= minAllocation) {
      count++;
    } else {
      break;
    }
  }

  return count;
}

/**
 * Redistribute freed allocation proportionally among remaining strategies
 * based on effectiveness scores.
 *
 * Calls updateAllocation(goalId, strategyId, newAllocation) for each change.
 */
export function redistributeAllocation(
  goalId: string,
  remaining: Strategy[],
  records: EffectivenessRecord[],
  freedAllocation: number,
  config: Pick<PortfolioConfig, "max_allocation">,
  result: RebalanceResult,
  updateAllocation: (
    goalId: string,
    strategyId: string,
    allocation: number
  ) => void
): void {
  if (remaining.length === 0 || freedAllocation <= 0) return;

  const scoredRemaining = remaining.map((s) => {
    const record = records.find((r) => r.strategy_id === s.id);
    return {
      strategy: s,
      score: record?.effectiveness_score ?? 0,
    };
  });

  const totalScore = scoredRemaining.reduce(
    (sum, r) => sum + Math.max(r.score, 0),
    0
  );

  for (const { strategy, score } of scoredRemaining) {
    const proportion =
      totalScore > 0
        ? Math.max(score, 0) / totalScore
        : 1.0 / remaining.length;
    const additionalAllocation = freedAllocation * proportion;
    const oldAllocation = strategy.allocation;
    const newAllocation = Math.min(
      config.max_allocation,
      oldAllocation + additionalAllocation
    );

    if (Math.abs(newAllocation - oldAllocation) > 0.001) {
      updateAllocation(goalId, strategy.id, newAllocation);
      result.adjustments.push({
        strategy_id: strategy.id,
        old_allocation: oldAllocation,
        new_allocation: newAllocation,
        reason: "Redistribution from terminated strategy",
      });
    }
  }
}

/**
 * Adjust allocations based on effectiveness scores.
 * Increases high-performers, decreases low-performers.
 *
 * Calls updateAllocation(goalId, strategyId, newAllocation) for each change.
 */
export function adjustAllocations(
  goalId: string,
  strategies: Strategy[],
  scoredRecords: EffectivenessRecord[],
  config: Pick<PortfolioConfig, "min_allocation" | "max_allocation">,
  result: RebalanceResult,
  updateAllocation: (
    goalId: string,
    strategyId: string,
    allocation: number
  ) => void
): void {
  const sorted = [...scoredRecords].sort(
    (a, b) => (b.effectiveness_score ?? 0) - (a.effectiveness_score ?? 0)
  );

  const totalScore = sorted.reduce(
    (sum, r) => sum + Math.max(r.effectiveness_score ?? 0, 0),
    0
  );
  if (totalScore <= 0) return;

  const adjustments: AllocationAdjustment[] = [];
  const newAllocations: Map<string, number> = new Map();

  for (const record of sorted) {
    const strategy = strategies.find((s) => s.id === record.strategy_id);
    if (!strategy) continue;

    const proportion =
      Math.max(record.effectiveness_score ?? 0, 0) / totalScore;
    let targetAllocation = proportion;

    targetAllocation = Math.max(
      config.min_allocation,
      Math.min(config.max_allocation, targetAllocation)
    );

    newAllocations.set(strategy.id, targetAllocation);
  }

  const rawSum = Array.from(newAllocations.values()).reduce((a, b) => a + b, 0);
  if (rawSum > 0 && Math.abs(rawSum - 1.0) > 0.001) {
    const factor = 1.0 / rawSum;
    for (const [id, alloc] of newAllocations) {
      newAllocations.set(
        id,
        Math.max(config.min_allocation, alloc * factor)
      );
    }
  }

  for (const [strategyId, newAllocation] of newAllocations) {
    const strategy = strategies.find((s) => s.id === strategyId);
    if (!strategy) continue;

    const oldAllocation = strategy.allocation;
    if (Math.abs(newAllocation - oldAllocation) > 0.001) {
      updateAllocation(goalId, strategyId, newAllocation);
      adjustments.push({
        strategy_id: strategyId,
        old_allocation: oldAllocation,
        new_allocation: newAllocation,
        reason: `Score-based rebalancing (effectiveness: ${
          scoredRecords
            .find((r) => r.strategy_id === strategyId)
            ?.effectiveness_score?.toFixed(3) ?? "N/A"
        })`,
      });
    }
  }

  result.adjustments.push(...adjustments);
}

/**
 * Handle expiry of a WaitStrategy.
 *
 * When wait_until has passed:
 * - Gap improved: return null
 * - Gap unchanged: activate fallback strategy if one exists
 * - Gap worsened: return rebalance trigger
 *
 * @param isWaitStrategy - predicate to detect WaitStrategy instances
 * @param getGap - get current gap for a dimension of a goal
 * @param updateState - transition a strategy to a new state
 * @param getPortfolioStrategies - get all strategies for a goal
 */
export async function handleWaitStrategyExpiry(
  goalId: string,
  strategyId: string,
  strategy: Strategy,
  isWaitStrategy: (s: Strategy) => boolean,
  getGap: (goalId: string, dimension: string) => number | null | Promise<number | null>,
  updateState: (strategyId: string, state: string) => void | Promise<void>,
  getPortfolioStrategies: (goalId: string) => Strategy[] | Promise<Strategy[]>
): Promise<RebalanceTrigger | null> {
  if (!isWaitStrategy(strategy)) return null;

  const waitStrategy = strategy as unknown as WaitStrategy;
  const waitUntil = new Date(waitStrategy.wait_until).getTime();
  const now = Date.now();

  if (now < waitUntil) return null;

  const startGap = strategy.gap_snapshot_at_start;
  if (startGap === null) return null;

  const currentGap = await getGap(goalId, strategy.primary_dimension);
  if (currentGap === null) return null;

  const gapDelta = currentGap - startGap;

  if (gapDelta < 0) {
    return null;
  }

  if (gapDelta === 0) {
    if (waitStrategy.fallback_strategy_id) {
      const strategies = await getPortfolioStrategies(goalId);
      const fallback = strategies.find(
        (s) => s.id === waitStrategy.fallback_strategy_id
      );
      if (fallback && fallback.state === "candidate") {
        await updateState(fallback.id, "active");
      }
    }
    return null;
  }

  return {
    type: "stall_detected",
    strategy_id: strategyId,
    details: `WaitStrategy expired with gap worsening: ${startGap.toFixed(3)} → ${currentGap.toFixed(3)}`,
  };
}

/**
 * Select the next strategy across multiple goals.
 *
 * Sorts goals by "saturation ratio" (tasks dispatched / allocation) — the most
 * underserved goal (lowest saturation) gets the next task. Within that goal,
 * selectStrategyForTask() picks the best strategy.
 *
 * @param goalTaskCounts - map of goalId → total tasks dispatched
 * @param selectStrategyForTask - select best strategy within one goal
 */
export async function selectNextStrategyAcrossGoals(
  goalIds: string[],
  goalAllocations: Map<string, number>,
  goalTaskCounts: Map<string, number>,
  selectStrategyForTask: (goalId: string) => TaskSelectionResult | null | Promise<TaskSelectionResult | null>
): Promise<{
  goal_id: string;
  strategy_id: string | null;
  selection_reason: string;
} | null> {
  if (goalIds.length === 0) return null;

  const scored = goalIds.map((goalId) => {
    const allocation = goalAllocations.get(goalId) ?? (1 / goalIds.length);
    const taskCount = goalTaskCounts.get(goalId) ?? 0;
    const saturation = allocation > 0 ? taskCount / allocation : Infinity;
    return { goalId, saturation, allocation };
  });

  scored.sort((a, b) => a.saturation - b.saturation);

  for (const { goalId, saturation } of scored) {
    const allocation = goalAllocations.get(goalId) ?? 0;
    if (allocation <= 0) continue;

    const selectionResult = await selectStrategyForTask(goalId);
    if (selectionResult !== null) {
      return {
        goal_id: goalId,
        strategy_id: selectionResult.strategy_id,
        selection_reason: `Goal selected (saturation=${saturation.toFixed(2)}, allocation=${allocation.toFixed(2)}): ${selectionResult.reason}`,
      };
    }
  }

  return null;
}
