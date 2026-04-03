import { z } from "zod";

// --- SatisficingJudge types ---

// Convergence detection result (改善3: 収束判定の強化)
export const SatisficingStatusSchema = z.enum([
  "satisficed",          // gap < threshold (existing behavior)
  "converged_satisficed",// variance < ε AND gap ≤ threshold × 1.5 (NEW)
  "stalled",             // variance < ε AND gap > threshold × 1.5 → delegate to StallDetector (NEW)
  "in_progress",         // still improving, continue
]);
export type SatisficingStatus = z.infer<typeof SatisficingStatusSchema>;

export const ConvergenceJudgmentSchema = z.object({
  status: SatisficingStatusSchema,
  gap: z.number(),
  variance: z.number().nullable(),  // null when fewer than N values in buffer
  window_size: z.number(),
  samples_available: z.number(),
});
export type ConvergenceJudgment = z.infer<typeof ConvergenceJudgmentSchema>;

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

export const MappingProposalSchema = z.object({
  subgoal_dimension: z.string(),
  parent_dimension: z.string(),
  similarity_score: z.number().min(0).max(1),
  suggested_aggregation: z.enum(["min", "avg", "max", "all_required"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});
export type MappingProposal = z.infer<typeof MappingProposalSchema>;
