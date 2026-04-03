import { randomUUID } from "node:crypto";
import {
  CrossGoalPatternSchema,
  StructuralFeedbackSchema,
} from "../../types/learning.js";
import type {
  StructuralFeedback,
  StructuralFeedbackType,
  CrossGoalPattern,
  PatternSharingResult,
  LearningPipelineConfig,
} from "../../types/learning.js";
import type { StateManager } from "../../state/state-manager.js";
import {
  getStructuralFeedback,
  recordStructuralFeedback,
} from "./learning-feedback.js";

// ─── Deps ───

export interface CrossGoalDeps {
  stateManager: StateManager;
  config: LearningPipelineConfig;
}

// ─── Private helper ───

function buildSuggestedAction(
  feedbackType: StructuralFeedbackType,
  avgDelta: number
): string {
  switch (feedbackType) {
    case "observation_accuracy":
      return avgDelta < 0
        ? "Improve observation accuracy by cross-checking with data sources"
        : "Maintain current observation approach";
    case "strategy_selection":
      return avgDelta < 0
        ? "Switch to incremental strategy to reduce risk"
        : "Continue current strategy selection";
    case "scope_sizing":
      return avgDelta < 0
        ? "Reduce task scope to smaller units"
        : "Increase task scope for efficiency";
    case "task_generation":
      return avgDelta < 0
        ? "Refine task generation templates"
        : "Reinforce current task generation approach";
  }
}

// ─── extractCrossGoalPatterns ───

/**
 * Extract cross-goal patterns by analyzing structural feedback across multiple goals.
 * A pattern is identified when the same feedbackType appears with similar delta values
 * (within ±0.2) across 2 or more goals.
 */
export async function extractCrossGoalPatterns(
  deps: CrossGoalDeps,
  goalIds: string[]
): Promise<CrossGoalPattern[]> {
  if (goalIds.length < 2) {
    return [];
  }

  // Collect all structural feedback grouped by feedbackType
  const byType = new Map<
    StructuralFeedbackType,
    Array<{ goalId: string; feedback: StructuralFeedback }>
  >();

  for (const goalId of goalIds) {
    const feedbacks = await getStructuralFeedback(deps, goalId);
    for (const fb of feedbacks) {
      const existing = byType.get(fb.feedbackType) ?? [];
      existing.push({ goalId, feedback: fb });
      byType.set(fb.feedbackType, existing);
    }
  }

  const patterns: CrossGoalPattern[] = [];
  const now = new Date().toISOString();

  for (const [feedbackType, entries] of byType) {
    if (entries.length < 2) continue;

    // Group entries by similar delta values (within ±0.2)
    const clustered: Array<{
      representative: number;
      members: Array<{ goalId: string; feedback: StructuralFeedback }>;
    }> = [];

    for (const entry of entries) {
      const delta = entry.feedback.delta;
      let placed = false;
      for (const cluster of clustered) {
        if (Math.abs(cluster.representative - delta) <= 0.2) {
          cluster.members.push(entry);
          // Update representative as mean
          cluster.representative =
            cluster.members.reduce(
              (sum, m) => sum + m.feedback.delta,
              0
            ) / cluster.members.length;
          placed = true;
          break;
        }
      }
      if (!placed) {
        clustered.push({ representative: delta, members: [entry] });
      }
    }

    // Only keep clusters where 2+ distinct goals are represented
    for (const cluster of clustered) {
      const goalSet = new Set(cluster.members.map((m) => m.goalId));
      if (goalSet.size < 2) continue;

      const avgDelta = cluster.representative;
      const patternType: CrossGoalPattern["patternType"] =
        avgDelta < -0.05
          ? "success"
          : avgDelta > 0.05
            ? "failure"
            : "optimization";

      const sourceGoalIds = Array.from(goalSet);
      const occurrenceCount = cluster.members.length;
      const confidence = goalSet.size / goalIds.length;

      const suggestedAction = buildSuggestedAction(feedbackType, avgDelta);

      // Build applicable conditions from context keys
      const conditionSet = new Set<string>();
      for (const m of cluster.members) {
        for (const key of Object.keys(m.feedback.context)) {
          conditionSet.add(key);
        }
      }
      const applicableConditions = Array.from(conditionSet);

      const description = `${feedbackType} pattern: avg delta=${avgDelta.toFixed(2)} observed across ${sourceGoalIds.length} goals`;

      const pattern = CrossGoalPatternSchema.parse({
        id: `cgp_${randomUUID()}`,
        patternType,
        description,
        sourceGoalIds,
        feedbackType,
        confidence,
        applicableConditions,
        suggestedAction,
        occurrenceCount,
        lastObserved: now,
      });

      patterns.push(pattern);
    }
  }

  return patterns;
}

// ─── sharePatternsAcrossGoals ───

/**
 * Apply cross-goal patterns to target goals as feedback insights.
 * For each target goal, patterns whose applicableConditions match the goal's
 * feedback context keys are applied.
 */
export async function sharePatternsAcrossGoals(
  deps: CrossGoalDeps,
  patterns: CrossGoalPattern[],
  targetGoalIds: string[]
): Promise<PatternSharingResult> {
  let patternsShared = 0;
  const newPatterns: CrossGoalPattern[] = [];
  const affectedGoals = new Set<string>();

  for (const targetGoalId of targetGoalIds) {
    // Gather context keys from existing structural feedback
    const existingFeedback = await getStructuralFeedback(deps, targetGoalId);
    const existingContextKeys = new Set<string>();
    for (const fb of existingFeedback) {
      for (const key of Object.keys(fb.context)) {
        existingContextKeys.add(key);
      }
    }

    for (const pattern of patterns) {
      // Skip if target goal is already a source
      if (pattern.sourceGoalIds.includes(targetGoalId)) {
        continue;
      }

      // Check if applicableConditions match: either no conditions (universal)
      // or at least one condition key exists in the target's context
      const conditionsMatch =
        pattern.applicableConditions.length === 0 ||
        pattern.applicableConditions.some((c) => existingContextKeys.has(c));

      if (!conditionsMatch) {
        continue;
      }

      // Generate a synthetic StructuralFeedback entry to represent this shared pattern
      const syntheticFeedback: StructuralFeedback = StructuralFeedbackSchema.parse({
        id: `sf_shared_${randomUUID()}`,
        goalId: targetGoalId,
        iterationId: `shared_from_cross_goal_pattern_${pattern.id}`,
        feedbackType: pattern.feedbackType,
        expected: pattern.suggestedAction,
        actual: pattern.description,
        delta:
          pattern.patternType === "success"
            ? -0.1
            : pattern.patternType === "failure"
              ? 0.1
              : 0,
        timestamp: new Date().toISOString(),
        context: {
          cross_goal_pattern_id: pattern.id,
          source_goal_count: pattern.sourceGoalIds.length,
        },
      });

      await recordStructuralFeedback(deps, syntheticFeedback);

      patternsShared++;
      affectedGoals.add(targetGoalId);
      newPatterns.push(pattern);
    }
  }

  return {
    patternsExtracted: patterns.length,
    patternsShared,
    targetGoalIds: Array.from(affectedGoals),
    newPatterns,
  };
}
