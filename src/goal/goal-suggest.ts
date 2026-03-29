/**
 * goal-suggest.ts — Goal suggestion, filtering, and project context gathering.
 * Extracted from GoalNegotiator to keep the core class focused on negotiation.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Logger } from "../runtime/logger.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { EthicsGate } from "../traits/ethics-gate.js";
import type { CapabilityDetector } from "../observation/capability-detector.js";
import type { IPromptGateway } from "../prompt/gateway.js";
import type { DimensionDecomposition } from "../types/negotiation.js";

// ─── Goal Suggestion schemas ───

const GoalSuggestionSchema = z.object({
  title: z.string(),
  description: z.string(),
  rationale: z.string(),
  dimensions_hint: z.array(z.string()),
});

const GoalSuggestionListSchema = z.array(GoalSuggestionSchema);

export type GoalSuggestion = z.infer<typeof GoalSuggestionSchema>;

// ─── Capability check schema for LLM parsing ───

export const CapabilityCheckResultSchema = z.object({
  gaps: z.array(z.object({
    dimension: z.string(),
    required_capability: z.string(),
    acquirable: z.boolean(),
    reason: z.string(),
  })),
});

// ─── Prompts ───

export function looksLikeSoftwareGoal(context: string): boolean {
  const keywords = ['package.json', 'src/', 'tests/', 'node_modules', '.git', 'npm', 'build', 'deploy', 'api', 'repository', 'code', 'function', 'class', 'module'];
  const lower = context.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

export function buildSuggestGoalsPrompt(
  context: string,
  maxSuggestions: number,
  existingGoals: string[]
): string {
  const existingGoalsSection =
    existingGoals.length > 0
      ? `\nExisting goals (do NOT suggest duplicates):\n${existingGoals.map((g) => `- ${g}`).join("\n")}`
      : "";

  const isSoftware = looksLikeSoftwareGoal(context);

  const systemPrompt = isSoftware
    ? `You are a goal advisor for a software project. Given the project context below, suggest concrete, measurable improvement goals.

Each goal should:
1. Be specific and achievable (not vague like "improve code quality")
2. Have clear success criteria that can be measured
3. Include 2-4 dimension hints (what to measure)
4. Be independent of other suggestions

The "description" field must describe a concrete action — it must start with an action verb (e.g., "Add", "Update", "Implement", "Refactor", "Document", "Create", "Fix") and refer to a specific file or module path (e.g., "src/...", "tests/...", "docs/..."). Do NOT include instructions about updating README.md unless the goal is genuinely about documentation. Do NOT use vague descriptions like "deliver a verifiable improvement".`
    : `You are a goal advisor. Given the context below, suggest concrete, measurable improvement goals.

Each goal should:
1. Be specific and achievable
2. Have clear success criteria that can be measured
3. Include 2-4 dimension hints (what to measure)
4. Be independent of other suggestions

The "description" field must describe a concrete action starting with an action verb (e.g., "Add", "Update", "Implement", "Create", "Fix"). Do NOT use vague descriptions like "deliver a verifiable improvement".`;

  return `${systemPrompt}

Context:
${context}${existingGoalsSection}

Return a JSON array of up to ${maxSuggestions} suggestions:
[
  {
    "title": "Short descriptive title",
    "description": "Add/Update/Implement [specific action] to [concrete outcome]",
    "rationale": "Why this goal matters",
    "dimensions_hint": ["dimension_name_1", "dimension_name_2"]
  }
]

Return ONLY a JSON array, no other text.`;
}

export function buildCapabilityCheckPrompt(
  goalDescription: string,
  dimensions: DimensionDecomposition[],
  adapterCapabilities: Array<{ adapterType: string; capabilities: string[] }>
): string {
  const dimensionsList = dimensions
    .map((d) => `- ${d.name}: ${d.label} (threshold_type: ${d.threshold_type}, observation_hint: ${d.observation_method_hint})`)
    .join("\n");

  const capabilitiesList = adapterCapabilities
    .map((ac) => `- ${ac.adapterType}: ${ac.capabilities.join(", ")}`)
    .join("\n");

  return `You are assessing whether an agent can achieve each dimension of a goal given its available capabilities.

Goal: ${goalDescription}

Dimensions to achieve:
${dimensionsList}

Available adapter capabilities:
${capabilitiesList}

For each dimension that requires a capability NOT available in the listed adapters, report it as a gap.
Also indicate whether the missing capability is acquirable (i.e., can the agent learn or install it during execution).

Return a JSON object:
{
  "gaps": [
    {
      "dimension": "dimension_name",
      "required_capability": "capability_name",
      "acquirable": false,
      "reason": "brief explanation why this capability is missing and whether it can be acquired"
    }
  ]
}

If all dimensions can be achieved with the available capabilities, return { "gaps": [] }.
Return ONLY a JSON object, no other text.`;
}

// ─── suggestGoals (standalone) ───

/**
 * Suggest measurable improvement goals based on the given context.
 * Does NOT save goals — it only suggests. Use GoalNegotiator.negotiate() to register a suggestion.
 */
