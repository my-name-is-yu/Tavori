import { z } from "zod";

// Memory tier (hierarchical memory: core/recall/archival)
export const MemoryTierSchema = z.enum(["core", "recall", "archival"]);
export type MemoryTier = z.infer<typeof MemoryTierSchema>;

// Tier budget allocation (fraction of context budget per tier)
export const TierBudgetSchema = z.object({
  core: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  archival: z.number().min(0).max(1),
});
export type TierBudget = z.infer<typeof TierBudgetSchema>;

// Retention configuration
export const RetentionConfigSchema = z.object({
  default_retention_loops: z.number().int().positive().default(100),
  goal_type_overrides: z.record(z.string(), z.number().int().positive()).default({
    health_monitoring: 200,
    business_metrics: 100,
    long_term_project: 50,
  }),
  size_limits: z.object({
    short_term_per_goal_mb: z.number().positive().default(10),
    long_term_total_mb: z.number().positive().default(100),
  }).default({}),
});
export type RetentionConfig = z.infer<typeof RetentionConfigSchema>;

// Memory data types
export const MemoryDataTypeSchema = z.enum([
  "experience_log",
  "observation",
  "strategy",
  "task",
  "knowledge",
]);
export type MemoryDataType = z.infer<typeof MemoryDataTypeSchema>;

// Short-term memory entry
export const ShortTermEntrySchema = z.object({
  id: z.string(),
  goal_id: z.string(),
  data_type: MemoryDataTypeSchema,
  loop_number: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  dimensions: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  data: z.record(z.string(), z.unknown()),
  embedding_id: z.string().nullable().default(null),
  memory_tier: MemoryTierSchema.default("recall"),
});
export type ShortTermEntry = z.infer<typeof ShortTermEntrySchema>;

// Lesson entry (Long-term)
const LessonTypeSchema = z.enum([
  "strategy_outcome",
  "success_pattern",
  "failure_pattern",
]);
type LessonType = z.infer<typeof LessonTypeSchema>;

export const LessonEntrySchema = z.object({
  lesson_id: z.string(),
  type: LessonTypeSchema,
  goal_id: z.string(),
  context: z.string(),
  action: z.string().optional(),
  outcome: z.string().optional(),
  lesson: z.string(),
  source_loops: z.array(z.string()).default([]),
  extracted_at: z.string().datetime(),
  relevance_tags: z.array(z.string()).default([]),
  // For failure patterns
  failure_reason: z.string().optional(),
  avoidance_hint: z.string().optional(),
  // For success patterns
  applicability: z.string().optional(),
  // Status
  status: z.enum(["active", "superseded", "archived"]).default("active"),
  superseded_by: z.string().optional(),
});
export type LessonEntry = z.infer<typeof LessonEntrySchema>;

// Statistical summary (Long-term)
export const TaskStatisticsSchema = z.object({
  task_category: z.string(),
  goal_id: z.string(),
  stats: z.object({
    total_count: z.number().int().nonnegative(),
    success_rate: z.number().min(0).max(1),
    avg_duration_hours: z.number().nonnegative(),
    common_failure_reason: z.string().optional(),
  }),
  period: z.string(),
  updated_at: z.string().datetime(),
});
export type TaskStatistics = z.infer<typeof TaskStatisticsSchema>;

export const DimensionStatisticsSchema = z.object({
  dimension_name: z.string(),
  goal_id: z.string(),
  stats: z.object({
    avg_value: z.number(),
    std_deviation: z.number().nonnegative(),
    trend: z.enum(["rising", "falling", "stable"]),
    anomaly_frequency: z.number().min(0).max(1),
    observation_count: z.number().int().nonnegative(),
  }),
  period: z.string(),
  updated_at: z.string().datetime(),
});
export type DimensionStatistics = z.infer<typeof DimensionStatisticsSchema>;

export const StatisticalSummarySchema = z.object({
  goal_id: z.string(),
  task_stats: z.array(TaskStatisticsSchema).default([]),
  dimension_stats: z.array(DimensionStatisticsSchema).default([]),
  overall: z.object({
    total_loops: z.number().int().nonnegative(),
    total_tasks: z.number().int().nonnegative(),
    overall_success_rate: z.number().min(0).max(1),
    active_period: z.string(),
  }),
  updated_at: z.string().datetime(),
});
export type StatisticalSummary = z.infer<typeof StatisticalSummarySchema>;

// Index entries
export const MemoryIndexEntrySchema = z.object({
  id: z.string(),
  goal_id: z.string(),
  dimensions: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  timestamp: z.string().datetime(),
  data_file: z.string(),
  entry_id: z.string(),
  last_accessed: z.string().datetime(),
  access_count: z.number().int().nonnegative().default(0),
  embedding_id: z.string().nullable().default(null),
  memory_tier: MemoryTierSchema.default("recall"),
});
export type MemoryIndexEntry = z.infer<typeof MemoryIndexEntrySchema>;

export const MemoryIndexSchema = z.object({
  version: z.number().int().positive().default(1),
  last_updated: z.string().datetime(),
  entries: z.array(MemoryIndexEntrySchema).default([]),
});
export type MemoryIndex = z.infer<typeof MemoryIndexSchema>;

// Compression result
export const CompressionResultSchema = z.object({
  goal_id: z.string(),
  data_type: MemoryDataTypeSchema,
  entries_compressed: z.number().int().nonnegative(),
  lessons_generated: z.number().int().nonnegative(),
  statistics_updated: z.boolean(),
  quality_check: z.object({
    passed: z.boolean(),
    failure_coverage_ratio: z.number().min(0).max(1),
    contradictions_found: z.number().int().nonnegative(),
  }),
  compressed_at: z.string().datetime(),
});
export type CompressionResult = z.infer<typeof CompressionResultSchema>;

// Phase 2: Relevance scoring for semantic working memory selection
export const RelevanceScoreSchema = z.object({
  entry_id: z.string(),
  goal_id: z.string(),
  dimensions: z.array(z.string()),
  semantic_score: z.number().min(0).max(1),
  recency_score: z.number().min(0).max(1),
  drive_bonus: z.number().min(0).max(0.3),
  combined_score: z.number().min(0),
});
export type RelevanceScore = z.infer<typeof RelevanceScoreSchema>;

// Phase 2: Compression policy driven by goal state
export const CompressionPolicySchema = z.object({
  goal_id: z.string(),
  dimension: z.string(),
  policy: z.enum(["normal", "delayed", "early_compression", "deadline_priority"]),
  delay_factor: z.number().default(1.0),
  updated_at: z.string(),
});
export type CompressionPolicy = z.infer<typeof CompressionPolicySchema>;
