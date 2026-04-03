import { randomUUID } from "node:crypto";
import { z } from "zod";
import { StateManager } from "../state/state-manager.js";
import { StrategySchema, PortfolioSchema } from "../types/strategy.js";
import type { Strategy, Portfolio } from "../types/strategy.js";
import type { StrategyState } from "../types/core.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { IPromptGateway } from "../prompt/gateway.js";
import type { KnowledgeGapSignal } from "../types/knowledge.js";
import type { KnowledgeManager } from "../knowledge/knowledge-manager.js";
import type { StrategyTemplateRegistry } from "./strategy-template-registry.js";
import type { Logger } from "../runtime/logger.js";
import {
  VALID_TRANSITIONS,
  StrategyArraySchema,
  buildGenerationPrompt,
  detectStrategyGap,
  unwrapStrategyResponse,
} from "./strategy-helpers.js";

/**
 * Base class for StrategyManager.
 * Contains constructor, core lifecycle methods, and private persistence helpers.
 * Phase 2 portfolio methods live in the StrategyManager subclass.
 */
export class StrategyManagerBase {
  protected readonly stateManager: StateManager;
  protected readonly llmClient: ILLMClient;
  /** Optional KnowledgeManager for decision-history-aware strategy selection (M14-S3). */
  protected knowledgeManager?: KnowledgeManager;
  /** Optional PromptGateway for memory-enriched LLM calls. */
  protected promptGateway?: IPromptGateway;
  /** Optional StrategyTemplateRegistry for auto-templating successful strategies. */
  private strategyTemplateRegistry?: StrategyTemplateRegistry;
  /** Optional Logger for diagnostic output. */
  protected logger?: Logger;

  /** In-memory index: strategyId → goalId */
  protected readonly strategyIndex: Map<string, string> = new Map();

