import { z } from "zod";
import { StallTypeEnum, StallCauseEnum } from "./core.js";

// --- StallAnalysis (M14-S2: cause analysis for PIVOT/REFINE/ESCALATE) ---

export const StallAnalysisSchema = z.object({
  cause: z.enum(["parameter_issue", "strategy_wrong", "goal_unreachable"]),
  confidence: z.number().min(0).max(1),
  evidence: z.string(),
  recommended_action: z.enum(["refine", "pivot", "escalate"]),
});
export type StallAnalysis = z.infer<typeof StallAnalysisSchema>;

// --- StallDetector types ---

export const StallReportSchema = z.object({
  stall_type: StallTypeEnum,
  goal_id: z.string(),
  dimension_name: z.string().nullable().default(null),
  task_id: z.string().nullable().default(null),
  detected_at: z.string(),
  escalation_level: z.number().min(0).max(3).default(0),
  suggested_cause: StallCauseEnum,
  decay_factor: z.number().min(0).max(1),
});
export type StallReport = z.infer<typeof StallReportSchema>;

export const StallStateSchema = z.object({
  goal_id: z.string(),
  dimension_escalation: z.record(z.string(), z.number()).default({}),
  global_escalation: z.number().default(0),
  decay_factors: z.record(z.string(), z.number()).default({}),
  recovery_loops: z.record(z.string(), z.number()).default({}),
});
export type StallState = z.infer<typeof StallStateSchema>;
