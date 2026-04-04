import { z } from "zod";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { Logger } from "../../runtime/logger.js";
import type { ConcretenessScore, DecompositionQualityMetrics } from "../../base/types/goal-tree.js";
import { ConcretenessScoreSchema, DecompositionQualityMetricsSchema } from "../../base/types/goal-tree.js";
import type { IPromptGateway } from "../../prompt/gateway.js";

// ─── LLM Response Schemas ───

const ConcretenessLLMResponseSchema = z.object({
  hasQuantitativeThreshold: z.boolean(),
  hasObservableOutcome: z.boolean(),
  hasTimebound: z.boolean(),
  hasClearScope: z.boolean(),
  reason: z.string(),
});

const QualityEvaluationResponseSchema = z.object({
  coverage: z.number().min(0).max(1),
  overlap: z.number().min(0).max(1),
  actionability: z.number().min(0).max(1),
  reasoning: z.string(),
});

// ─── Prompt Builders ───

function buildConcretenessPrompt(description: string): string {
  return `Evaluate the concreteness of this goal description on four dimensions.

Goal description: "${description}"

Answer each question:
1. hasQuantitativeThreshold: Does the goal specify quantitative/measurable success criteria or thresholds? (e.g., "achieve 80% coverage", "response time < 200ms")
2. hasObservableOutcome: Does the goal describe an observable, verifiable outcome? (e.g., "a working API endpoint", "passing CI build")
3. hasTimebound: Does the goal have a time constraint or deadline? (e.g., "by end of sprint", "within 2 weeks")
4. hasClearScope: Does the goal have a clearly defined scope with no ambiguity about what is included or excluded?

Output JSON:
{
  "hasQuantitativeThreshold": <true|false>,
  "hasObservableOutcome": <true|false>,
  "hasTimebound": <true|false>,
  "hasClearScope": <true|false>,
  "reason": "<brief explanation covering all four dimensions>"
}

Return ONLY the JSON object, no other text.`;
}

function buildQualityEvaluationPrompt(parentDescription: string, subgoalDescriptions: string[]): string {
  const subgoalList = subgoalDescriptions
    .map((desc, i) => `  ${i + 1}. "${desc}"`)
    .join("\n");

  return `Evaluate the quality of this goal decomposition.

Parent goal: "${parentDescription}"

Subgoals:
${subgoalList}

Evaluate:
1. coverage (0.0-1.0): How well do the subgoals collectively cover all aspects of the parent goal? 1.0 = complete coverage, 0.0 = no coverage.
2. overlap (0.0-1.0): How much redundancy/overlap exists between subgoals? 0.0 = no overlap (ideal), 1.0 = all subgoals are identical.
3. actionability (0.0-1.0): Average concreteness/actionability of the subgoals. 1.0 = all are immediately actionable, 0.0 = all are too abstract.

Output JSON:
{
  "coverage": <number 0.0 to 1.0>,
  "overlap": <number 0.0 to 1.0>,
  "actionability": <number 0.0 to 1.0>,
  "reasoning": "<brief explanation>"
}

Return ONLY the JSON object, no other text.`;
}

// ─── Deps Interface ───

export interface GoalTreeQualityDeps {
  llmClient: ILLMClient;
  logger?: Logger;
  promptGateway?: IPromptGateway;
}

// ─── Quality Functions ───

/**
 * Scores the concreteness of a goal description on four dimensions using an LLM.
 * Score = weighted average of 4 boolean dimensions (each 0.25).
 * Falls back to zero score on LLM/parse failures.
 */
export async function scoreConcreteness(
  description: string,
  deps: GoalTreeQualityDeps
): Promise<ConcretenessScore> {
  if (!description || description.trim() === "") {
    return ConcretenessScoreSchema.parse({
      score: 0,
      dimensions: {
        hasQuantitativeThreshold: false,
        hasObservableOutcome: false,
        hasTimebound: false,
        hasClearScope: false,
      },
      reason: "Empty description provided",
    });
  }

  const prompt = buildConcretenessPrompt(description);
  try {
    let parsed: z.infer<typeof ConcretenessLLMResponseSchema>;
    if (deps.promptGateway) {
      parsed = await deps.promptGateway.execute({
        purpose: "goal_decomposition",
        additionalContext: { concreteness_prompt: prompt },
        responseSchema: ConcretenessLLMResponseSchema,
        temperature: 0,
      });
    } else {
      const response = await deps.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { temperature: 0 }
      );
      parsed = deps.llmClient.parseJSON(response.content, ConcretenessLLMResponseSchema);
    }
    const dims = {
      hasQuantitativeThreshold: parsed.hasQuantitativeThreshold,
      hasObservableOutcome: parsed.hasObservableOutcome,
      hasTimebound: parsed.hasTimebound,
      hasClearScope: parsed.hasClearScope,
    };
    const trueCount = Object.values(dims).filter(Boolean).length;
    const score = trueCount * 0.25;
    return ConcretenessScoreSchema.parse({
      score,
      dimensions: dims,
      reason: parsed.reason,
    });
  } catch {
    return ConcretenessScoreSchema.parse({
      score: 0,
      dimensions: {
        hasQuantitativeThreshold: false,
        hasObservableOutcome: false,
        hasTimebound: false,
        hasClearScope: false,
      },
      reason: "LLM evaluation failed, defaulting to zero score",
    });
  }
}

/**
 * Evaluates the quality of a decomposition using an LLM.
 * Measures coverage, overlap, actionability, and computes depthEfficiency.
 * Logs a warning when quality is poor (coverage < 0.5 or overlap > 0.7).
 */
export async function evaluateDecompositionQuality(
  parentDescription: string,
  subgoalDescriptions: string[],
  deps: GoalTreeQualityDeps
): Promise<DecompositionQualityMetrics> {
  if (subgoalDescriptions.length === 0) {
    const metrics = DecompositionQualityMetricsSchema.parse({
      coverage: 0,
      overlap: 0,
      actionability: 0,
      depthEfficiency: 1,
    });
    deps.logger?.warn(
      "GoalTreeManager.evaluateDecompositionQuality: no subgoals provided — coverage=0"
    );
    return metrics;
  }

  const prompt = buildQualityEvaluationPrompt(parentDescription, subgoalDescriptions);
  let coverage = 0;
  let overlap = 0;
  let actionability = 0;

  try {
    let parsed: z.infer<typeof QualityEvaluationResponseSchema>;
    if (deps.promptGateway) {
      parsed = await deps.promptGateway.execute({
        purpose: "goal_decomposition",
        additionalContext: { quality_prompt: prompt },
        responseSchema: QualityEvaluationResponseSchema,
        temperature: 0,
      });
    } else {
      const response = await deps.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { temperature: 0 }
      );
      parsed = deps.llmClient.parseJSON(response.content, QualityEvaluationResponseSchema);
    }
    coverage = parsed.coverage;
    overlap = parsed.overlap;
    actionability = parsed.actionability;
  } catch {
    // On failure return conservative metrics
    coverage = 0;
    overlap = 0;
    actionability = 0;
  }

  const depthEfficiency = Math.max(0, Math.min(1, 1 - overlap * 0.5));

  const metrics = DecompositionQualityMetricsSchema.parse({
    coverage,
    overlap,
    actionability,
    depthEfficiency,
  });

  if (coverage < 0.5 || overlap > 0.7) {
    deps.logger?.warn(
      `GoalTreeManager.evaluateDecompositionQuality: poor quality detected — coverage=${coverage.toFixed(2)}, overlap=${overlap.toFixed(2)}`
    );
  }

  return metrics;
}
