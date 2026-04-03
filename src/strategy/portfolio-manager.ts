import { StrategyManager } from "./strategy-manager.js";
import { StateManager } from "../state/state-manager.js";
import { StrategySchema } from "../types/strategy.js";
import type { Strategy, Portfolio } from "../types/strategy.js";
import { PortfolioConfigSchema } from "../types/portfolio.js";
import type {
  PortfolioConfig,
  EffectivenessRecord,
  TaskSelectionResult,
  RebalanceTrigger,
  RebalanceResult,
} from "../types/portfolio.js";
import {
  calculateInitialAllocations,
  countConsecutiveLowestRebalances,
  redistributeAllocation,
  adjustAllocations,
  handleWaitStrategyExpiry as _handleWaitStrategyExpiry,
  selectNextStrategyAcrossGoals as _selectNextStrategyAcrossGoals,
  getCurrentGapForDimension as _getCurrentGapForDimension,
  calculateGapDeltaForStrategy as _calculateGapDeltaForStrategy,
} from "./portfolio-rebalance.js";

/**
 * PortfolioManager provides portfolio-level orchestration on top of StrategyManager.
 *
 * Responsibilities:
 * - Deterministic task-strategy selection (which strategy should generate the next task)
 * - Effectiveness measurement per strategy (gap delta / sessions consumed)
 * - Rebalance triggering and execution (allocation adjustment, termination)
 * - Wait-strategy lifecycle management
 *
 * PortfolioManager does NOT replace StrategyManager — it coordinates across strategies.
 */
export class PortfolioManager {
  private readonly strategyManager: StrategyManager;
  private readonly stateManager: StateManager;
  private readonly config: PortfolioConfig;

  /** goalId → timestamp of last rebalance */
  private readonly lastRebalanceTime: Map<string, number> = new Map();

  /** goalId → list of past rebalance results */
  private readonly rebalanceHistory: Map<string, RebalanceResult[]> =
    new Map();

  /** strategyId → timestamp of last task completion */
  private readonly lastTaskCompletionByStrategy: Map<string, number> =
    new Map();

  constructor(
    strategyManager: StrategyManager,
    stateManager: StateManager,
    config?: Partial<PortfolioConfig>
  ) {
    this.strategyManager = strategyManager;
    this.stateManager = stateManager;
    this.config = PortfolioConfigSchema.parse(config ?? {});
  }

  // ─── Public Methods ───

  /**
   * Select the next strategy that should generate a task for the given goal.
   *
   * Uses a deterministic "wait ratio" approach: for each active strategy,
   * compute (time since last task completion) / allocation. The strategy
   * with the highest ratio is the most "starved" and gets selected next.
   *
   * WaitStrategy instances are skipped (they do not generate tasks).
   * Returns null if no eligible active strategies exist.
   */
  async selectNextStrategyForTask(goalId: string): Promise<TaskSelectionResult | null> {
    const portfolio = await this.strategyManager.getPortfolio(goalId);
    if (!portfolio) return null;

    const activeStrategies = portfolio.strategies.filter(
      (s: Strategy) => s.state === "active" || s.state === "evaluating"
    );

    const eligible = activeStrategies.filter((s: Strategy) => !this.isWaitStrategy(s));
    if (eligible.length === 0) return null;

    const now = Date.now();
    const portfolioCreatedAt = new Date(
      portfolio.last_rebalanced_at
    ).getTime();

    let bestStrategy: Strategy | null = null;
    let bestRatio = -Infinity;

    for (const strategy of eligible) {
      const lastCompletion =
        this.lastTaskCompletionByStrategy.get(strategy.id) ??
        (strategy.started_at
          ? new Date(strategy.started_at).getTime()
          : portfolioCreatedAt);

      const elapsed = now - lastCompletion;
      const allocation = strategy.allocation > 0 ? strategy.allocation : 0.01;
      const ratio = elapsed / allocation;

      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestStrategy = strategy;
      }
    }

    if (!bestStrategy) return null;

