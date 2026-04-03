import { z } from "zod";

// --- EffectivenessRecord ---

export const EffectivenessRecordSchema = z.object({
  strategy_id: z.string(),
  gap_delta_attributed: z.number(),
  sessions_consumed: z.number(),
  effectiveness_score: z.number().nullable(),
  last_calculated_at: z.string(),
});
export type EffectivenessRecord = z.infer<typeof EffectivenessRecordSchema>;

// --- AllocationAdjustment ---

export const AllocationAdjustmentSchema = z.object({
  strategy_id: z.string(),
  old_allocation: z.number(),
  new_allocation: z.number(),
  reason: z.string(),
});
export type AllocationAdjustment = z.infer<typeof AllocationAdjustmentSchema>;

// --- RebalanceResult ---

export const RebalanceTriggerTypeEnum = z.enum([
  "periodic",
  "strategy_terminated",
  "stall_detected",
  "score_change",
]);
export type RebalanceTriggerType = z.infer<typeof RebalanceTriggerTypeEnum>;

export const RebalanceResultSchema = z.object({
  triggered_by: RebalanceTriggerTypeEnum,
  timestamp: z.string(),
  adjustments: z.array(AllocationAdjustmentSchema),
  terminated_strategies: z.array(z.string()),
  new_generation_needed: z.boolean(),
});
export type RebalanceResult = z.infer<typeof RebalanceResultSchema>;

// --- TaskSelectionResult ---

export const TaskSelectionResultSchema = z.object({
  strategy_id: z.string(),
  reason: z.string(),
  wait_ratio: z.number(),
});
export type TaskSelectionResult = z.infer<typeof TaskSelectionResultSchema>;

// --- PortfolioConfig ---

export const PortfolioConfigSchema = z.object({
  max_active_strategies: z.number().default(4),
  min_allocation: z.number().default(0.1),
  max_allocation: z.number().default(0.7),
  rebalance_interval_hours: z.number().default(168),
  effectiveness_min_tasks: z.number().default(3),
  score_ratio_threshold: z.number().default(2.0),
  termination_stall_count: z.number().default(3),
  termination_resource_multiplier: z.number().default(2.0),
  termination_min_rebalances: z.number().default(3),
});
export type PortfolioConfig = z.infer<typeof PortfolioConfigSchema>;

// --- RebalanceTrigger ---

export const RebalanceTriggerSchema = z.object({
  type: RebalanceTriggerTypeEnum,
  strategy_id: z.string().nullable(),
  details: z.string(),
});
export type RebalanceTrigger = z.infer<typeof RebalanceTriggerSchema>;
