import type {
  CrossGoalAllocation,
  GoalPriorityFactors,
  MomentumInfo,
  DependencySchedule,
  AllocationStrategy,
  RebalanceAction,
} from "../../base/types/cross-portfolio.js";
import type { RebalanceResult } from "../../base/types/portfolio.js";

// ─── Helpers ───

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface AllocationConfig {
  max_concurrent_goals: number;
  min_goal_share: number;
}

// ─── Resource Allocation ───

/**
 * Allocate resource shares across goals based on their priority scores.
 *
 * Rules:
 *   1. If goals > max_concurrent_goals, lowest priority goals get allocation=0
 *      and are labelled "waiting".
 *   2. Active goals (up to max_concurrent_goals) share 1.0 proportionally to
 *      computed_priority, with a floor of min_goal_share.
 *   3. Sum of active allocations = 1.0.
 *
 * @param priorities — output from calculateGoalPriorities
 * @param config — allocation configuration (max_concurrent_goals, min_goal_share)
 * @param strategy   — optional AllocationStrategy (default: 'priority')
 * @param momentumMap — goalId → MomentumInfo, required when strategy.type === 'momentum'
 * @param depSchedule — DependencySchedule, required when strategy.type === 'dependency_aware'
 * @returns CrossGoalAllocation[] in the same order as priorities
 */