    return {
      strategy_id: bestStrategy.id,
      reason: `Highest wait ratio (${bestRatio.toFixed(0)}ms/alloc) — most starved for task execution`,
      wait_ratio: bestRatio,
    };
  }

  /**
   * Calculate effectiveness records for all active strategies of a goal.
   *
   * effectiveness_score = gap_delta_attributed / sessions_consumed
   *
   * Uses dimension-target matching (method 2): sum gap changes in each
   * strategy's target_dimensions and attribute them to that strategy.
   *
   * Requires a minimum number of task completions (default 3) before
   * producing a non-null score.
   */
  async calculateEffectiveness(goalId: string): Promise<EffectivenessRecord[]> {
    const portfolio = await this.strategyManager.getPortfolio(goalId);
    if (!portfolio) return [];

    const activeStrategies = portfolio.strategies.filter(
      (s: Strategy) => s.state === "active" || s.state === "evaluating"
    );

    const now = new Date().toISOString();
    const records: EffectivenessRecord[] = [];

    for (const strategy of activeStrategies) {
      const sessionsConsumed = strategy.tasks_generated.length;
      const gapDelta = await this.calculateGapDeltaForStrategy(strategy, goalId);

      let score: number | null = null;
      if (sessionsConsumed >= this.config.effectiveness_min_tasks) {
        score =
          sessionsConsumed > 0 ? gapDelta / sessionsConsumed : 0;
      }

      records.push({
        strategy_id: strategy.id,
        gap_delta_attributed: gapDelta,
        sessions_consumed: sessionsConsumed,
        effectiveness_score: score,
        last_calculated_at: now,
      });
    }

    return records;
  }

  /**
   * Check whether a rebalance is needed for the given goal.
   *
   * Two trigger types:
   * - periodic: rebalance_interval has elapsed since last rebalance
   * - score_change: any effectiveness_score changed 50%+ since last rebalance
   *
   * Returns the trigger or null.
   */
  async shouldRebalance(goalId: string): Promise<RebalanceTrigger | null> {
    const now = Date.now();

    const lastRebalance = this.lastRebalanceTime.get(goalId) ?? 0;
    const intervalMs = this.config.rebalance_interval_hours * 60 * 60 * 1000;
    if (lastRebalance > 0 && now - lastRebalance >= intervalMs) {
      return {
        type: "periodic",
        strategy_id: null,
        details: `Rebalance interval (${this.config.rebalance_interval_hours}h) has elapsed`,
      };
    }

    const currentRecords = await this.calculateEffectiveness(goalId);
    const history = this.rebalanceHistory.get(goalId) ?? [];
    if (history.length === 0) return null;

    for (const record of currentRecords) {
      if (record.effectiveness_score === null) continue;

      const portfolio = await this.strategyManager.getPortfolio(goalId);
      if (!portfolio) continue;

      const strategy = portfolio.strategies.find(
        (s: Strategy) => s.id === record.strategy_id
      );
      if (!strategy || strategy.effectiveness_score === null) continue;

      const previousScore = strategy.effectiveness_score;
      if (previousScore === 0) continue;

      const changeRatio = Math.abs(
        (record.effectiveness_score - previousScore) / previousScore
      );
      if (changeRatio >= 0.5) {
        return {
          type: "score_change",
          strategy_id: record.strategy_id,
          details: `Effectiveness score changed by ${(changeRatio * 100).toFixed(0)}% (${previousScore.toFixed(3)} → ${record.effectiveness_score.toFixed(3)})`,
        };
      }
    }

    return null;
  }

  /**
   * Execute a rebalance for the given goal based on the trigger.
   *
   * Logic (design doc sec 6.3):
   * - All scores null: no change
   * - Score ratio < 2.0: no change
   * - Score ratio >= 2.0: increase high-performer allocation, decrease low-performer
   *   (respect min 0.1)
   * - Check termination conditions and terminate if met
   * - If all terminated: set new_generation_needed = true
   * - Redistribute terminated strategy allocation proportionally
   */
  async rebalance(goalId: string, trigger: RebalanceTrigger): Promise<RebalanceResult> {
    const now = new Date().toISOString();
    const records = await this.calculateEffectiveness(goalId);
    const portfolio = await this.strategyManager.getPortfolio(goalId);

    const result: RebalanceResult = {
      triggered_by: trigger.type,
      timestamp: now,
      adjustments: [],
      terminated_strategies: [],
      new_generation_needed: false,
    };

    if (!portfolio) {
      await this.recordRebalance(goalId, result);
      return result;
    }

    const activeStrategies = portfolio.strategies.filter(
      (s: Strategy) => s.state === "active" || s.state === "evaluating"
    );

    for (const strategy of activeStrategies) {
      if (this.checkTermination(strategy, records)) {
        await this.strategyManager.updateState(strategy.id, "terminated");
        result.terminated_strategies.push(strategy.id);
      }
    }

    const remainingStrategies = activeStrategies.filter(
      (s: Strategy) => !result.terminated_strategies.includes(s.id)
    );

    if (
      remainingStrategies.length === 0 &&
      result.terminated_strategies.length > 0
    ) {
      result.new_generation_needed = true;
      await this.recordRebalance(goalId, result);
      return result;
    }

    if (result.terminated_strategies.length > 0 && remainingStrategies.length > 0) {
      const freedAllocation = result.terminated_strategies.reduce(
        (sum: number, sid: string) => {
          const s = activeStrategies.find((st: Strategy) => st.id === sid);
          return sum + (s?.allocation ?? 0);
        },
        0
      );
      redistributeAllocation(
        goalId,
        remainingStrategies,
        records,
        freedAllocation,
        this.config,
        result,
        (gId, sId, alloc) => this.updateStrategyAllocation(gId, sId, alloc)
      );
    }

    const scoredRecords = records.filter(
      (r) =>
        r.effectiveness_score !== null &&
        remainingStrategies.some((s) => s.id === r.strategy_id)
    );

    if (scoredRecords.length >= 2) {
      const scores = scoredRecords.map((r) => r.effectiveness_score!);
      const maxScore = Math.max(...scores);
      const minScore = Math.min(...scores);

      if (minScore > 0 && maxScore / minScore >= this.config.score_ratio_threshold) {
        adjustAllocations(
          goalId,
          remainingStrategies,
          scoredRecords,
          this.config,
          result,
          (gId, sId, alloc) => this.updateStrategyAllocation(gId, sId, alloc)
        );
      }
    }

    this.recordRebalance(goalId, result);
    return result;
  }

  /**
   * Check whether a strategy should be terminated.
   *
   * Three conditions (design doc sec 6.4):
   * 1. Lowest effectiveness score for 3 consecutive rebalances at min allocation
   * 2. consecutive_stall_count >= 3
   * 3. Resource consumption > 2x estimate
   */
  checkTermination(
    strategy: Strategy,
    records: EffectivenessRecord[]
  ): boolean {
    if (strategy.consecutive_stall_count >= this.config.termination_stall_count) {
      return true;
    }

    const sessionsConsumed = strategy.tasks_generated.length;
    const estimatedSessions = strategy.resource_estimate.sessions;
    if (
      estimatedSessions > 0 &&
      sessionsConsumed >
        estimatedSessions * this.config.termination_resource_multiplier
    ) {
      return true;
    }

    if (strategy.allocation <= this.config.min_allocation) {
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
            const history = this.rebalanceHistory.get(strategy.goal_id) ?? [];
            const recentCount = countConsecutiveLowestRebalances(
              strategy.id,
              history,
              this.config.min_allocation
            );
            if (recentCount >= this.config.termination_min_rebalances) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  /**
   * Activate multiple strategies with initial allocation.
   *
   * Single strategy: allocation = 1.0
   * Multiple: equal split as default, respecting min 0.1 and max 0.7, sum = 1.0
   */
  activateStrategies(goalId: string, strategyIds: string[]): void {
    if (strategyIds.length === 0) return;

    const allocations = calculateInitialAllocations(
      strategyIds.length,
      this.config
    );

    for (let i = 0; i < strategyIds.length; i++) {
      const strategyId = strategyIds[i];
      this.strategyManager.updateState(strategyId, "active");
      this.updateStrategyAllocation(goalId, strategyId, allocations[i]);
    }
  }

  /**
   * Check if a strategy is a WaitStrategy (has wait-specific fields).
   */
  isWaitStrategy(strategy: Strategy): boolean {
    const waitFields = strategy as Record<string, unknown>;
    return (
      typeof waitFields["wait_reason"] === "string" &&
      typeof waitFields["wait_until"] === "string" &&
      typeof waitFields["measurement_plan"] === "string"
    );
  }

  /**
   * Handle expiry of a WaitStrategy.
   *
   * When wait_until has passed:
   * - Gap improved: return null (let the wait strategy continue its evaluation)
   * - Gap unchanged: activate fallback strategy if one exists
   * - Gap worsened: return rebalance trigger
   */
  async handleWaitStrategyExpiry(
    goalId: string,
    strategyId: string
  ): Promise<RebalanceTrigger | null> {
    const portfolio = await this.strategyManager.getPortfolio(goalId);
    if (!portfolio) return null;

    const strategy = portfolio.strategies.find((s: Strategy) => s.id === strategyId);
    if (!strategy) return null;

    return _handleWaitStrategyExpiry(
      goalId,
      strategyId,
      strategy,
      (s) => this.isWaitStrategy(s),
      (gId, dim) => this.getCurrentGapForDimension(gId, dim),
      (sId, state) => this.strategyManager.updateState(sId, state as "active"),
      async (gId) => (await this.strategyManager.getPortfolio(gId))?.strategies ?? []
    );
  }

  /**
   * Record a task completion timestamp for a strategy.
   * Called externally when a task finishes execution.
   */
  recordTaskCompletion(strategyId: string): void {
    this.lastTaskCompletionByStrategy.set(strategyId, Date.now());
  }

  /**
   * Get the rebalance history for a goal.
   */
  getRebalanceHistory(goalId: string): RebalanceResult[] {
    return this.rebalanceHistory.get(goalId) ?? [];
  }

  /**
   * Select the next strategy to execute across multiple goals.
   *
   * Uses CrossGoalPortfolio's allocation to determine which goal gets the
   * next turn (most underserved relative to its allocation), then selects
   * a strategy within that goal using selectNextStrategyForTask().
   *
   * Returns null if no strategies are available across all goals.
   */
  async selectNextStrategyAcrossGoals(
    goalIds: string[],
    goalAllocations: Map<string, number>
  ): Promise<{
    goal_id: string;
    strategy_id: string | null;
    selection_reason: string;
  } | null> {
    return _selectNextStrategyAcrossGoals(
      goalIds,
      goalAllocations,
      this.goalTaskCounts,
      (goalId) => this.selectNextStrategyForTask(goalId)
    );
  }

  /**
   * Track how many tasks have been dispatched per goal.
   * Updated via recordGoalTaskDispatched().
   */
  readonly goalTaskCounts: Map<string, number> = new Map();

  /**
   * Record that a task was dispatched for the given goal.
   * Used by selectNextStrategyAcrossGoals() to track saturation.
   */
  recordGoalTaskDispatched(goalId: string): void {
    this.goalTaskCounts.set(goalId, (this.goalTaskCounts.get(goalId) ?? 0) + 1);
  }

  // ─── Private Helpers ───

  private async calculateGapDeltaForStrategy(strategy: Strategy, goalId: string): Promise<number> {
    return _calculateGapDeltaForStrategy(
      strategy,
      goalId,
      async (path) => await this.stateManager.readRaw(path)
    );
  }

  private async getCurrentGapForDimension(goalId: string, dimension: string): Promise<number | null> {
    return _getCurrentGapForDimension(
      goalId,
      dimension,
      async (path) => await this.stateManager.readRaw(path)
    );
  }

  /**
   * Update a single strategy's allocation in the portfolio.
   * Reads portfolio, modifies the strategy, and writes back.
   */
  private async updateStrategyAllocation(
    goalId: string,
    strategyId: string,
    allocation: number
  ): Promise<void> {
    const portfolio = await this.strategyManager.getPortfolio(goalId);
    if (!portfolio) return;

    const updated: Portfolio = {
      ...portfolio,
      strategies: portfolio.strategies.map((s) =>
        s.id === strategyId
          ? StrategySchema.parse({ ...s, allocation })
          : s
      ),
    };

    await this.strategyManager.savePortfolio(goalId, updated);
  }

  /**
   * Record a rebalance result and update tracking state.
   */
  private async recordRebalance(goalId: string, result: RebalanceResult): Promise<void> {
    this.lastRebalanceTime.set(goalId, Date.now());

    const history = this.rebalanceHistory.get(goalId) ?? [];
    history.push(result);
    this.rebalanceHistory.set(goalId, history);

    await this.stateManager.writeRaw(
      `strategies/${goalId}/rebalance-history.json`,
      history
    );
  }
}
