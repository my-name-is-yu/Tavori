import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ILLMClient } from "../llm/llm-client.js";
import type { IPromptGateway } from "../prompt/gateway.js";
import { EthicsGate } from "../traits/ethics-gate.js";
import { GoalSchema } from "../types/goal.js";
import type { Goal } from "../types/goal.js";
import { DimensionDecompositionSchema } from "../types/negotiation.js";
import type { SatisficingJudge } from "../drive/satisficing-judge.js";
import type { GoalTreeManager } from "./goal-tree-manager.js";
import type {
  GoalDecompositionConfig,
  DecompositionResult,
} from "../types/goal-tree.js";
import { decompositionToDimension } from "./goal-validation.js";
import type { StateManager } from "../state-manager.js";

// ─── Prompt builders ───

function buildSubgoalDecompositionPrompt(parentGoal: Goal): string {
  const dimensionsList = parentGoal.dimensions
    .map((d) => `- ${d.label} (${d.name}): target=${JSON.stringify(d.threshold)}`)
    .join("\n");

  return `Break down this goal into actionable subgoals.

Goal: ${parentGoal.title}
Description: ${parentGoal.description}
Dimensions:
${dimensionsList}

For each subgoal, provide:
- title: a clear subgoal title
- description: what needs to be achieved
- dimensions: array of dimension decompositions (same format as goal dimensions)

Return a JSON array of subgoal objects:
[
  {
    "title": "Subgoal Title",
    "description": "What to achieve",
    "dimensions": [
      {
        "name": "dimension_name",
        "label": "Dimension Label",
        "threshold_type": "min",
        "threshold_value": 50,
        "observation_method_hint": "How to measure"
      }
    ]
  }
]

Return ONLY a JSON array, no other text.`;
}

// ─── Schemas ───

const SubgoalLLMSchema = z.object({
  title: z.string(),
  description: z.string(),
  dimensions: z.array(DimensionDecompositionSchema),
});

const SubgoalListSchema = z.array(SubgoalLLMSchema);

// ─── GoalDecomposerDeps ───

export interface GoalDecomposerDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  ethicsGate: EthicsGate;
  satisficingJudge?: SatisficingJudge;
  goalTreeManager?: GoalTreeManager;
  promptGateway?: IPromptGateway;
}

// ─── decompose() ───

export async function decompose(
  goalId: string,
  parentGoal: Goal,
  deps: GoalDecomposerDeps
): Promise<{
  subgoals: Goal[];
  rejectedSubgoals: Array<{ description: string; reason: string }>;
}> {
  const { stateManager, llmClient, ethicsGate, satisficingJudge, promptGateway } = deps;

  // Step 1: LLM generates subgoals
  const prompt = buildSubgoalDecompositionPrompt(parentGoal);
  let subgoalSpecs: z.infer<typeof SubgoalListSchema>;
  if (promptGateway) {
    subgoalSpecs = await promptGateway.execute({
      purpose: "goal_decomposition",
      goalId,
      responseSchema: SubgoalListSchema,
      additionalContext: {
        prompt,
        parentGoalTitle: parentGoal.title,
        parentGoalDescription: parentGoal.description,
      },
    });
  } else {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      { temperature: 0 }
    );
    subgoalSpecs = llmClient.parseJSON(response.content, SubgoalListSchema);
  }

  const subgoals: Goal[] = [];
  const rejectedSubgoals: Array<{ description: string; reason: string }> = [];
  let hasCriticalRejection = false;

  // Step 2: Ethics check each subgoal
  for (const spec of subgoalSpecs) {
    const subgoalId = randomUUID();
    const verdict = await ethicsGate.check(
      "subgoal",
      subgoalId,
      spec.description,
      `Parent goal: ${parentGoal.title}`
    );

    if (verdict.verdict === "reject") {
      rejectedSubgoals.push({
        description: spec.title,
        reason: verdict.reasoning,
      });
      hasCriticalRejection = true;
      continue;
    }

    const now = new Date().toISOString();
    const dimensions = spec.dimensions.map(decompositionToDimension);

    const subgoal = GoalSchema.parse({
      id: subgoalId,
      parent_id: goalId,
      node_type: "subgoal",
      title: spec.title,
      description: spec.description,
      status: "active",
      dimensions,
      gap_aggregation: "max",
      dimension_mapping: null,
      constraints: parentGoal.constraints ?? [],
      children_ids: [],
      target_date: null,
      origin: "decomposition",
      pace_snapshot: null,
      deadline: null,
      confidence_flag: verdict.verdict === "flag" ? "medium" : "high",
      user_override: false,
      feasibility_note: null,
      uncertainty_weight: 1.0,
      created_at: now,
      updated_at: now,
    });

    subgoals.push(subgoal);
    await stateManager.saveGoal(subgoal);
  }

  // Phase 2: Auto-propose dimension mappings
  if (satisficingJudge) {
    for (const subgoal of subgoals) {
      try {
        const proposals = await satisficingJudge.proposeDimensionMapping(
          subgoal.dimensions.map((d) => ({ name: d.name })),
          parentGoal.dimensions.map((d) => ({ name: d.name }))
        );
        // Apply proposals to subgoal dimensions that don't already have mappings
        for (const proposal of proposals) {
          const dim = subgoal.dimensions.find((d) => d.name === proposal.subgoal_dimension);
          if (dim && !dim.dimension_mapping) {
            dim.dimension_mapping = {
              parent_dimension: proposal.parent_dimension,
              aggregation: proposal.suggested_aggregation,
            };
          }
        }
        if (proposals.length > 0) {
          await stateManager.saveGoal(subgoal);
        }
      } catch {
        // Non-critical: auto-mapping failure should not block decomposition
      }
    }
  }

  // Step 4: If critical subgoal rejected, warn (but still return what we can)
  if (hasCriticalRejection && subgoals.length === 0) {
    // All subgoals rejected — caller should consider rejecting parent goal
  }

  return { subgoals, rejectedSubgoals };
}

// ─── decomposeIntoSubgoals() ───

/**
 * Decompose a negotiated goal into subgoals using GoalTreeManager.
 * For depth >= 2, skip negotiation and auto-accept.
 * Returns null if goalTreeManager is not injected.
 */
export async function decomposeIntoSubgoals(
  goalId: string,
  deps: GoalDecomposerDeps,
  config?: GoalDecompositionConfig
): Promise<DecompositionResult | null> {
  const { stateManager, goalTreeManager } = deps;

  if (goalTreeManager === undefined) {
    return null;
  }

  const goal = await stateManager.loadGoal(goalId);
  if (!goal) {
    return null;
  }

  const resolvedConfig: GoalDecompositionConfig = config ?? {
    max_depth: 5,
    min_specificity: 0.7,
    auto_prune_threshold: 0.3,
    parallel_loop_limit: 3,
  };

  return goalTreeManager.decomposeGoal(goalId, resolvedConfig);
}
