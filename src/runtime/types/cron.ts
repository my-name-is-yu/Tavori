import { z } from "zod";

export const CronTaskSchema = z.object({
  id: z.string().uuid(),
  cron: z.string(),
  prompt: z.string(),
  type: z.enum(["reflection", "consolidation", "custom"]),
  enabled: z.boolean().default(true),
  last_fired_at: z.string().datetime().nullable(),
  permanent: z.boolean(),
  created_at: z.string().datetime(),
});

export type CronTask = z.infer<typeof CronTaskSchema>;

export const CronTaskListSchema = z.array(CronTaskSchema);
