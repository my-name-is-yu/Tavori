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

