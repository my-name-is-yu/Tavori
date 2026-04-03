import { z } from "zod";

// ─── HookEventType ───

export const HookEventTypeSchema = z.enum([
  "PreObserve",
  "PostObserve",
  "PreTaskCreate",
  "PostTaskCreate",
  "PreExecute",
  "PostExecute",
  "GoalStateChange",
  "LoopCycleStart",
  "LoopCycleEnd",
  "ReflectionComplete",
]);

export type HookEventType = z.infer<typeof HookEventTypeSchema>;

// ─── HookConfig ───

export const HookConfigSchema = z.object({
  event: HookEventTypeSchema,
  type: z.enum(["shell", "webhook"]),
  command: z.string().optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().default(5000),
  enabled: z.boolean().default(true),
  filter: z
    .object({
      goal_id: z.string().optional(),
      dimension: z.string().optional(),
    })
    .optional(),
});

export type HookConfig = z.infer<typeof HookConfigSchema>;

// ─── HooksConfig ───

export const HooksConfigSchema = z.object({
  hooks: z.array(HookConfigSchema).default([]),
});

export type HooksConfig = z.infer<typeof HooksConfigSchema>;

// ─── HookPayload ───

export const HookPayloadSchema = z.object({
  event: HookEventTypeSchema,
  timestamp: z.string(),
  goal_id: z.string().optional(),
  dimension: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type HookPayload = z.infer<typeof HookPayloadSchema>;
