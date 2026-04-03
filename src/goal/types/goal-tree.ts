import { z } from "zod";
import { SatisficingAggregationEnum } from "./goal.js";

// --- Goal Decomposition Config ---

export const GoalDecompositionConfigSchema = z.object({
  max_depth: z.number().int().min(1).max(10).default(5),
  min_specificity: z.number().min(0).max(1).default(0.7),
  auto_prune_threshold: z.number().min(0).max(1).default(0.3),
  parallel_loop_limit: z.number().int().min(1).max(10).default(3),
});
export type GoalDecompositionConfig = z.infer<typeof GoalDecompositionConfigSchema>;

// --- Decomposition Result ---

export const DecompositionResultSchema = z.object({
  parent_id: z.string(),
  children: z.array(z.any()),
  depth: z.number().int().min(0),
  specificity_scores: z.record(z.string(), z.number()),
  reasoning: z.string(),
});
export type DecompositionResult = z.infer<typeof DecompositionResultSchema>;

// --- Goal Tree State ---

export const GoalTreeStateSchema = z.object({
  root_id: z.string(),
  total_nodes: z.number().int().min(0),
  max_depth_reached: z.number().int().min(0),
  active_loops: z.array(z.string()),
  pruned_nodes: z.array(z.string()),
});
export type GoalTreeState = z.infer<typeof GoalTreeStateSchema>;

// --- Prune Reason ---

export const PruneReasonEnum = z.enum([
  "no_progress",
  "superseded",
  "merged",
  "user_requested",
]);
export type PruneReason = z.infer<typeof PruneReasonEnum>;

// --- Prune Decision ---

export const PruneDecisionSchema = z.object({
  goal_id: z.string(),
  reason: PruneReasonEnum,
  replacement_id: z.string().nullable().default(null),
});
export type PruneDecision = z.infer<typeof PruneDecisionSchema>;

// --- Aggregation Direction ---

export const AggregationDirectionEnum = z.enum(["up", "down", "both"]);
export type AggregationDirection = z.infer<typeof AggregationDirectionEnum>;

// --- State Aggregation Rule ---

export const StateAggregationRuleSchema = z.object({
  parent_id: z.string(),
  child_ids: z.array(z.string()),
  aggregation: SatisficingAggregationEnum,
  propagation_direction: AggregationDirectionEnum,
});
export type StateAggregationRule = z.infer<typeof StateAggregationRuleSchema>;

// --- Concreteness Score ---

export const ConcretenessDimensionsSchema = z.object({
  hasQuantitativeThreshold: z.boolean(),
  hasObservableOutcome: z.boolean(),
  hasTimebound: z.boolean(),
  hasClearScope: z.boolean(),
});

export const ConcretenessScoreSchema = z.object({
  score: z.number().min(0).max(1),
  dimensions: ConcretenessDimensionsSchema,
  reason: z.string(),
});
export type ConcretenessScore = z.infer<typeof ConcretenessScoreSchema>;

// --- Decomposition Quality Metrics ---

export const DecompositionQualityMetricsSchema = z.object({
  coverage: z.number().min(0).max(1),
  overlap: z.number().min(0).max(1),
  actionability: z.number().min(0).max(1),
  depthEfficiency: z.number().min(0).max(1),
});
export type DecompositionQualityMetrics = z.infer<typeof DecompositionQualityMetricsSchema>;

// --- Prune Record ---

export const PruneRecordSchema = z.object({
  subgoalId: z.string(),
  reason: z.string(),
  timestamp: z.string(),
});
export type PruneRecord = z.infer<typeof PruneRecordSchema>;