export async function suggestGoals(
  context: string,
  llmClient: ILLMClient,
  ethicsGate: EthicsGate,
  adapterCapabilities: Array<{ adapterType: string; capabilities: string[] }> | undefined,
  options?: {
    maxSuggestions?: number;
    existingGoals?: string[];
    capabilityDetector?: CapabilityDetector;
    logger?: Logger;
    gateway?: IPromptGateway;
  }
): Promise<GoalSuggestion[]> {
  const maxSuggestions = options?.maxSuggestions ?? 5;
  const existingGoals = options?.existingGoals ?? [];

  if (!context || context.trim().length === 0) {
    return [];
  }

  const prompt = buildSuggestGoalsPrompt(context, maxSuggestions, existingGoals);

  let suggestions: GoalSuggestion[];
  if (options?.gateway) {
    try {
      suggestions = await options.gateway.execute({
        purpose: "goal_suggestion",
        additionalContext: { prompt },
        responseSchema: GoalSuggestionListSchema,
        temperature: 0.3,
      });
    } catch {
      return [];
    }
  } else {
    let rawContent: string;
    try {
      const response = await llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { temperature: 0.3 }
      );
      rawContent = response.content;
    } catch (err) {
      options?.logger?.warn(`[suggestGoals] LLM call failed: ${err}`);
      return [];
    }

    try {
      suggestions = llmClient.parseJSON(rawContent, GoalSuggestionListSchema);
    } catch (err) {
      options?.logger?.warn(`[suggestGoals] Failed to parse LLM response as GoalSuggestionList: ${err}`);
      return [];
    }
  }

  // Apply ethics filtering — remove rejected suggestions
  const ethicsFiltered: GoalSuggestion[] = [];
  for (const suggestion of suggestions) {
    try {
      const verdict = await ethicsGate.check(
        "goal",
        randomUUID(),
        suggestion.description
      );
      if (verdict.verdict === "reject") {
        continue;
      }
      ethicsFiltered.push(suggestion);
    } catch {
      // Non-critical: if ethics check fails, include the suggestion
      ethicsFiltered.push(suggestion);
    }
  }

  return filterSuggestions(
    ethicsFiltered,
    options?.existingGoals || [],
    adapterCapabilities,
    options?.capabilityDetector,
    options?.logger,
  );
}

// ─── filterSuggestions (standalone) ───

export async function filterSuggestions(
  suggestions: GoalSuggestion[],
  existingGoals: string[],
  adapterCapabilities: Array<{ adapterType: string; capabilities: string[] }> | undefined,
  capabilityDetector?: CapabilityDetector,
  logger?: Logger,
): Promise<GoalSuggestion[]> {
  const filtered: GoalSuggestion[] = [];

  for (const suggestion of suggestions) {
    // 1. Dedup: skip if similar to existing goal (case-insensitive substring match)
    const isDuplicate = existingGoals.some(existing => {
      const existingLower = existing.toLowerCase();
      const titleLower = suggestion.title.toLowerCase();
      return existingLower.includes(titleLower) || titleLower.includes(existingLower);
    });
    if (isDuplicate) {
      logger?.info(`[GoalNegotiator] Filtered duplicate suggestion: "${suggestion.title}"`);
      continue;
    }

    // 2. Feasibility check via CapabilityDetector (if available)
    if (capabilityDetector) {
      try {
        const gap = await capabilityDetector.detectGoalCapabilityGap(
          suggestion.description,
          adapterCapabilities?.map(a => a.capabilities).flat() || []
        );
        if (gap && !gap.acquirable) {
          logger?.info(`[GoalNegotiator] Filtered infeasible suggestion: "${suggestion.title}" — ${gap.gap.reason}`);
          continue;
        }
      } catch (err) {
        // Non-blocking: if capability check fails, keep the suggestion
        logger?.warn(`[GoalNegotiator] Capability check failed for "${suggestion.title}": ${err}`);
      }
    }

    filtered.push(suggestion);
  }

  return filtered;
}
