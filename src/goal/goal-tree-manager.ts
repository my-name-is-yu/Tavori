import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Logger } from "../runtime/logger.js";
import type { StateManager } from "../state/state-manager.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { IPromptGateway } from "../prompt/gateway.js";
import type { EthicsGate } from "../traits/ethics-gate.js";
import type { GoalDependencyGraph } from "./goal-dependency-graph.js";
import { GoalSchema } from "../types/goal.js";
import type { Goal } from "../types/goal.js";
import type {
  GoalDecompositionConfig,
  DecompositionResult,
  GoalTreeState,
  ConcretenessScore,
} from "../types/goal-tree.js";
import { scoreConcreteness as _scoreConcreteness } from "./goal-tree-quality.js";
import { buildThreshold } from "./goal-validation.js";

// ─── LLM Response Schemas ───

const SpecificityResponseSchema = z.object({
  specificity_score: z.number().min(0).max(1),
  reasoning: z.string(),
});

const SubgoalItemSchema = z.object({
  hypothesis: z.string().default(""),
  dimensions: z
    .array(
      z.object({
        name: z.string(),
        label: z.string(),
        threshold_type: z.enum(["min", "max", "range", "present", "match"]),
        threshold_value: z.union([z.number(), z.string(), z.boolean(), z.null()]).nullable(),
        observation_method_hint: z.string().optional().default(""),
      })
    )
    .default([]),
  constraints: z.array(z.string()).default([]),
  expected_specificity: z.number().min(0).max(1).optional(),
});

const SubgoalsResponseSchema = z.array(SubgoalItemSchema);

const CoverageResponseSchema = z.object({
  covers_parent: z.boolean(),
  missing_dimensions: z.array(z.string()).optional().default([]),
  reasoning: z.string(),
});

// ─── Prompt Builders ───

function buildSpecificityPrompt(goal: Goal): string {
  const dimNames = goal.dimensions.map((d) => d.name).join(", ");
  const constraintLines =
    goal.constraints.length > 0
      ? `\nConstraints: ${goal.constraints.join(", ")}`
      : "";
  return `Score how decomposable this goal is (0=high-level, 1=single atomic task).
Treat 1.0 as a goal that can be executed as one task with no meaningful sub-components.
Use lower scores when the goal clearly contains distinct aspects that should become separate subgoals.
Root goals should still be scored for decomposability, not assumed to be leaves.

Title: ${goal.title}
Description: ${goal.description}
Dimensions: ${dimNames || "(none)"}${constraintLines}
Depth: ${goal.decomposition_depth}

Return ONLY: {"specificity_score":<0.0-1.0>,"reasoning":"<brief>"}`;
}

function buildSubgoalPrompt(
  goal: Goal,
  depth: number,
  maxDepth: number,
  maxChildren: number
): string {
  const constraintLines =
    goal.constraints.length > 0
      ? `Constraints: ${goal.constraints.join("; ")}`
      : "";

  const dimLines =
    goal.dimensions.length > 0
      ? `Dimensions: ${goal.dimensions.map((d) => `${d.name}(${d.label})`).join(", ")}`
      : "";

  return `Decompose into <=${maxChildren} concrete subgoals, each covering a distinct aspect.

Parent: ${goal.title}
Description: ${goal.description}
${dimLines}
${constraintLines}
Depth: ${depth}/${maxDepth}

Return a JSON array. Each item:
- "hypothesis": string — what this subgoal achieves (1-2 sentences)
- "dimensions": array of {name,label,threshold_type,threshold_value,observation_method_hint}
  - threshold_type: "min"|"max"|"range"|"present"|"match" only
- "constraints": string[]
- "expected_specificity": 0.0-1.0

Example (1 item):
[{"hypothesis":"Improve test coverage for auth module","dimensions":[{"name":"coverage_pct","label":"Coverage %","threshold_type":"min","threshold_value":80,"observation_method_hint":"jest --coverage"}],"constraints":[],"expected_specificity":0.85}]

Return ONLY the JSON array.`;
}

