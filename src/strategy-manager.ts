import { randomUUID } from "node:crypto";
import { z } from "zod";
import { StateManager } from "./state-manager.js";
import { StrategySchema, PortfolioSchema } from "./types/strategy.js";
import type { Strategy, Portfolio } from "./types/strategy.js";
import type { StrategyState } from "./types/core.js";
import type { ILLMClient } from "./llm-client.js";
import { KnowledgeGapSignalSchema } from "./types/knowledge.js";
import type { KnowledgeGapSignal } from "./types/knowledge.js";

// ─── Valid state transitions ───

const VALID_TRANSITIONS: Record<StrategyState, StrategyState[]> = {
  candidate: ["active"],
  active: ["completed", "terminated", "evaluating"],
  evaluating: ["active", "terminated"],
  suspended: ["active", "terminated"],
  completed: [],
  terminated: [],
};

// ─── Internal schema for parsing LLM array response ───

const StrategyArraySchema = z.array(
  z.object({
    id: z.string().optional(),
    hypothesis: z.string(),
    expected_effect: z.array(
      z.object({
        dimension: z.string(),
        direction: z.enum(["increase", "decrease"]),
        magnitude: z.enum(["small", "medium", "large"]),
      })
    ),
    resource_estimate: z.object({
      sessions: z.number(),
      duration: z.object({
        value: z.number(),
        unit: z.enum(["minutes", "hours", "days", "weeks"]),
      }),
      llm_calls: z.number().nullable().default(null),
    }),
    allocation: z.number().min(0).max(1).default(0),
  })
);

/**
 * StrategyManager manages strategy lifecycle for a goal:
 * - LLM-driven candidate generation
 * - State transitions (candidate → active → completed/terminated/evaluating)
 * - Stall-driven pivots
 *
 * Persistence paths (relative to StateManager base):
 *   strategies/<goal_id>/portfolio.json
 *   strategies/<goal_id>/strategy-history.json
 *
 * In-memory index: strategyId → goalId for fast lookups without directory scanning.
 */
export class StrategyManager {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;

  /** In-memory index: strategyId → goalId */
  private readonly strategyIndex: Map<string, string> = new Map();

