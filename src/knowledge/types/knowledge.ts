import { z } from "zod";

// --- Source ---

export const SourceTypeEnum = z.enum([
  "web",
  "document",
  "data_analysis",
  "expert",
  "llm_inference",
]);
export type SourceType = z.infer<typeof SourceTypeEnum>;

export const SourceSchema = z.object({
  type: SourceTypeEnum,
  reference: z.string(),
  reliability: z.enum(["high", "medium", "low"]),
});
export type Source = z.infer<typeof SourceSchema>;

// --- KnowledgeEntry ---

export const KnowledgeEntrySchema = z.object({
  entry_id: z.string(),
  question: z.string(),
  answer: z.string(),
  sources: z.array(SourceSchema),
  confidence: z.number().min(0).max(1),
  acquired_at: z.string(),
  acquisition_task_id: z.string(),
  superseded_by: z.string().nullable().default(null),
  tags: z.array(z.string()),
  embedding_id: z.string().nullable().default(null),
});
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

// --- DomainKnowledge ---

export const DomainKnowledgeSchema = z.object({
  goal_id: z.string(),
  domain: z.string(),
  entries: z.array(KnowledgeEntrySchema),
  last_updated: z.string(),
});
export type DomainKnowledge = z.infer<typeof DomainKnowledgeSchema>;

// --- KnowledgeGapSignal ---

export const KnowledgeGapSignalTypeEnum = z.enum([
  "interpretation_difficulty",
  "strategy_deadlock",
  "stall_information_deficit",
  "new_domain",
  "prerequisite_missing",
]);
export type KnowledgeGapSignalType = z.infer<typeof KnowledgeGapSignalTypeEnum>;

export const KnowledgeGapSignalSchema = z.object({
  signal_type: KnowledgeGapSignalTypeEnum,
  missing_knowledge: z.string(),
  source_step: z.string(),
  related_dimension: z.string().nullable().default(null),
});
export type KnowledgeGapSignal = z.infer<typeof KnowledgeGapSignalSchema>;

// --- ContradictionResult ---

export const ContradictionResultSchema = z.object({
  has_contradiction: z.boolean(),
  conflicting_entry_id: z.string().nullable().default(null),
  resolution: z.string().nullable().default(null),
});
export type ContradictionResult = z.infer<typeof ContradictionResultSchema>;

// --- KnowledgeGraph types ---

export const KnowledgeRelationTypeEnum = z.enum([
  "supports",
  "contradicts",
  "refines",
  "depends_on",
]);
export type KnowledgeRelationType = z.infer<typeof KnowledgeRelationTypeEnum>;

export const KnowledgeEdgeSchema = z.object({
  from_id: z.string(),
  to_id: z.string(),
  relation: KnowledgeRelationTypeEnum,
  confidence: z.number().min(0).max(1),
  created_at: z.string(),
});
export type KnowledgeEdge = z.infer<typeof KnowledgeEdgeSchema>;

// --- Milestone 5.1 — Shared Knowledge Base ---

export const DomainStabilitySchema = z.enum(["stable", "moderate", "volatile"]);
export type DomainStability = z.infer<typeof DomainStabilitySchema>;

/**
 * RevalidationSchedule maps domain stability to re-check interval in days.
 *   stable   → 365 days (12 months)
 *   moderate → 180 days (6 months)
 *   volatile → 90 days  (3 months)
 */
export const RevalidationScheduleSchema = z.object({
  stable: z.literal(365),
  moderate: z.literal(180),
  volatile: z.literal(90),
});
export type RevalidationSchedule = z.infer<typeof RevalidationScheduleSchema>;

export const REVALIDATION_SCHEDULE: RevalidationSchedule = {
  stable: 365,
  moderate: 180,
  volatile: 90,
};

/**
 * SharedKnowledgeEntry extends KnowledgeEntry with cross-goal sharing metadata.
 */
export const SharedKnowledgeEntrySchema = KnowledgeEntrySchema.extend({
  source_goal_ids: z.array(z.string()),
  domain_stability: DomainStabilitySchema,
  revalidation_due_at: z.string().nullable().default(null),
});
export type SharedKnowledgeEntry = z.infer<typeof SharedKnowledgeEntrySchema>;

// --- DecisionRecord (M14-S3: Decision history learning loop) ---

export const DecisionContextSchema = z.object({
  gap_value: z.number(),
  stall_count: z.number().int(),
  cycle_count: z.number().int(),
  trust_score: z.number(),
});
export type DecisionContext = z.infer<typeof DecisionContextSchema>;

export const DecisionRecordSchema = z.object({
  id: z.string(),
  goal_id: z.string(),
  goal_type: z.string(),
  strategy_id: z.string(),
  hypothesis: z.string().optional(),
  decision: z.enum(["proceed", "refine", "pivot", "escalate"]),
  context: DecisionContextSchema,
  outcome: z.enum(["success", "failure", "pending"]),
  timestamp: z.string(),
  what_worked: z.array(z.string()).default([]),
  what_failed: z.array(z.string()).default([]),
  suggested_next: z.array(z.string()).default([]),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;