function buildCoveragePrompt(parent: Goal, children: Goal[]): string {
  const parentDims = parent.dimensions.map((d) => d.name).join(", ");
  const childSummaries = children
    .map((c, i) => `${i + 1}. "${c.title}": [${c.dimensions.map((d) => d.name).join(",")}]`)
    .join("\n");

  return `Do these subgoals cover all parent dimensions?

Parent: ${parent.title}
Dimensions: ${parentDims || "(none)"}
Subgoals:
${childSummaries}

Return ONLY: {"covers_parent":<true|false>,"missing_dimensions":[],"reasoning":"<brief>"}`;
}

// ─── Helper: Build a Goal from subgoal spec ───

function buildGoalFromSubgoalSpec(
  spec: z.infer<typeof SubgoalItemSchema>,
  parentId: string,
  parentDepth: number,
  now: string
): Goal {
  const id = randomUUID();
  const dims = spec.dimensions.map((d) => ({
    name: d.name,
    label: d.label,
    current_value: null,
    threshold: buildThreshold(d.threshold_type, d.threshold_value),
    confidence: 0.5,
    observation_method: {
      type: "manual" as const,
      source: "decomposition",
      schedule: null,
      endpoint: null,
      confidence_tier: "self_report" as const,
    },
    last_updated: now,
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok" as const,
    dimension_mapping: null,
  }));

  return GoalSchema.parse({
    id,
    parent_id: parentId,
    node_type: "subgoal",
    title: spec.hypothesis.slice(0, 200),
    description: spec.hypothesis,
    status: "active",
    dimensions: dims,
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: spec.constraints,
    children_ids: [],
    target_date: null,
    origin: "decomposition",
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: parentDepth + 1,
    specificity_score: spec.expected_specificity ?? null,
    loop_status: "idle",
    created_at: now,
    updated_at: now,
  });
}

// ─── GoalTreeManager ───

/**
 * GoalTreeManager handles recursive goal decomposition and tree state queries.
 *
 * Responsibilities:
 *   - Specificity evaluation (LLM)
 *   - N-layer recursive decomposition
 *   - Decomposition validation (coverage + cycle check)
 *   - Tree state queries
 */
export interface GoalTreeManagerOptions {
  concretenesThreshold?: number;
  maxDepth?: number;
  logger?: Logger;
}

export class GoalTreeManager {
  private readonly concretenesThreshold: number | null;
  private readonly maxDepth: number;
  private readonly logger?: Logger;

  constructor(
    private readonly stateManager: StateManager,
    private readonly llmClient: ILLMClient,
    private readonly ethicsGate: EthicsGate,
    private readonly goalDependencyGraph: GoalDependencyGraph,
    options?: GoalTreeManagerOptions,
    private readonly promptGateway?: IPromptGateway
  ) {
    // null means concreteness auto-stop is disabled (backward compatible)
    this.concretenesThreshold = options?.concretenesThreshold ?? null;
    this.maxDepth = options?.maxDepth ?? 5;
    this.logger = options?.logger;
  }

  // ─── Concreteness Scoring (private) ───

  private async scoreConcreteness(description: string): Promise<ConcretenessScore> {
    return _scoreConcreteness(description, { llmClient: this.llmClient });
  }

  // ─── Specificity Evaluation ───

