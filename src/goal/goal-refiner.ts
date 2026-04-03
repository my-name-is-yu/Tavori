/**
 * goal-refiner.ts — GoalRefiner class.
 *
 * Unified entry point that composes GoalNegotiator (feasibility) and
 * GoalTreeManager (decomposition) without replacing them.
 *
 * See docs/design/goal-refinement-pipeline.md §3 for the full algorithm.
 */

import type { StateManager } from "../state/state-manager.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { ObservationEngine } from "../observation/observation-engine.js";
import type { GoalNegotiator } from "./goal-negotiator.js";
import type { GoalTreeManager } from "./goal-tree-manager.js";
import type { EthicsGate } from "../traits/ethics-gate.js";
import { GoalSchema } from "../types/goal.js";
import type { Goal, Dimension } from "../types/goal.js";
import type { FeasibilityResult } from "../types/negotiation.js";
import {
  RefineConfigSchema,
  LeafTestResultSchema,
} from "../types/goal-refiner.js";
import type {
  RefineConfig,
  LeafTestResult,
  LeafDimension,
  RefineResult,
} from "../types/goal-refiner.js";
import { buildLeafTestPrompt } from "./refiner-prompts.js";
import { evaluateQualitatively, DEFAULT_TIME_HORIZON_DAYS } from "./negotiator-steps.js";

// ─── Conversion helpers ───

/**
 * Convert a LeafDimension (from leaf test) to a Goal Dimension.
 * Maps data_source → observation_method.type and observation_command → endpoint.
 */
function leafDimensionToGoalDimension(
  leaf: LeafDimension,
  now: string
): Dimension {
  const obsType = ((): "mechanical" | "llm_review" | "api_query" | "file_check" | "manual" => {
    switch (leaf.data_source) {
      case "shell": return "mechanical";
      case "file_existence": return "file_check";
      case "api": return "api_query";
      default:
        console.warn(`[GoalRefiner] Unknown data_source "${leaf.data_source}" for dimension "${leaf.name}"; defaulting to "mechanical"`);
        return "mechanical";
    }
  })();

  return {
    name: leaf.name,
    label: leaf.label,
    current_value: null,
    threshold: buildThreshold(leaf),
    confidence: 0.5,
    observation_method: {
      type: obsType,
      source: leaf.data_source,
      schedule: null,
      endpoint: leaf.observation_command,
      confidence_tier: obsType === "mechanical" || obsType === "file_check" ? "mechanical" : "self_report",
    },
    last_updated: now,
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok",
    dimension_mapping: null,
  };
}

function buildThreshold(leaf: LeafDimension): Goal["dimensions"][number]["threshold"] {
  switch (leaf.threshold_type) {
    case "min":
      return { type: "min", value: Number(leaf.threshold_value ?? 0) };
    case "max":
      return { type: "max", value: Number(leaf.threshold_value ?? 0) };
    case "range": {
      // threshold_value may be "[low, high]" or a number
      const v = leaf.threshold_value;
      if (Array.isArray(v) && v.length === 2) {
        return { type: "range", low: Number(v[0]), high: Number(v[1]) };
      }
      return { type: "range", low: 0, high: Number(v ?? 100) };
    }
    case "present":
      return { type: "present" };
    case "match":
      return {
        type: "match",
        value: (leaf.threshold_value as string | number | boolean) ?? "",
      };
    default:
      return { type: "min", value: 0 };
  }
}

// ─── Standalone predicates (also used by TreeLoopOrchestrator) ───

/**
 * Returns true when the goal already has validated dimensions and does not
 * need further refinement.
 * Covers: user_override, manual origin, or dimensions with a non-self_report
 * mechanical observation method.
 */
export function hasValidatedDimensions(goal: Goal): boolean {
  if (goal.user_override) return true;
  if (goal.origin === "manual") return true;
  return goal.dimensions.some(
    (d) => d.observation_method.type !== "manual" && d.observation_method.confidence_tier !== "self_report"
  );
}

// ─── Tree traversal helpers ───