export function allocateResources(
  priorities: GoalPriorityFactors[],
  config: AllocationConfig,
  strategy?: AllocationStrategy,
  momentumMap?: Map<string, MomentumInfo>,
  depSchedule?: DependencySchedule
): CrossGoalAllocation[] {
  if (priorities.length === 0) return [];

  const { max_concurrent_goals, min_goal_share } = config;

  // Split into active (top N) and waiting (rest), already sorted desc
  const activeCount = Math.min(priorities.length, max_concurrent_goals);
  const activePriorities = priorities.slice(0, activeCount);
  const waitingPriorities = priorities.slice(activeCount);

  // Build allocations for waiting goals (zero share)
  const waitingAllocations: CrossGoalAllocation[] = waitingPriorities.map((p) => ({
    goal_id: p.goal_id,
    priority: p.computed_priority,
    resource_share: 0,
    adjustment_reason: `waiting: exceeds max_concurrent_goals (${max_concurrent_goals})`,
  }));

  if (activePriorities.length === 0) return waitingAllocations;

  // Single goal gets everything
  if (activePriorities.length === 1) {
    return [
      {
        goal_id: activePriorities[0]?.goal_id ?? "",
        priority: activePriorities[0]?.computed_priority ?? 0,
        resource_share: 1.0,
        adjustment_reason: "sole active goal",
      },
      ...waitingAllocations,
    ];
  }

  const n = activePriorities.length;

  // --- Strategy-specific weight computation ---
  const strategyType = strategy?.type ?? "priority";

  let weights: number[];
  let strategyReason: string;

  if (strategyType === "equal") {
    weights = activePriorities.map(() => 1);
    strategyReason = "equal allocation";
  } else if (strategyType === "momentum" && momentumMap && momentumMap.size > 0) {
    const momentumWeight = strategy?.momentumWeight ?? 0.5;
    // Blend priority and momentum velocity
    weights = activePriorities.map((p) => {
      const mom = momentumMap.get(p.goal_id);
      const vel = mom ? Math.max(mom.velocity, 0) : 0;
      return (1 - momentumWeight) * p.computed_priority + momentumWeight * vel;
    });
    strategyReason = "momentum-weighted";
  } else if (strategyType === "dependency_aware" && depSchedule) {
    // Goals on critical path and unblocked goals get a boost
    const criticalSet = new Set(depSchedule.criticalPath);
    // Determine which goals are currently unblocked (in phase 0 or phase whose blockedBy are empty)
    const unblockedGoals = new Set<string>();
    for (const phase of depSchedule.phases) {
      if (phase.blockedBy.length === 0) {
        for (const id of phase.goalIds) unblockedGoals.add(id);
      }
    }
    weights = activePriorities.map((p) => {
      let w = p.computed_priority;
      if (criticalSet.has(p.goal_id)) w *= 1.5;
      if (unblockedGoals.has(p.goal_id)) w *= 1.2;
      return w;
    });
    strategyReason = "dependency_aware";
  } else {
    // Default: priority-proportional
    weights = activePriorities.map((p) => p.computed_priority);
    strategyReason = "priority";
  }

  // Proportional allocation with guaranteed min_goal_share floor.
  //
  // Algorithm:
  //   1. Reserve min_goal_share for every active goal.
  //   2. Distribute the remaining budget (1 - n * min_goal_share) proportionally
  //      by computed weight.
  //   3. This guarantees every active goal has at least min_goal_share.
  //
  // Edge case: if n * min_goal_share >= 1 (too many goals for the floor to
  // allow proportional distribution), fall back to equal distribution.
  const reservedTotal = n * min_goal_share;

  let finalShares: number[];

  if (reservedTotal >= 1) {
    // No room for proportional top-up — give everyone an equal share
    finalShares = activePriorities.map(() => 1 / n);
  } else {
    const remainingBudget = 1 - reservedTotal;
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);

    if (totalWeight === 0) {
      // All zero — split remaining budget equally
      finalShares = activePriorities.map(() => min_goal_share + remainingBudget / n);
    } else {
      finalShares = weights.map(
        (w) => min_goal_share + remainingBudget * (w / totalWeight)
      );
    }
  }

  // Track which goals received the floor for reason strings
  const totalWeightForReason = weights.reduce((sum, w) => sum + w, 0);
  const rawShares = totalWeightForReason === 0
    ? activePriorities.map(() => 1 / n)
    : weights.map((w) => w / totalWeightForReason);

  const activeAllocations: CrossGoalAllocation[] = activePriorities.map((p, i) => {
    const share = finalShares[i]!;
    const raw = rawShares[i]!;
    let reason: string;
    if (raw < min_goal_share) {
      reason = `min_goal_share floor applied (raw=${raw.toFixed(3)}, strategy=${strategyReason})`;
    } else {
      reason = `${strategyReason}: weight=${(weights[i] ?? 0).toFixed(3)}`;
    }
    return {
      goal_id: p.goal_id,
      priority: p.computed_priority,
      resource_share: share,
      adjustment_reason: reason,
    };
  });

  return [...activeAllocations, ...waitingAllocations];
}

// ─── Stall Rebalancing ───

/**
 * Detect stalled goals and redistribute their resources to progressing goals.
 *
 * A goal is considered stalled if its MomentumInfo.trend === 'stalled'.
 * Resources from stalled goals are redistributed proportionally to
 * non-stalled goals based on their velocity.
 *
 * @param currentAllocations — current CrossGoalAllocation array
 * @param momentumMap — goalId → MomentumInfo
 * @returns array of RebalanceActions taken (empty if no stalled goals)
 */
