import { z } from "zod";
import { StrategyStateEnum, DurationSchema } from "./core.js";

// --- Expected Effect ---

export const ExpectedEffectSchema = z.object({
  dimension: z.string(),
  direction: z.enum(["increase", "decrease"]),
  magnitude: z.enum(["small", "medium", "large"]),
});
export type ExpectedEffect = z.infer<typeof ExpectedEffectSchema>;

// --- Resource Estimate ---

export const ResourceEstimateSchema = z.object({
  sessions: z.number(),
  duration: DurationSchema,
  llm_calls: z.number().nullable().default(null),
});
export type ResourceEstimate = z.infer<typeof ResourceEstimateSchema>;

// --- Strategy ---

export const StrategySchema = z.object({
  id: z.string(),
  goal_id: z.string(),
  target_dimensions: z.array(z.string()),
  primary_dimension: z.string(),

  hypothesis: z.string(),
  expected_effect: z.array(ExpectedEffectSchema),
  resource_estimate: ResourceEstimateSchema,

  state: StrategyStateEnum.default("candidate"),
  allocation: z.number().min(0).max(1).default(0),

  created_at: z.string(),
  started_at: z.string().nullable().default(null),
  completed_at: z.string().nullable().default(null),

  gap_snapshot_at_start: z.number().nullable().default(null),
  tasks_generated: z.array(z.string()).default([]),
  effectiveness_score: z.number().nullable().default(null),
  consecutive_stall_count: z.number().default(0),

  // Stage 14: Cross-goal strategy fields
  source_template_id: z.string().nullable().default(null),
  cross_goal_context: z.string().nullable().default(null),

  // M14-S2: Structured PIVOT/REFINE/ESCALATE fields
  rollback_target_id: z.string().nullable().default(null),
  max_pivot_count: z.number().int().min(0).default(2),
  pivot_count: z.number().int().min(0).default(0),

  // Toolset immutability: snapshot tools at strategy activation
  toolset_locked: z.boolean().default(false),
  allowed_tools: z.array(z.string()).default([]),
});
export type Strategy = z.infer<typeof StrategySchema>;

// --- WaitStrategy ---

export const WaitStrategySchema = StrategySchema.extend({
  wait_reason: z.string(),
  wait_until: z.string(),
  measurement_plan: z.string(),
  fallback_strategy_id: z.string().nullable(),
});
export type WaitStrategy = z.infer<typeof WaitStrategySchema>;

// --- Portfolio ---

export const PortfolioSchema = z.object({
  goal_id: z.string(),
  strategies: z.array(StrategySchema),
  rebalance_interval: DurationSchema,
  last_rebalanced_at: z.string(),
});
export type Portfolio = z.infer<typeof PortfolioSchema>;
