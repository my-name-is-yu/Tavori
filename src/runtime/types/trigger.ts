import { z } from "zod";

// --- Trigger Event ---

export const TriggerEventSchema = z.object({
  source: z.enum(["github", "slack", "ci", "cron", "custom"]),
  event_type: z.string(), // e.g. "push", "issue_opened", "build_failed"
  data: z.record(z.string(), z.unknown()).default({}),
  goal_id: z.string().optional(), // target specific goal
});
export type TriggerEvent = z.infer<typeof TriggerEventSchema>;

// --- Trigger Mapping ---

export const TriggerMappingSchema = z.object({
  source: z.string(),
  event_type: z.string(),
  action: z.enum(["observe", "create_task", "notify", "wake"]),
  goal_id: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type TriggerMapping = z.infer<typeof TriggerMappingSchema>;

// --- Trigger Mappings Config ---

export const TriggerMappingsConfigSchema = z.object({
  mappings: z.array(TriggerMappingSchema).default([]),
});
export type TriggerMappingsConfig = z.infer<typeof TriggerMappingsConfigSchema>;
