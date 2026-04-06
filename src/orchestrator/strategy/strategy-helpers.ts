import { z } from "zod";
import { StrategySchema } from "../../base/types/strategy.js";
import { parseStrategy } from "./types/strategy.js";
import { KnowledgeGapSignalSchema } from "../../base/types/knowledge.js";
import type { StrategyState } from "../../base/types/core.js";
import type { Strategy } from "../../base/types/strategy.js";
import type { KnowledgeGapSignal } from "../../base/types/knowledge.js";

// ─── Valid state transitions ───

export const VALID_TRANSITIONS: Record<StrategyState, StrategyState[]> = {
  candidate: ["active"],
  active: ["completed", "terminated", "evaluating"],
  evaluating: ["active", "terminated"],
  suspended: ["active", "terminated"],
  completed: [],
  terminated: [],
};

// ─── Internal schema for parsing LLM array response ───

export const StrategyArraySchema = z.array(
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
    required_tools: z.array(z.string()).default([]),
  })
);

/**
 * Unwrap a potentially-wrapped LLM response before schema validation.
 * LLMs may return a wrapper object instead of a bare array. This function
 * checks common wrapper keys, then falls back to single-key unwrapping.
 */
export function unwrapStrategyResponse(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const record = raw as Record<string, unknown>;
  for (const key of ["candidates", "strategies", "data", "results", "items"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  const keys = Object.keys(record);
  if (keys.length === 1 && Array.isArray(record[keys[0]!])) {
    return record[keys[0]!];
  }
  return raw;
}

// ─── LLM prompt builder ───

export function buildGenerationPrompt(
  goalId: string,
  primaryDimension: string,
  targetDimensions: string[],
  context: { currentGap: number; pastStrategies: Strategy[] },
  enrichment?: { templatesBlock?: string; lessonsBlock?: string; workspaceBlock?: string }
): string {
  // Sort all past strategies most recent first
  const sorted = [...context.pastStrategies].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  // Partition into dimension-relevant and other strategies
  const dimensionRelevant = sorted.filter(
    (s) =>
      s.primary_dimension === primaryDimension ||
      s.target_dimensions.includes(primaryDimension)
  );
  const otherStrategies = sorted.filter(
    (s) =>
      s.primary_dimension !== primaryDimension &&
      !s.target_dimensions.includes(primaryDimension)
  );

  // Fallback: if fewer than 3 dimension-relevant, pad with other same-goal strategies
  const MIN_RELEVANT = 3;
  const MAX_TOTAL = 10;
  let selectedRelevant = dimensionRelevant.slice(0, MAX_TOTAL);
  let selectedOther: Strategy[] = [];
  if (selectedRelevant.length < MIN_RELEVANT) {
    const needed = Math.min(MIN_RELEVANT - selectedRelevant.length, otherStrategies.length);
    selectedOther = otherStrategies.slice(0, needed);
  }

  // Cap total at 10
  const totalRelevant = selectedRelevant.length;
  const remainingCap = MAX_TOTAL - totalRelevant;
  selectedOther = selectedOther.slice(0, remainingCap);

  const formatStrategy = (s: Strategy) =>
    `- "${s.hypothesis}" (state: ${s.state}, effectiveness: ${s.effectiveness_score ?? "unknown"})`;

  let pastSummary: string;
  if (selectedRelevant.length === 0 && selectedOther.length === 0) {
    pastSummary = "None";
  } else {
    const parts: string[] = [];
    if (selectedRelevant.length > 0) {
      parts.push(
        `Relevant past strategies for this dimension:\n${selectedRelevant.map(formatStrategy).join("\n")}`
      );
    }
    if (selectedOther.length > 0) {
      parts.push(
        `Other strategies from this goal:\n${selectedOther.map(formatStrategy).join("\n")}`
      );
    }
    pastSummary = parts.join("\n\n");
  }

  const enrichmentSection = [
    enrichment?.workspaceBlock ?? "",
    enrichment?.templatesBlock ?? "",
    enrichment?.lessonsBlock ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return `Generate 1-2 strategic approaches to close the gap for goal "${goalId}".

Primary dimension to improve: ${primaryDimension}
All target dimensions: ${targetDimensions.join(", ")}
Current gap score: ${context.currentGap} (0=closed, 1=fully open)

Past strategies tried:
${pastSummary}
${enrichmentSection ? `\n${enrichmentSection}\n` : ""}
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
  "allocation": number (0-1),
  "required_tools": ["tool-name-1", "tool-name-2"]  // list tool names this strategy needs (empty array if none)
}

Do not repeat strategies that have already been tried. Respond with only the JSON array inside a markdown code block.`;
}

// ─── Allocation redistribution helper ───

/**
 * Redistribute freed allocation proportionally among remaining strategies.
 * Returns a new array with updated allocations. Pure function.
 */
export function redistributeAllocation(
  strategies: Strategy[],
  excludeId: string,
  freedAllocation: number
): Strategy[] {
  const remaining = strategies.filter(
    (s) => s.id !== excludeId && (s.state === "active" || s.state === "evaluating")
  );

  if (remaining.length === 0 || freedAllocation <= 0) {
    return strategies;
  }

  const totalRemainingAlloc = remaining.reduce((sum, s) => sum + s.allocation, 0);
  return strategies.map((s) => {
    if (!remaining.some((r) => r.id === s.id)) return s;
    const share =
      totalRemainingAlloc > 0
        ? s.allocation / totalRemainingAlloc
        : 1.0 / remaining.length;
    return parseStrategy({
      ...s,
      allocation: s.allocation + freedAllocation * share,
    });
  });
}

// ─── Knowledge gap detection (pure function) ───

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
export function detectStrategyGap(candidates: Strategy[]): KnowledgeGapSignal | null {
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
