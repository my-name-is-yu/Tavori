import { z } from "zod";
import {
  ScheduleTriggerSchema,
  type ScheduleEntryInput,
  type ScheduleTriggerInput,
} from "./types/schedule.js";

type CreateScheduleEntryInput = Omit<
  ScheduleEntryInput,
  | "id"
  | "created_at"
  | "updated_at"
  | "last_fired_at"
  | "next_fire_at"
  | "consecutive_failures"
  | "last_escalation_at"
  | "baseline_results"
  | "total_executions"
  | "total_tokens_used"
  | "max_tokens_per_day"
  | "tokens_used_today"
  | "budget_reset_at"
  | "escalation_timestamps"
>;

const RecordSchema = z.record(z.string(), z.unknown());

const SchedulePresetBaseSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  trigger: ScheduleTriggerSchema.optional(),
});

export const DailyBriefPresetInputSchema = SchedulePresetBaseSchema.extend({
  preset: z.literal("daily_brief"),
  context_sources: z.array(z.string()).default([]),
});

export const WeeklyReviewPresetInputSchema = SchedulePresetBaseSchema.extend({
  preset: z.literal("weekly_review"),
  context_sources: z.array(z.string()).default([]),
});

export const DreamConsolidationPresetInputSchema = SchedulePresetBaseSchema.extend({
  preset: z.literal("dream_consolidation"),
  context_sources: z.array(z.string()).default([]),
});

export const GoalProbePresetInputSchema = SchedulePresetBaseSchema.extend({
  preset: z.literal("goal_probe"),
  data_source_id: z.string().min(1),
  probe_dimension: z.string().optional(),
  query_params: RecordSchema.default({}),
  detector_mode: z.enum(["threshold", "diff", "presence"]).default("diff"),
  threshold_value: z.number().optional(),
  baseline_window: z.number().int().min(1).default(5),
  llm_on_change: z.boolean().default(true),
  llm_prompt_template: z.string().optional(),
});

export const SchedulePresetInputSchema = z.discriminatedUnion("preset", [
  DailyBriefPresetInputSchema,
  WeeklyReviewPresetInputSchema,
  DreamConsolidationPresetInputSchema,
  GoalProbePresetInputSchema,
]);

export type SchedulePresetInput = z.input<typeof SchedulePresetInputSchema>;
type ParsedSchedulePresetInput = z.infer<typeof SchedulePresetInputSchema>;
export type SchedulePresetKey = SchedulePresetInput["preset"];

export interface SchedulePresetDefinition {
  key: SchedulePresetKey;
  title: string;
  description: string;
  defaultTrigger: ScheduleTriggerInput;
  dependencyHints: string[];
}

const PRESET_DEFINITIONS: Record<SchedulePresetKey, SchedulePresetDefinition> = {
  daily_brief: {
    key: "daily_brief",
    title: "Daily brief",
    description: "Runs the morning planning reflection and delivers a concise daily briefing.",
    defaultTrigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    dependencyHints: ["llm_client", "notification_dispatcher"],
  },
  weekly_review: {
    key: "weekly_review",
    title: "Weekly review",
    description: "Runs the weekly reflection review and emits a report plus notification.",
    defaultTrigger: { type: "cron", expression: "0 9 * * 1", timezone: "UTC" },
    dependencyHints: ["llm_client", "notification_dispatcher"],
  },
  dream_consolidation: {
    key: "dream_consolidation",
    title: "Dream consolidation",
    description: "Runs overnight consolidation for memory and stale knowledge cleanup.",
    defaultTrigger: { type: "cron", expression: "0 2 * * *", timezone: "UTC" },
    dependencyHints: ["memory_lifecycle", "knowledge_manager"],
  },
  goal_probe: {
    key: "goal_probe",
    title: "Goal probe",
    description: "Polls a data source and triggers change detection for goal-relevant signals.",
    defaultTrigger: { type: "interval", seconds: 3600, jitter_factor: 0 },
    dependencyHints: ["data_source_registry"],
  },
};

function cloneTrigger(trigger: ScheduleTriggerInput): ScheduleTriggerInput {
  return trigger.type === "cron"
    ? { type: "cron", expression: trigger.expression, timezone: trigger.timezone ?? "UTC" }
    : { type: "interval", seconds: trigger.seconds, jitter_factor: trigger.jitter_factor ?? 0 };
}

export function listSchedulePresetDefinitions(): SchedulePresetDefinition[] {
  return Object.values(PRESET_DEFINITIONS).map((definition) => ({
    ...definition,
    defaultTrigger: cloneTrigger(definition.defaultTrigger),
    dependencyHints: [...definition.dependencyHints],
  }));
}

export function getSchedulePresetDefinition(key: SchedulePresetKey): SchedulePresetDefinition {
  const definition = PRESET_DEFINITIONS[key];
  return {
    ...definition,
    defaultTrigger: cloneTrigger(definition.defaultTrigger),
    dependencyHints: [...definition.dependencyHints],
  };
}

function resolveTrigger(input: ParsedSchedulePresetInput): ScheduleTriggerInput {
  return input.trigger ? input.trigger : cloneTrigger(PRESET_DEFINITIONS[input.preset].defaultTrigger);
}

export function buildSchedulePresetEntry(input: SchedulePresetInput): CreateScheduleEntryInput {
  const parsed = SchedulePresetInputSchema.parse(input);
  const definition = PRESET_DEFINITIONS[parsed.preset];
  const base = {
    name: parsed.name ?? definition.title,
    enabled: parsed.enabled,
    trigger: resolveTrigger(parsed),
    metadata: {
      source: "preset" as const,
      preset_key: parsed.preset,
      dependency_hints: [...definition.dependencyHints],
    },
  };

  switch (parsed.preset) {
    case "daily_brief":
      return {
        ...base,
        layer: "cron",
        cron: {
          job_kind: "reflection",
          reflection_kind: "morning_planning",
          prompt_template: "Run the daily brief reflection workflow.",
          context_sources: parsed.context_sources,
          output_format: "notification",
          report_type: "daily_brief",
          max_tokens: 1200,
        },
      };
    case "weekly_review":
      return {
        ...base,
        layer: "cron",
        cron: {
          job_kind: "reflection",
          reflection_kind: "weekly_review",
          prompt_template: "Run the weekly review reflection workflow.",
          context_sources: parsed.context_sources,
          output_format: "both",
          report_type: "weekly_review",
          max_tokens: 2000,
        },
      };
    case "dream_consolidation":
      return {
        ...base,
        layer: "cron",
        cron: {
          job_kind: "reflection",
          reflection_kind: "dream_consolidation",
          prompt_template: "Run the dream consolidation workflow.",
          context_sources: parsed.context_sources,
          output_format: "report",
          report_type: "dream_consolidation",
          max_tokens: 1200,
        },
      };
    case "goal_probe":
      return {
        ...base,
        layer: "probe",
        probe: {
          data_source_id: parsed.data_source_id,
          probe_dimension: parsed.probe_dimension,
          query_params: parsed.query_params,
          change_detector: {
            mode: parsed.detector_mode,
            threshold_value: parsed.threshold_value,
            baseline_window: parsed.baseline_window,
          },
          llm_on_change: parsed.llm_on_change,
          llm_prompt_template: parsed.llm_prompt_template,
        },
      };
  }
}
