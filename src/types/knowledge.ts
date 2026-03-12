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