  constructor(stateManager: StateManager, llmClient: ILLMClient) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
  }

  // ─── Public Methods ───

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
    const prompt = this.buildGenerationPrompt(
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
    const portfolio = this.loadOrCreatePortfolio(goalId);
    portfolio.strategies.push(...candidates);
    this.savePortfolio(goalId, portfolio);

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
    const portfolio = this.loadOrCreatePortfolio(goalId);
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
    this.savePortfolio(goalId, portfolio);

    // Ensure index entry
    this.strategyIndex.set(activated.id, goalId);

    return activated;
  }

  /**
   * Transition a strategy to a new state.
   * Throws if the transition is not valid or strategy is not found.
   */
  updateState(
    strategyId: string,
    newState: StrategyState,
    metadata?: { effectiveness_score?: number }
  ): void {
    const goalId = this.resolveGoalId(strategyId);
    if (!goalId) {
      throw new Error(
        `updateState: strategy "${strategyId}" not found in any portfolio`
      );
    }

    const portfolio = this.loadOrCreatePortfolio(goalId);
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
    this.savePortfolio(goalId, portfolio);

    // Archive terminated/completed strategies to history
    if (newState === "terminated" || newState === "completed") {
      this.appendToHistory(goalId, updated);
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
    const active = this.getActiveStrategy(goalId);
    if (active) {
      // Increment consecutive_stall_count before terminating
      const portfolio = this.loadOrCreatePortfolio(goalId);
      const updated = StrategySchema.parse({
        ...active,
        consecutive_stall_count: active.consecutive_stall_count + 1,
      });
      portfolio.strategies = portfolio.strategies.map((s) =>
        s.id === active.id ? updated : s
      );
      this.savePortfolio(goalId, portfolio);

      this.updateState(active.id, "terminated");
    }

    // Gather past strategies for context
    const pastStrategies = this.getStrategyHistory(goalId);
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
  getActiveStrategy(goalId: string): Strategy | null {
    const portfolio = this.loadOrCreatePortfolio(goalId);
    return portfolio.strategies.find((s) => s.state === "active") ?? null;
  }

  /**
   * Returns the full portfolio for a goal, or null if none has been persisted.
   */
  getPortfolio(goalId: string): Portfolio | null {
    const raw = this.stateManager.readRaw(
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
  getStrategyHistory(goalId: string): Strategy[] {
    const raw = this.stateManager.readRaw(
      `strategies/${goalId}/strategy-history.json`
    );
    if (raw === null) return [];
    const parsed = raw as unknown[];
    return parsed.map((s) => StrategySchema.parse(s));
  }

  // ─── Knowledge Gap Detection ───

  /**
   * Detect whether a set of strategy candidates indicates a knowledge gap.
   *
   * Rules:
   *   - Zero candidates → `strategy_deadlock` (no hypotheses can be formed)
   *   - All candidates have effectiveness_score < 0.3 AND not null →
   *     `strategy_deadlock` (all known approaches exhausted)
   *
   * Returns null when candidates look viable.
   */
  detectStrategyGap(candidates: Strategy[]): KnowledgeGapSignal | null {
    if (candidates.length === 0) {
      return KnowledgeGapSignalSchema.parse({
        signal_type: "strategy_deadlock",
        missing_knowledge:
          "No strategies available — domain knowledge needed to generate hypotheses",
        source_step: "strategy_selection",
        related_dimension: null,
      });
    }

    const scoredCandidates = candidates.filter(
      (c) => c.effectiveness_score !== null
    );
    if (
      scoredCandidates.length > 0 &&
      scoredCandidates.every((c) => (c.effectiveness_score ?? 1) < 0.3)
    ) {
      return KnowledgeGapSignalSchema.parse({
        signal_type: "strategy_deadlock",
        missing_knowledge:
          "All known strategies have low effectiveness — domain knowledge needed to form new hypotheses",
        source_step: "strategy_selection",
        related_dimension: null,
      });
    }

    return null;
  }

  // ─── Private Helpers ───

  private loadOrCreatePortfolio(goalId: string): Portfolio {
    const existing = this.getPortfolio(goalId);
    if (existing) return existing;

    const now = new Date().toISOString();
    return PortfolioSchema.parse({
      goal_id: goalId,
      strategies: [],
      rebalance_interval: { value: 7, unit: "days" },
      last_rebalanced_at: now,
    });
  }

  private savePortfolio(goalId: string, portfolio: Portfolio): void {
    const parsed = PortfolioSchema.parse(portfolio);
    this.stateManager.writeRaw(
      `strategies/${goalId}/portfolio.json`,
      parsed
    );
    // Rebuild index for all strategies in the portfolio
    for (const s of parsed.strategies) {
      this.strategyIndex.set(s.id, goalId);
    }
  }

  private appendToHistory(goalId: string, strategy: Strategy): void {
    const history = this.getStrategyHistory(goalId);
    const idx = history.findIndex((s) => s.id === strategy.id);
    if (idx >= 0) {
      history[idx] = strategy;
    } else {
      history.push(strategy);
    }
    this.stateManager.writeRaw(
      `strategies/${goalId}/strategy-history.json`,
      history
    );
  }

  /**
   * Resolve a goalId from a strategyId using the in-memory index.
   * Falls back to scanning goal directories if not in index.
   */
  private resolveGoalId(strategyId: string): string | null {
    // Check in-memory index first
    const cached = this.strategyIndex.get(strategyId);
    if (cached) return cached;

    // Fall back to scanning known goal directories
    const goalIds = this.stateManager.listGoalIds();
    for (const goalId of goalIds) {
      const portfolio = this.getPortfolio(goalId);
      if (portfolio?.strategies.some((s) => s.id === strategyId)) {
        return goalId;
      }
    }

    return null;
  }

  private buildGenerationPrompt(
    goalId: string,
    primaryDimension: string,
    targetDimensions: string[],
    context: { currentGap: number; pastStrategies: Strategy[] }
  ): string {
    const pastSummary =
      context.pastStrategies.length > 0
        ? context.pastStrategies
            .map(
              (s) =>
                `- "${s.hypothesis}" (state: ${s.state}, effectiveness: ${s.effectiveness_score ?? "unknown"})`
            )
            .join("\n")
        : "None";

    return `Generate 1-2 strategic approaches to close the gap for goal "${goalId}".

Primary dimension to improve: ${primaryDimension}
All target dimensions: ${targetDimensions.join(", ")}
Current gap score: ${context.currentGap} (0=closed, 1=fully open)

Past strategies tried:
${pastSummary}

Return a JSON array of strategies. Each strategy must follow this schema:
{
  "hypothesis": "string - the core bet/approach",
  "expected_effect": [
    { "dimension": "string", "direction": "increase"|"decrease", "magnitude": "small"|"medium"|"large" }
  ],
  "resource_estimate": {
    "sessions": number,
    "duration": { "value": number, "unit": "hours"|"days"|"weeks"|"minutes" },
    "llm_calls": number|null
  },
  "allocation": number (0-1)
}

Do not repeat strategies that have already been tried. Respond with only the JSON array inside a markdown code block.`;
  }
}
