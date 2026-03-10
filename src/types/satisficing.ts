import { z } from "zod";

// --- SatisficingJudge types ---

export const CompletionJudgmentSchema = z.object({
  is_complete: z.boolean(),
  blocking_dimensions: z.array(z.string()).default([]),
  low_confidence_dimensions: z.array(z.string()).default([]),
  needs_verification_task: z.boolean().default(false),
  checked_at: z.string(),
});
export type CompletionJudgment = z.infer<typeof CompletionJudgmentSchema>;

export const DimensionSatisfactionSchema = z.object({
  dimension_name: z.string(),
  is_satisfied: z.boolean(),
  current_value: z.number().nullable(),
  threshold_value: z.number().nullable(),
  confidence: z.number(),
  confidence_tier: z.enum(["high", "medium", "low"]),
  effective_progress: z.number(),
  progress_ceiling: z.number(),
});
export type DimensionSatisfaction = z.infer<typeof DimensionSatisfactionSchema>;

export const IterationConstraintsSchema = z.object({
  max_dimensions: z.number().default(3),
  uncertainty_threshold: z.number().default(0.50),
});
export type IterationConstraints = z.infer<typeof IterationConstraintsSchema>;

export const ThresholdAdjustmentProposalSchema = z.object({
  goal_id: z.string(),
  dimension_name: z.string(),
  current_threshold: z.number(),
  proposed_threshold: z.number(),
  reason: z.string(),
  evidence: z.string(),
});
export type ThresholdAdjustmentProposal = z.infer<typeof ThresholdAdjustmentProposalSchema>;