  /**
   * Evaluates the specificity of a goal using an LLM.
   * Returns a score between 0 (very abstract) and 1 (very concrete).
   * Falls back to 0.5 on parse failures.
   */
  private async evaluateSpecificity(
    goal: Goal
  ): Promise<{ score: number; reasoning: string }> {
    const prompt = buildSpecificityPrompt(goal);
    try {
      let parsed: { specificity_score: number; reasoning: string };
      if (this.promptGateway) {
        parsed = await this.promptGateway.execute({
          purpose: "goal_specificity_evaluation",
          goalId: goal.id,
          responseSchema: SpecificityResponseSchema,
          additionalContext: {
            prompt,
            goalTitle: goal.title,
            goalDescription: goal.description,
          },
        });
      } else {
        this.logger?.info(`[LLM] ${new Date().toISOString()} calling goal_specificity_evaluation goalId=${goal.id}`);
        const response = await this.llmClient.sendMessage(
          [{ role: "user", content: prompt }],
          { temperature: 0 }
        );
        this.logger?.info(`[LLM] ${new Date().toISOString()} done goal_specificity_evaluation goalId=${goal.id}`);
        parsed = this.llmClient.parseJSON(
          response.content,
          SpecificityResponseSchema
        );
      }
      return { score: parsed.specificity_score, reasoning: parsed.reasoning };
    } catch {
      // Conservative fallback: treat as needing decomposition
      return { score: 0.5, reasoning: "LLM evaluation failed, defaulting to 0.5" };
    }
  }

  // ─── Core Decomposition ───

  /**
   * Recursively decomposes a goal into subgoals until each subgoal either:
   *   (a) has specificity_score >= config.min_specificity -> leaf node
   *   (b) has decomposition_depth >= config.max_depth -> forced leaf
   *   (c) concreteness score >= concretenesThreshold (auto-stop)
   *   (d) current depth >= maxDepth (depth guard)
   *
   * Options override instance-level defaults when provided.
   * Returns a DecompositionResult for the top-level call.
   *
   * @deprecated For new goals, use {@link GoalRefiner.refine} instead.
   * This method is used internally by GoalRefiner and remains callable for backward compatibility.
   */
  async decomposeGoal(
    goalId: string,
    config: GoalDecompositionConfig,
    options?: { concretenesThreshold?: number; maxDepth?: number }
  ): Promise<DecompositionResult> {
    const goal = await this.stateManager.loadGoal(goalId);
    if (!goal) {
      throw new Error(`GoalTreeManager.decomposeGoal: goal "${goalId}" not found`);
    }

    const effectiveConcretenesThreshold =
      options?.concretenesThreshold ?? this.concretenesThreshold;
    const effectiveMaxDepth = options?.maxDepth ?? this.maxDepth;

    // Auto-stop: check concreteness before decomposing (only when threshold is explicitly set)
    if (effectiveConcretenesThreshold !== null) {
      const concretenessResult = await this.scoreConcreteness(goal.description);
      if (concretenessResult.score >= effectiveConcretenesThreshold) {
        const now = new Date().toISOString();
        const leafGoal: Goal = {
          ...goal,
          node_type: "leaf",
          specificity_score: concretenessResult.score,
          updated_at: now,
        };
        await this.stateManager.saveGoal(leafGoal);
        return {
          parent_id: goal.id,
          children: [],
          depth: goal.decomposition_depth,
          specificity_scores: { [goal.id]: concretenessResult.score },
          reasoning: `Auto-stop: concreteness score ${concretenessResult.score.toFixed(2)} >= threshold ${effectiveConcretenesThreshold}. ${concretenessResult.reason}`,
        };
      }
    }

    return this._decomposeGoalInternal(goal, config, 0, effectiveMaxDepth);
  }