export function rebalanceOnStall(
  currentAllocations: CrossGoalAllocation[],
  momentumMap: Map<string, MomentumInfo>
): RebalanceAction[] {
  const actions: RebalanceAction[] = [];

  if (currentAllocations.length === 0) return actions;

  const stalled: CrossGoalAllocation[] = [];
  const progressing: CrossGoalAllocation[] = [];

  for (const alloc of currentAllocations) {
    const mom = momentumMap.get(alloc.goal_id);
    if (!mom) continue; // unknown momentum — keep current allocation
    if (mom.trend === "stalled") {
      stalled.push(alloc);
    } else {
      progressing.push(alloc);
    }
  }

  if (stalled.length === 0) return actions;

  // Nothing to redistribute to
  if (progressing.length === 0) return actions;

  // Calculate total share to redistribute
  const redistributeTotal = stalled.reduce((s, a) => s + a.resource_share, 0);

  // Compute target shares for progressing goals, weighted by velocity
  const totalVelocity = progressing.reduce((s, a) => {
    const mom = momentumMap.get(a.goal_id);
    return s + Math.max(mom?.velocity ?? 0, 0);
  }, 0);

  for (const alloc of stalled) {
    actions.push({
      goalId: alloc.goal_id,
      action: "reduce",
      reason: "stalled: momentum velocity ≈ 0",
      previousShare: alloc.resource_share,
      newShare: 0,
    });
  }

  for (const alloc of progressing) {
    const mom = momentumMap.get(alloc.goal_id);
    const vel = Math.max(mom?.velocity ?? 0, 0);
    const bonus =
      totalVelocity > 0
        ? redistributeTotal * (vel / totalVelocity)
        : redistributeTotal / progressing.length;
    const newShare = clamp(alloc.resource_share + bonus, 0, 1);

    actions.push({
      goalId: alloc.goal_id,
      action: "increase",
      reason: `received share from stalled goals (velocity=${vel.toFixed(4)})`,
      previousShare: alloc.resource_share,
      newShare,
    });
  }

  return actions;
}

// ─── Strategy Helpers ───

/**
 * Check if a strategy is a WaitStrategy (has wait-specific fields).
 * Pure function — no class dependency.
 */
export function isWaitStrategy(strategy: Record<string, unknown>): boolean {
  return (
    typeof strategy["wait_reason"] === "string" &&
    typeof strategy["wait_until"] === "string" &&
    typeof strategy["measurement_plan"] === "string"
  );
}

/**
 * Check whether a strategy should be terminated.
 *
 * Three conditions (design doc sec 6.4):
 * 1. Lowest effectiveness score for 3 consecutive rebalances at min allocation
 * 2. consecutive_stall_count >= 3
 * 3. Resource consumption > 2x estimate
 */
export function checkStrategyTermination(
  strategy: {
    id: string;
    goal_id: string;
    consecutive_stall_count: number;
    tasks_generated: unknown[];
    allocation: number;
    resource_estimate: { sessions: number };
    effectiveness_score: number | null;
  },
  records: Array<{ strategy_id: string; effectiveness_score: number | null }>,
  config: {
    termination_stall_count: number;
    termination_resource_multiplier: number;
    min_allocation: number;
    termination_min_rebalances: number;
  },
  rebalanceHistory: Map<string, RebalanceResult[]>,
  countConsecutiveLowest: (
    strategyId: string,
    history: RebalanceResult[],
    minAllocation: number
  ) => number
): boolean {
  if (strategy.consecutive_stall_count >= config.termination_stall_count) {
    return true;
  }

  const sessionsConsumed = strategy.tasks_generated.length;
  const estimatedSessions = strategy.resource_estimate.sessions;
  if (
    estimatedSessions > 0 &&
    sessionsConsumed > estimatedSessions * config.termination_resource_multiplier
  ) {
    return true;
  }

  if (strategy.allocation <= config.min_allocation) {
    const record = records.find((r) => r.strategy_id === strategy.id);
    if (record?.effectiveness_score !== null && record !== undefined) {
      const otherScores = records
        .filter(
          (r) =>
            r.strategy_id !== strategy.id &&
            r.effectiveness_score !== null
        )
        .map((r) => r.effectiveness_score!);

      if (otherScores.length > 0) {
        const isLowest = otherScores.every(
          (s) => s >= record.effectiveness_score!
        );
        if (isLowest) {
          const history = rebalanceHistory.get(strategy.goal_id) ?? [];
          const recentCount = countConsecutiveLowest(
            strategy.id,
            history,
            config.min_allocation
          );
          if (recentCount >= config.termination_min_rebalances) {
            return true;
          }
        }
      }
    }
  }

  return false;
}
