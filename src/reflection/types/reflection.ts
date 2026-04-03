import { z } from "zod";

// --- ReflectionNote ---

export const ReflectionNoteSchema = z.object({
  reflection_id: z.string(),
  goal_id: z.string(),
  strategy_id: z.string().nullable().default(null),
  task_id: z.string(),
  what_was_attempted: z.string(),
  outcome: z.enum(["success", "partial", "fail"]),
  why_it_worked_or_failed: z.string(),
  what_to_do_differently: z.string(),
  created_at: z.string(),
});

export type ReflectionNote = z.infer<typeof ReflectionNoteSchema>;