  private async _decomposeGoalInternal(
    goal: Goal,
    config: GoalDecompositionConfig,
    retryCount: number,
    depthLimit?: number
  ): Promise<DecompositionResult> {
    const now = new Date().toISOString();
    const effectiveMaxDepth = depthLimit ?? config.max_depth;

    // Step 1: Evaluate specificity
    const { score: specificityScore, reasoning } = await this.evaluateSpecificity(goal);

    // Update goal with specificity score
    const updatedGoal: Goal = {
      ...goal,
      specificity_score: specificityScore,
      updated_at: now,
    };

    // Step 2: Determine if this is a leaf node
    const isRootGoal = goal.decomposition_depth === 0;
    const isLeaf =
      (!isRootGoal && specificityScore >= config.min_specificity) ||
      goal.decomposition_depth >= effectiveMaxDepth;

    if (isLeaf) {
      // Mark as leaf node
      const leafGoal: Goal = {
        ...updatedGoal,
        node_type: "leaf",
        updated_at: now,
      };
      await this.stateManager.saveGoal(leafGoal);

      return {
        parent_id: goal.id,
        children: [],
        depth: goal.decomposition_depth,
        specificity_scores: { [goal.id]: specificityScore },
        reasoning:
          specificityScore >= config.min_specificity
            ? `Goal is specific enough (score=${specificityScore.toFixed(2)}): ${reasoning}`
            : `Max depth ${effectiveMaxDepth} reached, forced leaf`,
      };
    }

    // Step 3: Generate subgoals via LLM
    const maxChildren = 5;
    const subgoalPrompt = buildSubgoalPrompt(
      updatedGoal,
      goal.decomposition_depth,
      effectiveMaxDepth,
      maxChildren
    );

    let subgoalSpecs: z.infer<typeof SubgoalsResponseSchema> = [];
    try {
      if (this.promptGateway) {
        const parsed = await this.promptGateway.execute({
          purpose: "goal_decomposition",
          goalId: goal.id,
          responseSchema: SubgoalsResponseSchema,
          additionalContext: {
            prompt: subgoalPrompt,
            parentGoalTitle: goal.title,
            parentGoalDescription: goal.description,
          },
        });
        subgoalSpecs = parsed.map((sg) => {
          let hypothesis = sg.hypothesis;
          if (!hypothesis) {
            const firstDimLabel = sg.dimensions?.[0]?.label;
            hypothesis = firstDimLabel ? firstDimLabel : goal.title;
          }
          return {
            ...sg,
            hypothesis,
            dimensions: (sg.dimensions ?? []).map((d) => ({
              ...d,
              observation_method_hint: d.observation_method_hint ?? "",
            })),
            constraints: sg.constraints ?? [],
          };
        });
        subgoalSpecs = subgoalSpecs.slice(0, maxChildren);
      } else {
        this.logger?.info(`[LLM] ${new Date().toISOString()} calling goal_decomposition goalId=${goal.id}`);
        const subgoalResponse = await this.llmClient.sendMessage(
          [{ role: "user", content: subgoalPrompt }],
          { temperature: 0 }
        );
        this.logger?.info(`[LLM] ${new Date().toISOString()} done goal_decomposition goalId=${goal.id}`);
        // Normalize hypothesis field: LLMs may use "title", "description", "goal", etc.
        // Pre-parse to fix missing hypothesis keys before passing to parseJSON.
        let contentToPass = subgoalResponse.content;
        let preprocessed: unknown;
        try {
          preprocessed = JSON.parse(subgoalResponse.content);
        } catch (err) {
          this.logger?.warn(`[GoalTreeManager] Failed to pre-parse subgoal LLM response as JSON: ${String(err)}`);
          preprocessed = null;
        }
        if (Array.isArray(preprocessed)) {
          for (const item of preprocessed) {
            if (item && typeof item === "object" && !("hypothesis" in item)) {
              this.logger?.warn(
                `[GoalTreeManager] Subgoal item missing hypothesis. Keys: ${Object.keys(item as object).join(", ")}`
              );
              const alt =
                (item as Record<string, unknown>).title ??
                (item as Record<string, unknown>).description ??
                (item as Record<string, unknown>).goal ??
                (item as Record<string, unknown>).objective ??
                (item as Record<string, unknown>).name ??
                (item as Record<string, unknown>).text ??
                (item as Record<string, unknown>).summary ??
                (item as Record<string, unknown>).label ??
                "Unnamed subgoal";
              (item as Record<string, unknown>).hypothesis = String(alt);
            }
          }
          contentToPass = JSON.stringify(preprocessed);
        }
        const parsed = this.llmClient.parseJSON(contentToPass, SubgoalsResponseSchema);
        subgoalSpecs = parsed.map((sg: (typeof parsed)[number]) => {
          // Derive hypothesis from dimensions or parent goal title when the LLM omitted it
          let hypothesis = sg.hypothesis;
          if (!hypothesis) {
            const firstDimLabel = sg.dimensions?.[0]?.label;
            hypothesis = firstDimLabel ? firstDimLabel : goal.title;
          }
          return {
            ...sg,
            hypothesis,
            dimensions: (sg.dimensions ?? []).map((d) => ({
              ...d,
              observation_method_hint: d.observation_method_hint ?? "",
            })),
            constraints: sg.constraints ?? [],
          };
        });
        // Clamp to max_children_per_node
        subgoalSpecs = subgoalSpecs.slice(0, maxChildren);
      }
    } catch (err) {
      // If subgoal generation fails, treat as leaf -- but log the error for diagnostics
      this.logger?.error(
        `[GoalTreeManager] Subgoal generation failed for "${goal.id}": ${err instanceof Error ? err.message : String(err)}`
      );
      const leafGoal: Goal = {
        ...updatedGoal,
        node_type: "leaf",
        updated_at: now,
      };
      await this.stateManager.saveGoal(leafGoal);
      return {
        parent_id: goal.id,
        children: [],
        depth: goal.decomposition_depth,
        specificity_scores: { [goal.id]: specificityScore },
        reasoning: `Subgoal generation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Handle empty decomposition
    if (subgoalSpecs.length === 0) {
      const leafGoal: Goal = {
        ...updatedGoal,
        node_type: "leaf",
        updated_at: now,
      };
      await this.stateManager.saveGoal(leafGoal);
      return {
        parent_id: goal.id,
        children: [],
        depth: goal.decomposition_depth,
        specificity_scores: { [goal.id]: specificityScore },
        reasoning: "LLM returned empty subgoal list, treating as leaf",
      };
    }

    // Step 4: Build child Goal objects
    const childGoals: Goal[] = subgoalSpecs.map((spec) =>
      buildGoalFromSubgoalSpec(spec, goal.id, goal.decomposition_depth, now)
    );

    // Step 5: Build the provisional decomposition result for validation
    const provisionalResult: DecompositionResult = {
      parent_id: goal.id,
      children: childGoals,
      depth: goal.decomposition_depth,
      specificity_scores: { [goal.id]: specificityScore },
      reasoning,
    };

    // Step 6: Validate decomposition (retry up to 2 times)
    const isValid = await this.validateDecomposition(provisionalResult);
    if (!isValid && retryCount < 2) {
      // Retry decomposition
      return this._decomposeGoalInternal(goal, config, retryCount + 1, depthLimit);
    }

    // Step 7: Save parent goal (updated specificity_score, node_type stays as-is for non-leaf)
    await this.stateManager.saveGoal(updatedGoal);

    // Step 8: Save each child goal and update parent's children_ids
    const childIds: string[] = [];
    for (const child of childGoals) {
      await this.stateManager.saveGoal(child);
      childIds.push(child.id);

      // Parent-child relationships are tracked via children_ids on the parent goal.
      // No need to register in GoalDependencyGraph; cycle detection uses detectCycle() directly.
    }

    // Update parent goal's children_ids
    const parentWithChildren: Goal = {
      ...updatedGoal,
      children_ids: [...updatedGoal.children_ids, ...childIds],
      updated_at: now,
    };
    await this.stateManager.saveGoal(parentWithChildren);

    // Step 9: Collect specificity scores for result
    const specificityScores: Record<string, number> = {
      [goal.id]: specificityScore,
    };

    // Step 10: Recursively decompose each child
    for (const child of childGoals) {
      const childResult = await this._decomposeGoalInternal(child, config, 0, depthLimit);
      // Merge child specificity scores
      Object.assign(specificityScores, childResult.specificity_scores);
      // Merge children into child's record
      if (childResult.children.length > 0) {
        const reloadedChild = await this.stateManager.loadGoal(child.id);
        if (reloadedChild) {
          // child was saved with updated children_ids from recursive call
          void reloadedChild; // already persisted by recursive call
        }
      }
    }

    return {
      parent_id: goal.id,
      children: childGoals,
      depth: goal.decomposition_depth,
      specificity_scores: specificityScores,
      reasoning,
    };
  }

  // ─── Validation ───

  /**
   * Validates a decomposition result by checking:
   *   1. Coverage: subgoals cover all parent dimensions (LLM)
   *   2. Cycle detection: no circular dependencies introduced
   *
   * Returns true only if both checks pass.
   */
  private async validateDecomposition(result: DecompositionResult): Promise<boolean> {
    const parent = await this.stateManager.loadGoal(result.parent_id);
    if (!parent) return false;

    const children = result.children as Goal[];

    // Check 1: Coverage validation via LLM
    if (children.length > 0) {
      const coveragePrompt = buildCoveragePrompt(parent, children);
      try {
        let coverage: z.output<typeof CoverageResponseSchema>;
        if (this.promptGateway) {
          const raw = await this.promptGateway.execute({
            purpose: "goal_coverage_validation",
            goalId: parent.id,
            responseSchema: CoverageResponseSchema,
            additionalContext: {
              prompt: coveragePrompt,
              parentGoalTitle: parent.title,
              childCount: String(children.length),
            },
          });
          coverage = { covers_parent: raw.covers_parent, missing_dimensions: raw.missing_dimensions ?? [], reasoning: raw.reasoning };
        } else {
          this.logger?.info(`[LLM] ${new Date().toISOString()} calling goal_coverage_validation goalId=${parent.id}`);
          const coverageResponse = await this.llmClient.sendMessage(
            [{ role: "user", content: coveragePrompt }],
            { temperature: 0 }
          );
          this.logger?.info(`[LLM] ${new Date().toISOString()} done goal_coverage_validation goalId=${parent.id}`);
          const raw = this.llmClient.parseJSON(
            coverageResponse.content,
            CoverageResponseSchema
          );
          coverage = { covers_parent: raw.covers_parent, missing_dimensions: raw.missing_dimensions ?? [], reasoning: raw.reasoning };
        }
        if (!coverage.covers_parent) {
          return false;
        }
      } catch {
        // On parse failure, allow decomposition to proceed
      }
    }

    // Check 2: Cycle detection
    for (const child of children as Goal[]) {
      const wouldCycle = this.goalDependencyGraph.detectCycle(result.parent_id, child.id);
      if (wouldCycle) {
        return false;
      }
    }

    return true;
  }

  // ─── Tree State ───

  /**
   * Computes the current GoalTreeState for the tree rooted at rootId.
   * Traverses all descendants recursively.
   */
  async getTreeState(rootId: string): Promise<GoalTreeState> {
    const root = await this.stateManager.loadGoal(rootId);
    if (!root) {
      return {
        root_id: rootId,
        total_nodes: 0,
        max_depth_reached: 0,
        active_loops: [],
        pruned_nodes: [],
      };
    }

    let totalNodes = 0;
    let maxDepthReached = 0;
    const activeLoops: string[] = [];
    const prunedNodes: string[] = [];

    const visit = async (goal: Goal): Promise<void> => {
      totalNodes++;

      if (goal.decomposition_depth > maxDepthReached) {
        maxDepthReached = goal.decomposition_depth;
      }

      if (goal.loop_status === "running") {
        activeLoops.push(goal.id);
      }

      if (goal.status === "cancelled") {
        prunedNodes.push(goal.id);
      }

      for (const childId of goal.children_ids) {
        const child = await this.stateManager.loadGoal(childId);
        if (child) {
          await visit(child);
        }
      }
    };

    await visit(root);

    return {
      root_id: rootId,
      total_nodes: totalNodes,
      max_depth_reached: maxDepthReached,
      active_loops: activeLoops,
      pruned_nodes: prunedNodes,
    };
  }

  // ─── Private Helpers ───

  private async _collectAllDescendantIds(goalId: string): Promise<string[]> {
    const goal = await this.stateManager.loadGoal(goalId);
    if (!goal) return [];
    const result: string[] = [];
    for (const childId of goal.children_ids) {
      result.push(childId);
      result.push(...await this._collectAllDescendantIds(childId));
    }
    return result;
  }
}
