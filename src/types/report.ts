import { z } from "zod";
import { ReportTypeEnum, VerbosityLevelEnum } from "./core.js";

// --- Report ---

export const ReportSchema = z.object({
  id: z.string(),
  report_type: ReportTypeEnum,
  goal_id: z.string().nullable().default(null),
  title: z.string(),
  content: z.string(),
  verbosity: VerbosityLevelEnum.default("standard"),
  generated_at: z.string(),
  delivered_at: z.string().nullable().default(null),
  read: z.boolean().default(false),
  // Structured data stored at generation time to avoid re-parsing Markdown later
  metadata: z
    .object({
      loop_index: z.number().optional(),
      gap_aggregate: z.number().optional(),
      stall_detected: z.boolean().optional(),
      pivot_occurred: z.boolean().optional(),
      elapsed_ms: z.number().optional(),
      task_id: z.string().nullable().optional(),
      task_action: z.string().nullable().optional(),
      loops_run: z.number().optional(),
      stall_count: z.number().optional(),
      pivot_count: z.number().optional(),
      progress_change: z.string().optional(),
      total_loops: z.number().optional(),
      total_stalls: z.number().optional(),
      total_pivots: z.number().optional(),
    })
    .optional(),
});
export type Report = z.infer<typeof ReportSchema>;

// --- Reporting Schedule ---

export const ReportingScheduleSchema = z.object({
  daily_summary: z.object({
    enabled: z.boolean().default(true),
    time: z.string().default("09:00"),
    timezone: z.string().default("UTC"),
    skip_if_no_activity: z.boolean().default(true),
    channels: z.array(z.string()).default([]),
  }),
  weekly_report: z.object({
    enabled: z.boolean().default(true),
    day: z.string().default("monday"),
    time: z.string().default("09:00"),
    timezone: z.string().default("UTC"),
    skip_if_no_activity: z.boolean().default(false),
    channels: z.array(z.string()).default([]),
  }),
});
export type ReportingSchedule = z.infer<typeof ReportingScheduleSchema>;

// --- DeliveryRecord ---

export const DeliveryRecordSchema = z.object({
  channel_type: z.string(),
  delivered_at: z.string().datetime().optional(),
  success: z.boolean(),
  error: z.string().optional(),
});
export type DeliveryRecord = z.infer<typeof DeliveryRecordSchema>;