/**
 * Collect all leaf goal IDs from a RefineResult tree.
 * A node is a leaf if result.leaf is true; otherwise recurse into children.
 */
export function collectLeafGoalIds(result: RefineResult): string[] {
  if (result.leaf) return [result.goal.id];
  if (!result.children) return [result.goal.id];
  return result.children.flatMap(collectLeafGoalIds);
}

// ─── GoalRefiner ───

export class GoalRefiner {
  constructor(
    private readonly stateManager: StateManager,
    private readonly llmClient: ILLMClient,
    private readonly observationEngine: ObservationEngine,
    private readonly negotiator: GoalNegotiator,
    private readonly treeManager: GoalTreeManager,
    private readonly ethicsGate: EthicsGate,
  ) {}

  // ─── Public: refine() ───

  async refine(
    goalId: string,
    config?: Partial<RefineConfig>,
    failureContext?: string
  ): Promise<RefineResult> {
    const fullConfig = RefineConfigSchema.parse(config ?? {});
    return this._refineInternal(goalId, fullConfig, 0, 0, failureContext);
  }

  // ─── Public: reRefineLeaf() ───

  async reRefineLeaf(goalId: string, failureContext: string): Promise<RefineResult> {
    const goal = await this.stateManager.loadGoal(goalId);
    if (!goal) throw new Error(`reRefineLeaf: goal "${goalId}" not found`);

    // Pass failureContext through to refine() — no state mutation needed
    return this.refine(goalId, undefined, failureContext);
  }

  // ─── Private: recursive core ───

  private async _refineInternal(
    goalId: string,
    config: RefineConfig,
    depth: number,
    tokensUsed: number,
    failureContext?: string
  ): Promise<RefineResult> {
    const now = new Date().toISOString();

    const goal = await this.stateManager.loadGoal(goalId);
    if (!goal) throw new Error(`GoalRefiner._refineInternal: goal "${goalId}" not found`);

    // ── Stopping condition a: depth limit ──
    if (depth >= config.maxDepth) {
      const forcedLeaf = await this._forceLeaf(goal, now);
      return {
        goal: forcedLeaf,
        leaf: true,
        children: null,
        feasibility: null,
        tokensUsed,
        reason: `max depth ${config.maxDepth} reached`,
      };
    }

    // ── Stopping condition b: token budget ──
    if (tokensUsed >= config.tokenBudget) {
      const forcedLeaf = await this._forceLeaf(goal, now);
      return {
        goal: forcedLeaf,
        leaf: true,
        children: null,
        feasibility: null,
        tokensUsed,
        reason: "token budget exhausted",
      };
    }

    // ── Stopping condition c: already has validated dimensions ──
    if (!config.force && hasValidatedDimensions(goal)) {
      return {
        goal,
        leaf: true,
        children: null,
        feasibility: null,
        tokensUsed,
        reason: "already has validated dimensions",
      };
    }

    // ── Leaf test ──
    const dataSources = this.observationEngine
      .getDataSources()
      .map((ds) => ds.config?.name ?? ds.sourceId ?? "unknown");

    // When failureContext is provided (from reRefineLeaf), augment the description
    // locally without persisting to state — eliminates the crash-unsafe mutate-restore window
    const goalForPrompt: Goal = failureContext
      ? { ...goal, description: `${goal.description}\n\n[Failure context: ${failureContext}]` }
      : goal;

    const prompt = buildLeafTestPrompt(goalForPrompt, dataSources);

    let leafTestResult: LeafTestResult;
    try {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { temperature: 0 }
      );
      tokensUsed += (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 1000);

      try {
        leafTestResult = this.llmClient.parseJSON(response.content, LeafTestResultSchema);
      } catch (parseErr) {
        console.error("[GoalRefiner] LeafTestResult parse error:", parseErr instanceof Error ? parseErr.message : String(parseErr));
        // Treat parse failure as non-measurable: decompose
        leafTestResult = { is_measurable: false, dimensions: null, reason: "LLM parse failure" };
      }
    } catch (err) {
      console.error("[GoalRefiner] Leaf test LLM call failed:", err);
      leafTestResult = { is_measurable: false, dimensions: null, reason: "LLM call failed" };
    }

