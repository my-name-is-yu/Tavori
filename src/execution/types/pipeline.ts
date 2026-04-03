import { z } from "zod";
import { VerdictEnum } from "./core.js";

// --- Task Domain ---

export const TaskDomainSchema = z.enum([
  "code",
  "data",
  "api_action",
  "research",
  "communication",
  "monitoring",
]);
export type TaskDomain = z.infer<typeof TaskDomainSchema>;

// --- Task Role ---

export const TaskRoleSchema = z.enum([
  "implementor",
  "reviewer",
  "verifier",
  "researcher",
]);
export type TaskRole = z.infer<typeof TaskRoleSchema>;

// --- Pipeline Stage ---

export const PipelineStageSchema = z.object({
  role: TaskRoleSchema,
  capability_requirement: z
    .object({
      domain: TaskDomainSchema,
      preferred_adapter: z.string().optional(),
    })
    .optional(),
  prompt_override: z.string().optional(),
});
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

// --- Task Pipeline ---

export const TaskPipelineSchema = z.object({
  stages: z.array(PipelineStageSchema).min(1),
  fail_fast: z.boolean().default(true),
  shared_context: z.string().optional(),
  strategy_id: z.string().optional(),
});
export type TaskPipeline = z.infer<typeof TaskPipelineSchema>;

// --- Stage Result ---

export const StageResultSchema = z.object({
  stage_index: z.number(),
  role: TaskRoleSchema,
  verdict: VerdictEnum,
  output: z.string(),
  confidence: z.number().min(0).max(1),
  idempotency_key: z.string(),
});
export type StageResult = z.infer<typeof StageResultSchema>;

// --- Pipeline State ---

export const PipelineStateSchema = z.object({
  pipeline_id: z.string(),
  task_id: z.string(),
  current_stage_index: z.number(),
  completed_stages: z.array(StageResultSchema),
  status: z.enum(["running", "completed", "failed", "interrupted"]),
  started_at: z.string(),
  updated_at: z.string(),
});
export type PipelineState = z.infer<typeof PipelineStateSchema>;

// --- Impact Analysis ---

export const ImpactAnalysisSchema = z.object({
  verdict: VerdictEnum,
  side_effects: z.array(z.string()).default([]),
  confidence: z.enum(["confirmed", "likely", "uncertain"]),
});
export type ImpactAnalysis = z.infer<typeof ImpactAnalysisSchema>;
