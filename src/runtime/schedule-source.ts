import { z } from "zod";

// External schedule entry from a plugin source (e.g., Google Calendar, Jira)
export const ExternalScheduleEntrySchema = z.object({
  external_id: z.string(),           // ID in the external system
  source_id: z.string(),             // which IScheduleSource provided this
  name: z.string(),
  layer: z.enum(['heartbeat', 'probe', 'cron', 'goal_trigger']),
  trigger: z.object({
    type: z.enum(['cron', 'interval']),
    expression: z.string().optional(),  // for cron type
    seconds: z.number().optional(),     // for interval type
  }).refine(
    (t) => (t.type === 'cron' ? !!t.expression : !!t.seconds),
    { message: 'cron trigger requires expression, interval trigger requires seconds' }
  ),
  metadata: z.record(z.unknown()).default({}), // source-specific data
  synced_at: z.string().datetime(),
});
export type ExternalScheduleEntry = z.infer<typeof ExternalScheduleEntrySchema>;

// Interface that schedule source plugins must implement
export interface IScheduleSource {
  readonly id: string;
  readonly name: string;

  // Fetch all schedule entries from the external source
  fetchEntries(): Promise<ExternalScheduleEntry[]>;

  // Check if the source is healthy/reachable
  healthCheck(): Promise<{ healthy: boolean; error?: string }>;
}