    // ── Branch: measurable ──
    if (leafTestResult.is_measurable && leafTestResult.dimensions && leafTestResult.dimensions.length > 0) {
      const goalDimensions = leafTestResult.dimensions.map((ld) =>
        leafDimensionToGoalDimension(ld, now)
      );

      let feasibilityResults: FeasibilityResult[] | null = null;
      if (config.feasibilityCheck) {
        const { results, tokenCost } = await this._runFeasibilityCheck(
          goal.description,
          leafTestResult.dimensions
        );
        feasibilityResults = results;
        tokensUsed += tokenCost;
      }

      const leafGoal = GoalSchema.parse({
        ...goal,
        node_type: "leaf",
        dimensions: goalDimensions,
        updated_at: now,
      });
      await this.stateManager.saveGoal(leafGoal);

      return {
        goal: leafGoal,
        leaf: true,
        children: null,
        feasibility: feasibilityResults,
        tokensUsed,
        reason: leafTestResult.reason,
      };
    }

    // ── Branch: not measurable → decompose ──
    let decompositionResult;
    try {
      decompositionResult = await this.treeManager.decomposeGoal(goalId, {
        max_depth: config.maxDepth,
        min_specificity: config.minSpecificity,
        auto_prune_threshold: 0.3,
        parallel_loop_limit: 3,
      });
    } catch (err) {
      console.error("[GoalRefiner] decomposeGoal failed:", err);
      throw err;
    }

    // Reload goal after decomposition (children_ids may have been updated)
    const updatedGoal = await this.stateManager.loadGoal(goalId);
    const childrenIds = updatedGoal?.children_ids ?? decompositionResult.children.map(
      (c: Goal) => c.id
    );

    const childResults: RefineResult[] = [];
    for (const childId of childrenIds) {
      const childResult = await this._refineInternal(childId, config, depth + 1, tokensUsed);
      // Accumulate tokens from each child branch
      tokensUsed = childResult.tokensUsed;
      childResults.push(childResult);
    }

    // Reload goal once more (children may have updated it)
    const finalGoal = (await this.stateManager.loadGoal(goalId)) ?? goal;

    return {
      goal: finalGoal,
      leaf: false,
      children: childResults,
      feasibility: null,
      tokensUsed,
      reason: leafTestResult.reason,
    };
  }

  // ─── Private helpers ───

  private async _forceLeaf(goal: Goal, now: string): Promise<Goal> {
    const forced = GoalSchema.parse({
      ...goal,
      node_type: "leaf",
      updated_at: now,
    });
    await this.stateManager.saveGoal(forced);
    return forced;
  }

  /**
   * Run feasibility checks for each leaf dimension.
   * Takes goal description (data coupling, not stamp coupling).
   * Returns results and total token cost so the caller can accumulate tokens.
   */
  private async _runFeasibilityCheck(
    goalDescription: string,
    leafDimensions: LeafDimension[]
  ): Promise<{ results: FeasibilityResult[]; tokenCost: number }> {
    const results: FeasibilityResult[] = [];
    let tokenCost = 0;
    for (const ld of leafDimensions) {
      try {
        const result = await evaluateQualitatively(
          this.llmClient,
          ld.name,
          goalDescription,
          null,
          ld.threshold_value,
          DEFAULT_TIME_HORIZON_DAYS
        );
        tokenCost += 1000; // approximate per feasibility call
        results.push(result);
      } catch (err) {
        console.error(`[GoalRefiner] feasibility check failed for dimension "${ld.name}":`, err);
        results.push({
          dimension: ld.name,
          path: "qualitative",
          feasibility_ratio: null,
          assessment: "ambitious",
          confidence: "low",
          reasoning: `Feasibility check failed: ${String(err)}`,
          key_assumptions: [],
          main_risks: ["Unable to assess feasibility"],
        });
      }
    }
    return { results, tokenCost };
  }
}
