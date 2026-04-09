import { z } from "zod";

export const HeartbeatCheckTypeSchema = z.enum(["http", "tcp", "process", "disk", "custom"]);

export const HeartbeatConfigSchema = z.object({
  check_type: HeartbeatCheckTypeSchema,
  check_config: z.record(z.unknown()),
  failure_threshold: z.number().int().min(1).default(3),
  timeout_ms: z.number().int().min(100).default(5000),
});

export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;

export const ProbeConfigSchema = z.object({
  data_source_id: z.string(),
  probe_dimension: z.string().optional(),
  query_params: z.record(z.unknown()).default({}),
  change_detector: z.object({
    mode: z.enum(["threshold", "diff", "presence"]),
    threshold_value: z.number().optional(),
    baseline_window: z.number().default(5),
  }),
  llm_on_change: z.boolean().default(true),
  llm_prompt_template: z.string().optional(),
});

export type ProbeConfig = z.infer<typeof ProbeConfigSchema>;

export const ReflectionJobKindSchema = z.enum([
  "morning_planning",
  "evening_catchup",
  "weekly_review",
  "dream_consolidation",
]);

export type ReflectionJobKind = z.infer<typeof ReflectionJobKindSchema>;

export const CronConfigSchema = z.object({
  job_kind: z.enum(["prompt", "reflection"]).default("prompt"),
  reflection_kind: ReflectionJobKindSchema.optional(),
  prompt_template: z.string(),
  context_sources: z.array(z.string()).default([]),
  output_format: z.enum(['notification', 'report', 'both']).default('notification'),
  report_type: z.string().optional(),
  max_tokens: z.number().default(4000),
}).superRefine((value, ctx) => {
  if (value.job_kind === "reflection" && !value.reflection_kind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reflection_kind"],
      message: "reflection_kind is required when job_kind is reflection",
    });
  }
});

export type CronConfig = z.infer<typeof CronConfigSchema>;

export const GoalTriggerConfigSchema = z.object({
  goal_id: z.string(),
  max_iterations: z.number().default(10),
  skip_if_active: z.boolean().default(true),
});

export type GoalTriggerConfig = z.infer<typeof GoalTriggerConfigSchema>;

export const ScheduleEntryMetadataSchema = z.object({
  source: z.enum(["manual", "preset", "dream"]).default("manual"),
  preset_key: z.string().optional(),
  dream_suggestion_id: z.string().optional(),
  dependency_hints: z.array(z.string()).default([]),
  note: z.string().optional(),
});

export type ScheduleEntryMetadata = z.infer<typeof ScheduleEntryMetadataSchema>;

export const EscalationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  target_layer: z.enum(["probe", "cron", "goal_trigger"]).optional(),
  target_entry_id: z.string().optional(),
  cooldown_minutes: z.number().default(15),
  max_per_hour: z.number().default(4),
  circuit_breaker_threshold: z.number().default(10),
});

export type EscalationConfig = z.infer<typeof EscalationConfigSchema>;

export const ScheduleLayerSchema = z.enum(["heartbeat", "probe", "cron", "goal_trigger"]);

export const ScheduleTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cron"), expression: z.string(), timezone: z.string().default("UTC") }),
  z.object({ type: z.literal("interval"), seconds: z.number().int().min(1), jitter_factor: z.number().min(0).max(1).default(0) }),
]);
export type ScheduleTriggerInput = z.input<typeof ScheduleTriggerSchema>;

export const ScheduleEntrySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  layer: ScheduleLayerSchema,
  trigger: ScheduleTriggerSchema,
  enabled: z.boolean().default(true),
  metadata: ScheduleEntryMetadataSchema.optional(),
  heartbeat: HeartbeatConfigSchema.optional(),
  probe: ProbeConfigSchema.optional(),
  escalation: EscalationConfigSchema.optional(),
  baseline_results: z.array(z.unknown()).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_fired_at: z.string().datetime().nullable().default(null),
  next_fire_at: z.string().datetime(),
  consecutive_failures: z.number().int().default(0),
  last_escalation_at: z.string().datetime().nullable().default(null),
  escalation_timestamps: z.array(z.string().datetime()).default([]),
  total_executions: z.number().int().default(0),
  total_tokens_used: z.number().int().default(0),
  max_tokens_per_day: z.number().default(100000),
  tokens_used_today: z.number().default(0),
  budget_reset_at: z.string().datetime().nullable().default(null),
  cron: CronConfigSchema.optional(),
  goal_trigger: GoalTriggerConfigSchema.optional(),
});

export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;
export type ScheduleEntryInput = z.input<typeof ScheduleEntrySchema>;

export const ScheduleEntryListSchema = z.array(ScheduleEntrySchema);

export const ScheduleResultSchema = z.object({
  entry_id: z.string().uuid(),
  status: z.enum(["ok", "degraded", "down", "skipped", "error", "escalated"]),
  duration_ms: z.number(),
  error_message: z.string().optional(),
  fired_at: z.string().datetime(),
  layer: z.enum(["heartbeat", "probe", "cron", "goal_trigger"]).optional(),
  tokens_used: z.number().default(0),
  escalated_to: z.string().nullable().default(null),
  output_summary: z.string().optional(),
  change_detected: z.boolean().optional(),
});

export type ScheduleResult = z.infer<typeof ScheduleResultSchema>;