  constructor(stateManager: StateManager, llmClient: ILLMClient, knowledgeManager?: KnowledgeManager, promptGateway?: IPromptGateway, logger?: Logger) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
    this.knowledgeManager = knowledgeManager;
    this.promptGateway = promptGateway;
    this.logger = logger;
  }

  /** Inject or update KnowledgeManager after construction (e.g., when KM is instantiated after SM). */
  setKnowledgeManager(km: KnowledgeManager): void {
    this.knowledgeManager = km;
  }

  /** Inject StrategyTemplateRegistry for auto-templating successful strategies. */
  setStrategyTemplateRegistry(registry: StrategyTemplateRegistry): void {
    this.strategyTemplateRegistry = registry;
  }

  // ─── Core Lifecycle Methods ───

  /**
   * Generate 1–2 strategy candidates via LLM.
   * Validates each with StrategySchema, sets state="candidate", stores in portfolio.
   *
   * Optional `enrichment` injects strategy templates and lessons into the prompt.
   */
  async generateCandidates(
    goalId: string,
    primaryDimension: string,
    targetDimensions: string[],
    context: {
      currentGap: number;
      pastStrategies: Strategy[];
    },
    enrichment?: { templatesBlock?: string; lessonsBlock?: string }
  ): Promise<Strategy[]> {
    const prompt = buildGenerationPrompt(
      goalId,
      primaryDimension,
      targetDimensions,
      context,
      enrichment
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let strategiesRaw: any[];
    if (this.promptGateway) {
      // Wrap the schema to unwrap any LLM wrapper object before array validation.
      const unwrappingSchema = z.unknown().transform(unwrapStrategyResponse).pipe(StrategyArraySchema);
      strategiesRaw = await this.promptGateway.execute({
        purpose: "strategy_generation",
        goalId,
        responseSchema: unwrappingSchema,
        additionalContext: {
          prompt,
          primaryDimension,
          targetDimensions: targetDimensions.join(","),
          currentGap: String(context.currentGap),
        },
        maxTokens: 2048,
      });
    } else {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        {
          system:
            "You are a strategic planning assistant. Generate concrete, actionable strategies to close the goal gap. Respond with a JSON array of 1–2 strategies.",
          max_tokens: 2048,
          model_tier: 'main',
        }
      );
      // Parse and validate the LLM response.
      // Unwrap { candidates: [...] } shape in case the LLM returns a wrapped object.
      const parsed = this.llmClient.parseJSON(response.content, z.unknown());
      strategiesRaw = StrategyArraySchema.parse(unwrapStrategyResponse(parsed));
    }

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

      // Update the corresponding DecisionRecord outcome (non-fatal)
      if (this.knowledgeManager) {
        try {
          const outcome = newState === "completed" ? "success" : "failure";
          await this.knowledgeManager.updateDecisionOutcome(strategyId, outcome);
        } catch (e) {
          this.logger?.warn(`[StrategyManager] updateDecisionOutcome failed for ${strategyId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Auto-template successful strategies (fire-and-forget — do not block state transition)
      if (newState === "completed" && this.strategyTemplateRegistry) {
        if ((updated.effectiveness_score ?? 0) >= 0.5) {
          void this.strategyTemplateRegistry.registerTemplate(updated, goalId)
            .then(() => {
              this.logger?.info(`Auto-templated strategy ${strategyId} (effectiveness: ${updated.effectiveness_score})`);
            })
            .catch((err: unknown) => {
              // Non-fatal — log and continue
              this.logger?.warn(`Failed to auto-template strategy ${strategyId}: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
      }
    }
  }

  /**
   * React to a stall detection event.
   * - stallCount === 1: return null (no strategy change; notify only)
   * - stallCount >= 2: terminate current strategy, generate new candidates, activate best
   * - If no candidates can be generated: return null
   *
   * When knowledgeManager is available and goalType is given, past decision history
   * is used to deprioritize previously-pivoted strategies (M14-S3).
   */
  async onStallDetected(
    goalId: string,
    stallCount: number,
    goalType?: string
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
    } catch (err) {
      this.logger?.warn(
        `[StrategyManager] generateCandidates failed during stall recovery for goal "${goalId}": ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }

    if (candidates.length === 0) {
      return null;
    }

    // M14-S3: Apply decision history to reorder candidates when enough data available
    if (this.knowledgeManager && goalType) {
      try {
        const reordered = await this._rankCandidatesByDecisionHistory(
          candidates,
          goalType
        );
        if (reordered.length > 0) {
          // Persist reordered candidates into portfolio
          const portfolio = await this.loadOrCreatePortfolio(goalId);
          portfolio.strategies = portfolio.strategies.map((s) => {
            const idx = reordered.findIndex((r) => r.id === s.id);
            return idx >= 0 ? (reordered[idx] as Strategy) : s;
          });
          await this.savePortfolio(goalId, portfolio);
        }
      } catch (err) {
        this.logger?.warn(`[StrategyManager] reorderByDecisionHistory failed: ${String(err)}`);
        // non-fatal: fall through to default selection
      }
    }

    try {
      return await this.activateBestCandidate(goalId);
    } catch (err) {
      this.logger?.warn(`[StrategyManager] activateBestCandidate failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * M14-S3: Rank candidates using past decision history.
   * Strategies that were previously PIVOTed are deprioritized (moved to end).
   * Strategies that succeeded are prioritized (moved to front).
   * Falls back to original order when < 3 records exist.
   */
  protected async _rankCandidatesByDecisionHistory(
    candidates: Strategy[],
    goalType: string
  ): Promise<Strategy[]> {
    if (!this.knowledgeManager) return candidates;

    const records = await this.knowledgeManager.queryDecisions(goalType, 50);

    // Fallback: < 3 records → use existing logic
    if (records.length < 3) {
      return candidates;
    }

    // Build score map: hypothesis text → adjustment
    // Pivot → -1, Success → +1, Others → 0
    const scoreMap = new Map<string, number>();
    for (const record of records) {
      const key = record.hypothesis;
      if (!key) continue;
      const existing = scoreMap.get(key) ?? 0;
      if (record.decision === "pivot" && record.outcome !== "success") {
        scoreMap.set(key, existing - 1);
      } else if (record.outcome === "success") {
        scoreMap.set(key, existing + 1);
      }
    }

    const scored = candidates.map((c) => ({
      candidate: c,
      score: scoreMap.get(c.hypothesis) ?? 0,
    }));

    // Stable sort: higher score first (ties keep original order)
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.candidate);
  }

  /**
   * Increment the pivot_count on a strategy and persist the portfolio.
   * No-op if the strategy is not found.
   */
  async incrementPivotCount(goalId: string, strategyId: string): Promise<void> {
    const portfolio = await this.loadOrCreatePortfolio(goalId);
    const strategy = portfolio.strategies.find((s) => s.id === strategyId);
    if (strategy) {
      strategy.pivot_count = (strategy.pivot_count ?? 0) + 1;
      await this.savePortfolio(goalId, portfolio);
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

  async savePortfolio(goalId: string, portfolio: Portfolio): Promise<void> {
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
