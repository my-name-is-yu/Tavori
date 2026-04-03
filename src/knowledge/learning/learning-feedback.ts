import { randomUUID } from "node:crypto";
import {
  StructuralFeedbackSchema,
  StructuralFeedbackTypeEnum,
} from "../../types/learning.js";
import type {
  StructuralFeedback,
  StructuralFeedbackType,
  FeedbackAggregation,
  ParameterTuning,
} from "../../types/learning.js";
import type { StateManager } from "../../state/state-manager.js";
import type { LearningPipelineConfig } from "../../types/learning.js";

// ─── Deps ───

export interface FeedbackDeps {
  stateManager: StateManager;
  config: LearningPipelineConfig;
}

// ─── Persistence helpers ───

export async function getStructuralFeedback(
  deps: FeedbackDeps,
  goalId: string
): Promise<StructuralFeedback[]> {
  const raw = await deps.stateManager.readRaw(
    `learning/${goalId}_structural_feedback.json`
  );
  if (!raw || !Array.isArray(raw)) return [];
  try {
    return (raw as unknown[]).map((item) =>
      StructuralFeedbackSchema.parse(item)
    );
  } catch {
    return [];
  }
}

// ─── recordStructuralFeedback ───

/**
 * Record a structural feedback entry for a goal/iteration.
 * Validates with Zod and persists via StateManager.
 */
export async function recordStructuralFeedback(
  deps: FeedbackDeps,
  feedback: StructuralFeedback
): Promise<void> {
  const validated = StructuralFeedbackSchema.parse(feedback);
  const existing = await getStructuralFeedback(deps, validated.goalId);
  existing.push(validated);
  await deps.stateManager.writeRaw(
    `learning/${validated.goalId}_structural_feedback.json`,
    existing
  );
}

// ─── aggregateFeedback ───

/**
 * Aggregate structural feedback for a goal, optionally filtered by type.
 * Calculates averageDelta, recent trend (last 10 vs previous 10), and worst area.
 */
export async function aggregateFeedback(
  deps: FeedbackDeps,
  goalId: string,
  feedbackType?: StructuralFeedbackType
): Promise<FeedbackAggregation[]> {
  const all = await getStructuralFeedback(deps, goalId);
  const types: StructuralFeedbackType[] = feedbackType
    ? [feedbackType]
    : (StructuralFeedbackTypeEnum.options as StructuralFeedbackType[]);

  const results: FeedbackAggregation[] = [];

  for (const type of types) {
    const entries = all.filter((f) => f.feedbackType === type);
    if (entries.length === 0) continue;

    const totalCount = entries.length;
    const averageDelta =
      entries.reduce((sum, e) => sum + e.delta, 0) / totalCount;

    // Sort by timestamp for trend calculation
    const sorted = [...entries].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    // Compare last 10 vs previous 10
    const recent = sorted.slice(-10);
    const previous = sorted.slice(-20, -10);

    let recentTrend: FeedbackAggregation["recentTrend"] = "stable";
    if (previous.length > 0 && recent.length > 0) {
      const recentAvg =
        recent.reduce((sum, e) => sum + e.delta, 0) / recent.length;
      const prevAvg =
        previous.reduce((sum, e) => sum + e.delta, 0) / previous.length;
      const diff = recentAvg - prevAvg;
      if (diff > 0.05) {
        recentTrend = "improving";
      } else if (diff < -0.05) {
        recentTrend = "degrading";
      }
    }

    // Worst area: find the context key or dimension with lowest average delta
    const areaDeltas = new Map<string, number[]>();
    for (const entry of entries) {
      const areaKeys = Object.keys(entry.context);
      if (areaKeys.length > 0) {
        for (const key of areaKeys) {
          const existing = areaDeltas.get(key) ?? [];
          existing.push(entry.delta);
          areaDeltas.set(key, existing);
        }
      } else {
        const existing = areaDeltas.get(entry.iterationId) ?? [];
        existing.push(entry.delta);
        areaDeltas.set(entry.iterationId, existing);
      }
    }

    let worstArea = "unknown";
    let worstAvg = Infinity;
    for (const [area, deltas] of areaDeltas) {
      const avg = deltas.reduce((s, d) => s + d, 0) / deltas.length;
      if (avg < worstAvg) {
        worstAvg = avg;
        worstArea = area;
      }
    }

    results.push({
      feedbackType: type,
      totalCount,
      averageDelta,
      recentTrend,
      worstArea,
    });
  }

  return results;
}

// ─── autoTuneParameters ───

/**
 * Analyze feedback history and suggest parameter adjustments.
 * Only suggests when basedOnFeedbackCount >= 5 and confidence >= 0.6.
 */
export async function autoTuneParameters(
  deps: FeedbackDeps,
  goalId: string
): Promise<ParameterTuning[]> {
  const all = await getStructuralFeedback(deps, goalId);
  const suggestions: ParameterTuning[] = [];

  const typeGroups = new Map<StructuralFeedbackType, StructuralFeedback[]>();
  for (const entry of all) {
    const existing = typeGroups.get(entry.feedbackType) ?? [];
    existing.push(entry);
    typeGroups.set(entry.feedbackType, existing);
  }

  for (const [type, entries] of typeGroups) {
    if (entries.length < 5) continue;

    const avgDelta =
      entries.reduce((sum, e) => sum + e.delta, 0) / entries.length;

    // Confidence based on consistency: proportion with same sign as average
    const sameSign = entries.filter((e) =>
      avgDelta >= 0 ? e.delta >= 0 : e.delta < 0
    ).length;
    const confidence = sameSign / entries.length;

    if (confidence < 0.6) continue;

    switch (type) {
      case "observation_accuracy": {
        const currentValue = deps.config.min_confidence_threshold;
        const adjustment = avgDelta < 0 ? 0.05 : -0.05;
        const suggestedValue = Math.min(
          1,
          Math.max(0, currentValue + adjustment)
        );
        suggestions.push({
          parameterId: `param_confidence_threshold_${goalId}`,
          parameterName: "min_confidence_threshold",
          currentValue,
          suggestedValue,
          confidence,
          basedOnFeedbackCount: entries.length,
          feedbackType: type,
        });
        break;
      }
      case "strategy_selection": {
        const currentValue = 0.5;
        const suggestedValue = avgDelta < 0 ? 0.3 : 0.7;
        suggestions.push({
          parameterId: `param_strategy_weight_${goalId}`,
          parameterName: "strategy_exploitation_weight",
          currentValue,
          suggestedValue,
          confidence,
          basedOnFeedbackCount: entries.length,
          feedbackType: type,
        });
        break;
      }
      case "scope_sizing": {
        const currentValue = 1.0;
        const suggestedValue = avgDelta < 0 ? 0.7 : 1.2;
        suggestions.push({
          parameterId: `param_task_granularity_${goalId}`,
          parameterName: "task_granularity_multiplier",
          currentValue,
          suggestedValue,
          confidence,
          basedOnFeedbackCount: entries.length,
          feedbackType: type,
        });
        break;
      }
      case "task_generation": {
        const currentValue = 0.5;
        const suggestedValue = avgDelta < 0 ? 0.2 : 0.8;
        suggestions.push({
          parameterId: `param_template_reuse_${goalId}`,
          parameterName: "task_template_reuse_weight",
          currentValue,
          suggestedValue,
          confidence,
          basedOnFeedbackCount: entries.length,
          feedbackType: type,
        });
        break;
      }
    }
  }

  return suggestions;
}

// re-export randomUUID for use in learning-cross-goal
export { randomUUID };
