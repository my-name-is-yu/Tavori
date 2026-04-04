import { randomUUID } from "node:crypto";
import { StrategySchema, WaitStrategySchema } from "../../base/types/strategy.js";
import type { Strategy } from "../../base/types/strategy.js";
import { redistributeAllocation } from "./strategy-helpers.js";
import { StrategyManagerBase } from "./strategy-manager-base.js";

export { VALID_TRANSITIONS, StrategyArraySchema, buildGenerationPrompt, redistributeAllocation, detectStrategyGap } from "./strategy-helpers.js";
export { StrategyManagerBase } from "./strategy-manager-base.js";

/**
 * StrategyManager manages strategy lifecycle for a goal:
 * - LLM-driven candidate generation
 * - State transitions (candidate → active → completed/terminated/evaluating)
 * - Stall-driven pivots
 * - Phase 2: parallel multi-strategy execution (activateMultiple, terminateStrategy,
 *   createWaitStrategy, suspendStrategy, resumeStrategy, getAllActiveStrategies, updateAllocation)
 *
 * Persistence paths (relative to StateManager base):
 *   strategies/<goal_id>/portfolio.json
 *   strategies/<goal_id>/strategy-history.json
 *
 * In-memory index: strategyId → goalId for fast lookups without directory scanning.
 */
export class StrategyManager extends StrategyManagerBase {
  // ─── Phase 2 Portfolio Methods ───

  /**
   * Activate multiple candidate strategies simultaneously (Phase 2 parallel execution).
   * Allocates resources equally, respecting min=0.1 and max=0.7 per strategy.
   * Single strategy receives allocation=1.0.
   */
  async activateMultiple(goalId: string, strategyIds: string[]): Promise<Strategy[]> {
    if (strategyIds.length === 0) {
      throw new Error(`activateMultiple: strategyIds must not be empty`);
    }

    const portfolio = await this.loadOrCreatePortfolio(goalId);
    const now = new Date().toISOString();
    const count = strategyIds.length;

    // Compute equal-split allocation within [min, max] bounds
    const MIN = 0.1;
    const MAX = 0.7;
    let alloc: number;
    if (count === 1) {
      alloc = 1.0;
    } else {
      // Equal split, clamped to [MIN, MAX]
      const raw = 1.0 / count;
      alloc = Math.min(Math.max(raw, MIN), MAX);
    }

    // Validate all strategies before mutating to avoid partial state
    for (const id of strategyIds) {
      const s = portfolio.strategies.find((s) => s.id === id);
      if (!s) {
        throw new Error(
          `activateMultiple: strategy "${id}" not found in portfolio for goal "${goalId}"`
        );
      }
      if (s.state !== "candidate") {
        throw new Error(
          `activateMultiple: strategy "${s.id}" is not in candidate state (current: ${s.state})`
        );
      }
    }

    const activated: Strategy[] = [];

    const updatedStrategies = portfolio.strategies.map((s) => {
      if (!strategyIds.includes(s.id)) return s;

      const updated = StrategySchema.parse({
        ...s,
        state: "active",
        started_at: now,
        allocation: alloc,
        gap_snapshot_at_start: s.gap_snapshot_at_start,
      });
      activated.push(updated);
      return updated;
    });

    portfolio.strategies = updatedStrategies;

    await this.savePortfolio(goalId, portfolio);
    return activated;
  }

  /**
   * Terminate a strategy and redistribute its allocation to remaining active strategies
   * proportionally. If no remaining active strategies, allocation is not redistributed.
   */
  async terminateStrategy(goalId: string, strategyId: string, _reason: string): Promise<Strategy> {
    const portfolio = await this.loadOrCreatePortfolio(goalId);
    const strategy = portfolio.strategies.find((s) => s.id === strategyId);
    if (!strategy) {
      throw new Error(
        `terminateStrategy: strategy "${strategyId}" not found in portfolio for goal "${goalId}"`
      );
    }

    const now = new Date().toISOString();
    const freedAllocation = strategy.allocation;

    const terminated = StrategySchema.parse({
      ...strategy,
      state: "terminated",
      completed_at: now,
      allocation: 0,
    });

    // Redistribute freed allocation proportionally
    const withTerminated = portfolio.strategies.map((s) =>
      s.id === strategyId ? terminated : s
    );
    portfolio.strategies = redistributeAllocation(withTerminated, strategyId, freedAllocation);
    await this.savePortfolio(goalId, portfolio);
    await this.appendToHistory(goalId, terminated);

    return terminated;
  }

