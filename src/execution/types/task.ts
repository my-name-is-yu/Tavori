import { z } from "zod";
import {
  ReversibilityEnum,
  VerdictEnum,
  TaskStatusEnum,
  DurationSchema,
  ObservationLayerEnum,
} from "./core.js";

// --- Success Criterion ---

export const CriterionSchema = z.object({
  description: z.string(),
  verification_method: z.string(),
  is_blocking: z.boolean().default(true),
});
export type Criterion = z.infer<typeof CriterionSchema>;

// --- Scope Boundary ---

export const ScopeBoundarySchema = z.object({
  in_scope: z.array(z.string()),
  out_of_scope: z.array(z.string()),
  blast_radius: z.string(),
});
export type ScopeBoundary = z.infer<typeof ScopeBoundarySchema>;

// --- Task ---

export const TaskSchema = z.object({
  id: z.string(),
  goal_id: z.string(),
  strategy_id: z.string().nullable().default(null),

  target_dimensions: z.array(z.string()),
  primary_dimension: z.string(),

  work_description: z.string(),
  rationale: z.string(),
  approach: z.string(),

  success_criteria: z.array(CriterionSchema),
  scope_boundary: ScopeBoundarySchema,
  constraints: z.array(z.string()),

  plateau_until: z.string().nullable().default(null),
  estimated_duration: DurationSchema.nullable().default(null),
  consecutive_failure_count: z.number().default(0),
  reversibility: ReversibilityEnum.default("unknown"),
  intended_direction: z.enum(["increase", "decrease", "neutral"]).optional(),

  // Task category — enumerated to enable stall detection comparisons
  task_category: z
    .enum(["normal", "knowledge_acquisition", "verification", "observation", "capability_acquisition"])
    .default("normal"),

  status: TaskStatusEnum.default("pending"),
  started_at: z.string().nullable().default(null),
  completed_at: z.string().nullable().default(null),
  timeout_at: z.string().nullable().default(null),
  heartbeat_at: z.string().datetime().nullable().default(null),

  created_at: z.string(),

  // Persisted execution/verification results
  execution_output: z.string().optional(),
  verification_verdict: VerdictEnum.optional(),
  verification_evidence: z.array(z.string()).optional(),
});
export type Task = z.infer<typeof TaskSchema>;

// --- Evidence ---

export const EvidenceSchema = z.object({
  layer: ObservationLayerEnum,
  description: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

// --- Dimension Update ---

export const DimensionUpdateSchema = z.object({
  dimension_name: z.string(),
  previous_value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  new_value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  confidence: z.number().min(0).max(1),
});
export type DimensionUpdate = z.infer<typeof DimensionUpdateSchema>;

// --- Verification Result ---

export const VerificationResultSchema = z.object({
  task_id: z.string(),
  verdict: VerdictEnum,
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceSchema),
  dimension_updates: z.array(DimensionUpdateSchema),
  timestamp: z.string(),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
