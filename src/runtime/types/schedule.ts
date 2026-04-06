import { z } from "zod";

// --- Schedule Expression ---

const CronExpressionSchema = z.object({
  type: z.literal("cron"),
  expression: z.string(), // standard cron: "0 9 * * 1" (Monday 9am)
  timezone: z.string().default("UTC"),
});

const IntervalExpressionSchema = z.object({
  type: z.literal("interval"),
  seconds: z.number().int().positive(),
  jitter_factor: z.number().min(0).max(0.5).default(0.05), // +/-5% randomization
});

export const ScheduleExpressionSchema = z.discriminatedUnion("type", [
  CronExpressionSchema,
  IntervalExpressionSchema,
]);

export type ScheduleExpression = z.infer<typeof ScheduleExpressionSchema>;

// --- Layer Configs (All 4 for forward compatibility) ---

const GoalTriggerConfigSchema = z.object({
  layer: z.literal("goal_trigger"),
  goal_id: z.string(),
  max_iterations: z.number().int().positive().default(10),
  skip_if_active: z.boolean().default(true),
});

const ProbeConfigSchema = z.object({
  layer: z.literal("probe"),
  data_source_id: z.string(),
  query_params: z.record(z.unknown()).default({}),
  change_detection: z.object({
    mode: z.enum(["threshold", "diff", "presence"]),
    threshold: z.number().optional(),
    baseline_window: z.number().int().positive().default(5),
  }),
  escalate_to: z
    .object({
      type: z.literal("goal_trigger"),
      goal_id: z.string(),
    })
    .optional(),
  notification_on_change: z.boolean().default(true),
});

const CronLayerConfigSchema = z.object({
  layer: z.literal("cron"),
  prompt_template: z.string(),
  context_sources: z.array(z.string()).default([]),
  output_format: z
    .enum(["notification", "report", "both"])
    .default("notification"),
  report_type: z.string().optional(),
});

const HeartbeatConfigSchema = z.object({
  layer: z.literal("heartbeat"),
  check_type: z.enum(["http", "tcp", "process", "disk", "custom"]),
  check_config: z.record(z.unknown()).default({}),
  failure_threshold: z.number().int().positive().default(3),
  escalate_to: z
    .object({
      type: z.enum(["probe", "goal_trigger"]),
      schedule_entry_id: z.string().optional(),
      goal_id: z.string().optional(),
    })
    .optional(),
});

export const LayerConfigSchema = z.discriminatedUnion("layer", [
  GoalTriggerConfigSchema,
  ProbeConfigSchema,
  CronLayerConfigSchema,
  HeartbeatConfigSchema,
]);

export type LayerConfig = z.infer<typeof LayerConfigSchema>;
export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;

// --- ScheduleEntry ---

export const ScheduleEntrySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),

  // When to fire
  schedule: ScheduleExpressionSchema,

  // What to do (layer determines processing weight)
  config: LayerConfigSchema,

  // Runtime state
  last_fired_at: z.string().datetime().nullable().default(null),
  next_fire_at: z.string().datetime().nullable().default(null),
  consecutive_failures: z.number().int().default(0),
  total_executions: z.number().int().default(0),
  total_tokens_used: z.number().int().default(0),

  // Metadata
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  tags: z.array(z.string()).default([]),
});

export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;

export const ScheduleEntryListSchema = z.array(ScheduleEntrySchema);

// --- ScheduleResult (execution record) ---

export const ScheduleResultSchema = z.object({
  entry_id: z.string().uuid(),
  fired_at: z.string().datetime(),
  layer: z.enum(["goal_trigger", "probe", "cron", "heartbeat"]),
  status: z.enum(["success", "failure", "escalated", "skipped"]),
  tokens_used: z.number().int().default(0),
  duration_ms: z.number().int(),
  escalated_to: z.string().uuid().optional(), // entry_id or goal_id of escalation target
  error_message: z.string().optional(),
  output_summary: z.string().optional(), // one-line summary of result
});

export type ScheduleResult = z.infer<typeof ScheduleResultSchema>;
