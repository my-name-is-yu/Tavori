import { z } from "zod";

// --- CuriosityTriggerType ---

export const CuriosityTriggerTypeEnum = z.enum([
  "task_queue_empty",
  "unexpected_observation",
  "repeated_failure",
  "undefined_problem",
  "periodic_exploration",
]);
export type CuriosityTriggerType = z.infer<typeof CuriosityTriggerTypeEnum>;

// --- CuriosityTrigger ---

export const CuriosityTriggerSchema = z.object({
  type: CuriosityTriggerTypeEnum,
  detected_at: z.string(),
  source_goal_id: z.string().nullable(),
  details: z.string(),
  severity: z.number().min(0).max(1),
});
export type CuriosityTrigger = z.infer<typeof CuriosityTriggerSchema>;

// --- CuriosityProposalStatus ---

export const CuriosityProposalStatusEnum = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "auto_closed",
]);
export type CuriosityProposalStatus = z.infer<typeof CuriosityProposalStatusEnum>;

// --- CuriosityProposal ---

export const CuriosityProposalSchema = z.object({
  id: z.string(),
  trigger: CuriosityTriggerSchema,
  proposed_goal: z.object({
    description: z.string(),
    rationale: z.string(),
    suggested_dimensions: z.array(
      z.object({
        name: z.string(),
        threshold_type: z.string(),
        target: z.number(),
      })
    ),
    scope_domain: z.string(),
    detection_method: z.enum([
      "observation_log",
      "stall_pattern",
      "cross_goal_transfer",
      "llm_heuristic",
      "periodic_review",
      "embedding_similarity",
    ]),
  }),
  status: CuriosityProposalStatusEnum,
  created_at: z.string(),
  expires_at: z.string(),
  reviewed_at: z.string().nullable(),
  rejection_cooldown_until: z.string().nullable(),
  loop_count: z.number().default(0),
  goal_id: z.string().nullable(),
});
export type CuriosityProposal = z.infer<typeof CuriosityProposalSchema>;

// --- CuriosityConfig ---

export const CuriosityConfigSchema = z.object({
  enabled: z.boolean().default(true),
  max_active_proposals: z.number().default(3),
  proposal_expiry_hours: z.number().default(12),
  rejection_cooldown_hours: z.number().default(168),
  unproductive_loop_limit: z.number().default(3),
  periodic_exploration_hours: z.number().default(72),
  resource_budget: z.object({
    active_user_goals_max_percent: z.number().default(20),
    waiting_user_goals_max_percent: z.number().default(50),
  }),
  unexpected_observation_threshold: z.number().default(2.0),
});
export type CuriosityConfig = z.infer<typeof CuriosityConfigSchema>;

// --- LearningRecord ---

export const LearningRecordSchema = z.object({
  goal_id: z.string(),
  dimension_name: z.string(),
  approach: z.string(),
  outcome: z.enum(["success", "failure", "partial"]),
  improvement_ratio: z.number(),
  recorded_at: z.string(),
});
export type LearningRecord = z.infer<typeof LearningRecordSchema>;

// --- CuriosityState ---

export const CuriosityStateSchema = z.object({
  proposals: z.array(CuriosityProposalSchema),
  learning_records: z.array(LearningRecordSchema),
  last_exploration_at: z.string().nullable(),
  rejected_proposal_hashes: z.array(z.string()),
});
export type CuriosityState = z.infer<typeof CuriosityStateSchema>;
