import { randomUUID } from "node:crypto";
import { StateManager } from "../state-manager.js";
import { StrategySchema, PortfolioSchema } from "../types/strategy.js";
import type { Strategy, Portfolio } from "../types/strategy.js";
import type { StrategyState } from "../types/core.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { KnowledgeGapSignal } from "../types/knowledge.js";
import {
  VALID_TRANSITIONS,
  StrategyArraySchema,
  buildGenerationPrompt,
  detectStrategyGap,
} from "./strategy-helpers.js";

/**
 * Base class for StrategyManager.
 * Contains constructor, core lifecycle methods, and private persistence helpers.
 * Phase 2 portfolio methods live in the StrategyManager subclass.
 */
export class StrategyManagerBase {
  protected readonly stateManager: StateManager;
  protected readonly llmClient: ILLMClient;

  /** In-memory index: strategyId → goalId */
  protected readonly strategyIndex: Map<string, string> = new Map();

  constructor(stateManager: StateManager, llmClient: ILLMClient) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
  }

  // ─── Core Lifecycle Methods ───

  /**
   * Generate 1–2 strategy candidates via LLM.
   * Validates each with StrategySchema, sets state="candidate", stores in portfolio.
   */
  async generateCandidates(
    goalId: string,
    primaryDimension: string,
    targetDimensions: string[],
    context: {
      currentGap: number;
      pastStrategies: Strategy[];
    }
  ): Promise<Strategy[]> {
    const prompt = buildGenerationPrompt(
      goalId,
      primaryDimension,
      targetDimensions,
      context
    );

    const response = await this.llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      {
        system:
          "You are a strategic planning assistant. Generate concrete, actionable strategies to close the goal gap. Respond with a JSON array of 1–2 strategies.",
        max_tokens: 2048,
      }
    );

    // Parse and validate the LLM response
    const strategiesRaw = this.llmClient.parseJSON(
      response.content,
      StrategyArraySchema
    );

    const now = new Date().toISOString();
    const candidates: Strategy[] = strategiesRaw.map((raw) =>
      StrategySchema.parse({
        ...raw,
        id: raw.id ?? randomUUID(),
        goal_id: goalId,
        primary_dimension: primaryDimension,
        target_dimensions: targetDimensions,
        state: "candidate",
        created_at: now,
        started_at: null,
        completed_at: null,
        gap_snapshot_at_start: null,
        tasks_generated: [],
        effectiveness_score: null,
        consecutive_stall_count: 0,
      })
    );

    // Store candidates in portfolio
    const portfolio = await this.loadOrCreatePortfolio(goalId);
    portfolio.strategies.push(...candidates);
    await this.savePortfolio(goalId, portfolio);

    // Update in-memory index
    for (const c of candidates) {
      this.strategyIndex.set(c.id, goalId);
    }

    return candidates;
  }

  /**
   * Activate the first candidate strategy for a goal.
   * Sets state="active" and started_at=now.
   */
  async activateBestCandidate(goalId: string): Promise<Strategy> {
    const portfolio = await this.loadOrCreatePortfolio(goalId);
    const candidates = portfolio.strategies.filter(
      (s) => s.state === "candidate"
    );

    if (candidates.length === 0) {
      throw new Error(
        `activateBestCandidate: no candidates found for goal "${goalId}"`
      );
    }

    // Select first candidate (top of list)
    const best = candidates[0];
    const now = new Date().toISOString();

    const activated = StrategySchema.parse({
      ...best,
      state: "active",
      started_at: now,
    });

    // Update in portfolio
    portfolio.strategies = portfolio.strategies.map((s) =>
      s.id === activated.id ? activated : s
    );
    await this.savePortfolio(goalId, portfolio);

    // Ensure index entry
    this.strategyIndex.set(activated.id, goalId);

    return activated;
  }

  /**
   * Transition a strategy to a new state.
   * Throws if the transition is not valid or strategy is not found.
   */
  async updateState(
    strategyId: string,
    newState: StrategyState,
    metadata?: { effectiveness_score?: number }
  ): Promise<void> {
    const goalId = await this.resolveGoalId(strategyId);
    if (!goalId) {
      throw new Error(
        `updateState: strategy "${strategyId}" not found in any portfolio`
      );
    }

    const portfolio = await this.loadOrCreatePortfolio(goalId);
    const strategy = portfolio.strategies.find((s) => s.id === strategyId);
    if (!strategy) {
      throw new Error(`updateState: strategy "${strategyId}" not found in portfolio for goal "${goalId}"`);
    }

    const allowed = VALID_TRANSITIONS[strategy.state] ?? [];
    if (!allowed.includes(newState)) {
      throw new Error(
        `updateState: invalid transition "${strategy.state}" → "${newState}" for strategy "${strategyId}"`
      );
    }

    const now = new Date().toISOString();
    const updated = StrategySchema.parse({
      ...strategy,
      state: newState,
      completed_at:
        newState === "completed" || newState === "terminated"
          ? now
          : strategy.completed_at,
      effectiveness_score:
        metadata?.effectiveness_score !== undefined
          ? metadata.effectiveness_score
          : strategy.effectiveness_score,
    });

    portfolio.strategies = portfolio.strategies.map((s) =>
      s.id === strategyId ? updated : s
    );
    await this.savePortfolio(goalId, portfolio);

    // Archive terminated/completed strategies to history
    if (newState === "terminated" || newState === "completed") {
      await this.appendToHistory(goalId, updated);
    }
  }

  /**
   * React to a stall detection event.
   * - stallCount === 1: return null (no strategy change; notify only)
   * - stallCount >= 2: terminate current strategy, generate new candidates, activate best
   * - If no candidates can be generated: return null
   */
  async onStallDetected(
    goalId: string,
    stallCount: number
  ): Promise<Strategy | null> {
    if (stallCount < 2) {
      return null;
    }

    // Capture active strategy details before terminating
    const active = await this.getActiveStrategy(goalId);
    if (active) {
      // Increment consecutive_stall_count before terminating
      const portfolio = await this.loadOrCreatePortfolio(goalId);
      const updated = StrategySchema.parse({
        ...active,
        consecutive_stall_count: active.consecutive_stall_count + 1,
      });
      portfolio.strategies = portfolio.strategies.map((s) =>
        s.id === active.id ? updated : s
      );
      await this.savePortfolio(goalId, portfolio);

      await this.updateState(active.id, "terminated");
    }

    // Gather past strategies for context
    const pastStrategies = await this.getStrategyHistory(goalId);
    const primaryDimension =
      active?.primary_dimension ?? pastStrategies[0]?.primary_dimension ?? "";
    const targetDimensions =
      active?.target_dimensions ?? pastStrategies[0]?.target_dimensions ?? [];

    let candidates: Strategy[];
    try {
      candidates = await this.generateCandidates(
        goalId,
        primaryDimension,
        targetDimensions,
        {
          currentGap: active?.gap_snapshot_at_start ?? 1.0,
          pastStrategies,
        }
      );
    } catch {
      return null;
    }

    if (candidates.length === 0) {
      return null;
    }

    try {
      return await this.activateBestCandidate(goalId);
    } catch {
      return null;
    }
  }

  /**
   * Returns the currently active strategy for a goal, or null.
   */
  async getActiveStrategy(goalId: string): Promise<Strategy | null> {
    const portfolio = await this.loadOrCreatePortfolio(goalId);
    return portfolio.strategies.find((s) => s.state === "active") ?? null;
  }

  /**
   * Returns the full portfolio for a goal, or null if none has been persisted.
   */
  async getPortfolio(goalId: string): Promise<Portfolio | null> {
    const raw = await this.stateManager.readRaw(
      `strategies/${goalId}/portfolio.json`
    );
    if (raw === null) return null;
    const portfolio = PortfolioSchema.parse(raw);
    // Rebuild index from loaded portfolio
    for (const s of portfolio.strategies) {
      this.strategyIndex.set(s.id, goalId);
    }
    return portfolio;
  }

  /**
   * Returns all strategies in history (terminated/completed) for a goal.
   */
  async getStrategyHistory(goalId: string): Promise<Strategy[]> {
    const raw = await this.stateManager.readRaw(
      `strategies/${goalId}/strategy-history.json`
    );
    if (raw === null) return [];
    const parsed = raw as unknown[];
    return parsed.map((s) => StrategySchema.parse(s));
  }

  // ─── Knowledge Gap Detection ───

  /** Delegates to the pure helper in strategy-helpers.ts. */
  detectStrategyGap(candidates: Strategy[]): KnowledgeGapSignal | null {
    return detectStrategyGap(candidates);
  }

  // ─── Protected Helpers ───

  protected async loadOrCreatePortfolio(goalId: string): Promise<Portfolio> {
    const existing = await this.getPortfolio(goalId);
    if (existing) return existing;

    const now = new Date().toISOString();
    return PortfolioSchema.parse({
      goal_id: goalId,
      strategies: [],
      rebalance_interval: { value: 7, unit: "days" },
      last_rebalanced_at: now,
    });
  }

  protected async savePortfolio(goalId: string, portfolio: Portfolio): Promise<void> {
    const parsed = PortfolioSchema.parse(portfolio);
    await this.stateManager.writeRaw(
      `strategies/${goalId}/portfolio.json`,
      parsed
    );
    // Rebuild index for all strategies in the portfolio
    for (const s of parsed.strategies) {
      this.strategyIndex.set(s.id, goalId);
    }
  }

  protected async appendToHistory(goalId: string, strategy: Strategy): Promise<void> {
    const history = await this.getStrategyHistory(goalId);
    const idx = history.findIndex((s) => s.id === strategy.id);
    if (idx >= 0) {
      history[idx] = strategy;
    } else {
      history.push(strategy);
    }
    await this.stateManager.writeRaw(
      `strategies/${goalId}/strategy-history.json`,
      history
    );
  }

  /**
   * Resolve a goalId from a strategyId using the in-memory index.
   * Falls back to scanning goal directories if not in index.
   */
  protected async resolveGoalId(strategyId: string): Promise<string | null> {
    // Check in-memory index first
    const cached = this.strategyIndex.get(strategyId);
    if (cached) return cached;

    // Fall back to scanning known goal directories
    const goalIds = await this.stateManager.listGoalIds();
    for (const goalId of goalIds) {
      const portfolio = await this.getPortfolio(goalId);
      if (portfolio?.strategies.some((s) => s.id === strategyId)) {
        return goalId;
      }
    }

    return null;
  }
}