  /**
   * Create a WaitStrategy for a goal.
   * Sets state="candidate" initially; caller activates when ready.
   */
  async createWaitStrategy(
    goalId: string,
    params: {
      hypothesis: string;
      wait_reason: string;
      wait_until: string;
      measurement_plan: string;
      fallback_strategy_id: string | null;
      target_dimensions: string[];
      primary_dimension: string;
    }
  ): Promise<Strategy> {
    const now = new Date().toISOString();

    const waitStrategy = WaitStrategySchema.parse({
      id: randomUUID(),
      goal_id: goalId,
      target_dimensions: params.target_dimensions,
      primary_dimension: params.primary_dimension,
      hypothesis: params.hypothesis,
      expected_effect: [],
      resource_estimate: {
        sessions: 0,
        duration: { value: 0, unit: "hours" },
        llm_calls: null,
      },
      state: "candidate",
      allocation: 0,
      created_at: now,
      started_at: null,
      completed_at: null,
      gap_snapshot_at_start: null,
      tasks_generated: [],
      effectiveness_score: null,
      consecutive_stall_count: 0,
      wait_reason: params.wait_reason,
      wait_until: params.wait_until,
      measurement_plan: params.measurement_plan,
      fallback_strategy_id: params.fallback_strategy_id,
    });

    const portfolio = await this.loadOrCreatePortfolio(goalId);
    // WaitStrategy is a superset of Strategy; store as Strategy (base fields) in portfolio
    portfolio.strategies.push(StrategySchema.parse(waitStrategy));
    await this.savePortfolio(goalId, portfolio);

    this.strategyIndex.set(waitStrategy.id, goalId);
    return StrategySchema.parse(waitStrategy);
  }

  /**
   * Suspend an active strategy, redistributing its allocation to remaining active strategies.
   */
  async suspendStrategy(goalId: string, strategyId: string): Promise<Strategy> {
    const portfolio = await this.loadOrCreatePortfolio(goalId);
    const strategy = portfolio.strategies.find((s) => s.id === strategyId);
    if (!strategy) {
      throw new Error(
        `suspendStrategy: strategy "${strategyId}" not found in portfolio for goal "${goalId}"`
      );
    }

    if (strategy.state !== "active" && strategy.state !== "evaluating") {
      throw new Error(
        `suspendStrategy: strategy "${strategyId}" must be active or evaluating (current: ${strategy.state})`
      );
    }

    const freedAllocation = strategy.allocation;
    const suspended = StrategySchema.parse({
      ...strategy,
      state: "suspended",
      allocation: 0,
    });

    const withSuspended = portfolio.strategies.map((s) =>
      s.id === strategyId ? suspended : s
    );
    portfolio.strategies = redistributeAllocation(withSuspended, strategyId, freedAllocation);
    await this.savePortfolio(goalId, portfolio);

    return suspended;
  }

  /**
   * Resume a suspended strategy at the given allocation.
   * Adjusts other active strategies proportionally to maintain sum=1.0.
   */
  async resumeStrategy(goalId: string, strategyId: string, allocation: number): Promise<Strategy> {
    if (allocation < 0 || allocation > 1) {
      throw new Error(`resumeStrategy: allocation must be in [0, 1], got ${allocation}`);
    }

    const portfolio = await this.loadOrCreatePortfolio(goalId);
    const strategy = portfolio.strategies.find((s) => s.id === strategyId);
    if (!strategy) {
      throw new Error(
        `resumeStrategy: strategy "${strategyId}" not found in portfolio for goal "${goalId}"`
      );
    }

    if (strategy.state !== "suspended") {
      throw new Error(
        `resumeStrategy: strategy "${strategyId}" must be suspended (current: ${strategy.state})`
      );
    }

    const resumed = StrategySchema.parse({
      ...strategy,
      state: "active",
      allocation,
    });

    // Shrink other active strategies proportionally to make room
    const others = portfolio.strategies.filter(
      (s) => s.id !== strategyId && (s.state === "active" || s.state === "evaluating")
    );
    const totalOtherAlloc = others.reduce((sum, s) => sum + s.allocation, 0);
    const remaining = 1.0 - allocation;

    portfolio.strategies = portfolio.strategies.map((s) => {
      if (s.id === strategyId) return resumed;
      if (!others.some((o) => o.id === s.id)) return s;
      const newAlloc =
        totalOtherAlloc > 0
          ? (s.allocation / totalOtherAlloc) * remaining
          : remaining / others.length;
      return StrategySchema.parse({ ...s, allocation: newAlloc });
    });

    await this.savePortfolio(goalId, portfolio);
    return resumed;
  }

  /**
   * Return all strategies with state "active" or "evaluating" for a goal.
   * Unlike getActiveStrategy, returns all concurrent active strategies.
   */
  async getAllActiveStrategies(goalId: string): Promise<Strategy[]> {
    const portfolio = await this.loadOrCreatePortfolio(goalId);
    return portfolio.strategies.filter(
      (s) => s.state === "active" || s.state === "evaluating"
    );
  }

  /**
   * Update a single strategy's allocation directly.
   * Does NOT validate that the sum of all allocations equals 1.0;
   * the caller (e.g., PortfolioManager) is responsible for maintaining that invariant.
   */
  async updateAllocation(goalId: string, strategyId: string, newAllocation: number): Promise<void> {
    if (newAllocation < 0 || newAllocation > 1) {
      throw new Error(
        `updateAllocation: allocation must be in [0, 1], got ${newAllocation}`
      );
    }

    const portfolio = await this.loadOrCreatePortfolio(goalId);
    const strategy = portfolio.strategies.find((s) => s.id === strategyId);
    if (!strategy) {
      throw new Error(
        `updateAllocation: strategy "${strategyId}" not found in portfolio for goal "${goalId}"`
      );
    }

    portfolio.strategies = portfolio.strategies.map((s) =>
      s.id === strategyId ? StrategySchema.parse({ ...s, allocation: newAllocation }) : s
    );
    await this.savePortfolio(goalId, portfolio);
  }
}
