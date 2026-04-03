import { z } from "zod";

// --- Session Type ---

export const SessionTypeEnum = z.enum([
  "task_execution",
  "observation",
  "task_review",
  "goal_review",
  "chat_execution",
]);
export type SessionType = z.infer<typeof SessionTypeEnum>;

// --- Context Slot (a piece of context passed to a session) ---

export const ContextSlotSchema = z.object({
  priority: z.number().min(1).max(6),
  label: z.string(),
  content: z.string(),
  token_estimate: z.number().default(0),
});
export type ContextSlot = z.infer<typeof ContextSlotSchema>;

// --- Session ---

// --- Context Budget Config ---

export const ContextBudgetConfigSchema = z.object({
  task_execution: z.number().default(50_000),
  observation: z.number().default(50_000),
  task_review: z.number().default(30_000),
  goal_review: z.number().default(40_000),
});
export type ContextBudgetConfig = z.infer<typeof ContextBudgetConfigSchema>;

// --- Session ---

export const SessionSchema = z.object({
  id: z.string(),
  session_type: SessionTypeEnum,
  goal_id: z.string(),
  task_id: z.string().nullable().default(null),
  context_slots: z.array(ContextSlotSchema),
  context_budget: z.number(),
  started_at: z.string(),
  ended_at: z.string().nullable().default(null),
  result_summary: z.string().nullable().default(null),
});
export type Session = z.infer<typeof SessionSchema>;
