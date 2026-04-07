import { z } from "zod";
import { LearnedPatternSchema } from "../knowledge/types/learning.js";

export const DreamSourceSchema = z.enum([
  "observation",
  "task",
  "verification",
  "strategy",
  "stall",
]);

export type DreamSource = z.infer<typeof DreamSourceSchema>;
export type ImportanceSource = DreamSource;

export const DreamEventTypeSchema = z.enum([
  "PreObserve",
  "PostObserve",
  "PreTaskCreate",
  "PostTaskCreate",
  "PreExecute",
  "PostExecute",
  "GoalStateChange",
  "LoopCycleStart",
  "LoopCycleEnd",
  "ReflectionComplete",
  "StallDetected",
]);

export type DreamEventType = z.infer<typeof DreamEventTypeSchema>;

export const DriveScoreLogSchema = z.object({
  dimensionName: z.string(),
  score: z.number(),
  urgency: z.number().optional(),
  confidence: z.number().optional(),
});

export type DriveScoreLog = z.infer<typeof DriveScoreLogSchema>;

export const VerificationResultSummarySchema = z.object({
  verdict: z.string(),
  confidence: z.number().min(0).max(1),
  timestamp: z.string(),
});

export type VerificationResultSummary = z.infer<typeof VerificationResultSummarySchema>;

export const IterationGapDimensionSchema = z.object({
  dimension_name: z.string(),
  raw_gap: z.number(),
  normalized_gap: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  uncertainty_weight: z.number(),
});

export type IterationGapDimension = z.infer<typeof IterationGapDimensionSchema>;

export const IterationLogSchema = z.object({
  timestamp: z.string(),
  goalId: z.string(),
  iteration: z.number().int().nonnegative(),
  sessionId: z.string(),
  gapAggregate: z.number().min(0),
  gapDimensions: z.array(IterationGapDimensionSchema).optional(),
  driveScores: z.array(DriveScoreLogSchema).optional(),
  taskId: z.string().nullable().optional(),
  taskAction: z.string().nullable().optional(),
  strategyId: z.string().nullable().optional(),
  verificationResult: VerificationResultSummarySchema.nullable().optional(),
  stallDetected: z.boolean(),
  stallSeverity: z.number().min(0).max(3).nullable().optional(),
  tokensUsed: z.number().nonnegative().nullable().optional(),
  elapsedMs: z.number().nonnegative(),
  skipped: z.boolean().optional(),
  skipReason: z.string().nullable().optional(),
  completionJudgment: z.record(z.string(), z.unknown()),
  waitSuppressed: z.boolean().optional(),
});

export type IterationLog = z.infer<typeof IterationLogSchema>;

export const SessionLogSchema = z.object({
  timestamp: z.string(),
  goalId: z.string(),
  sessionId: z.string(),
  iterationCount: z.number().int().nonnegative(),
  finalGapAggregate: z.number().min(0),
  initialGapAggregate: z.number().min(0),
  totalTokensUsed: z.number().nonnegative(),
  totalElapsedMs: z.number().nonnegative(),
  stallCount: z.number().int().nonnegative(),
  outcome: z.string(),
  strategiesUsed: z.array(z.string()).default([]),
});

export type SessionLog = z.infer<typeof SessionLogSchema>;

export const ImportanceEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  goalId: z.string(),
  source: DreamSourceSchema,
  importance: z.number().min(0).max(1),
  reason: z.string(),
  data_ref: z.string(),
  tags: z.array(z.string()).default([]),
  processed: z.boolean().default(false),
});

export type ImportanceEntry = z.infer<typeof ImportanceEntrySchema>;

export const EventLogSchema = z.object({
  timestamp: z.string(),
  eventType: DreamEventTypeSchema,
  goalId: z.string(),
  taskId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type EventLog = z.infer<typeof EventLogSchema>;

export const WatermarkStateSchema = z.object({
  goals: z.record(
    z.string(),
    z.object({
      lastProcessedLine: z.number().int().nonnegative().default(0),
      lastProcessedTimestamp: z.string().optional(),
    })
  ).default({}),
  importanceBuffer: z.object({
    lastProcessedLine: z.number().int().nonnegative().default(0),
    lastProcessedTimestamp: z.string().optional(),
  }).default({
    lastProcessedLine: 0,
  }),
});

export type WatermarkState = z.infer<typeof WatermarkStateSchema>;
export const DreamWatermarkSchema = WatermarkStateSchema;
export type DreamWatermark = WatermarkState;

export const DreamLogCollectionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  iterationLoggingEnabled: z.boolean().default(true),
  sessionSummariesEnabled: z.boolean().default(true),
  eventPersistenceEnabled: z.boolean().default(true),
  importanceThreshold: z.number().min(0).max(1).default(0.5),
  maxFileSizeBytes: z.number().int().positive().default(10 * 1024 * 1024),
  pruneTargetRatio: z.number().gt(0).lte(1).default(0.8),
  rotationMode: z.enum(["size", "date"]).default("size"),
  watermarkBehavior: z.enum(["readonly", "readwrite"]).default("readwrite"),
});

export type DreamLogCollectionConfig = z.infer<typeof DreamLogCollectionConfigSchema>;

export const DreamLogConfigSchema = z.object({
  logCollection: DreamLogCollectionConfigSchema.default({}),
  analysis: z.object({
    batchSize: z.number().int().positive().default(100),
    minIterationsForAnalysis: z.number().int().positive().default(20),
    maxGoalsPerRun: z.number().int().positive().default(25),
    patternConfidenceThreshold: z.number().min(0).max(1).default(0.7),
    lightRecentIterationWindow: z.number().int().positive().default(50),
    lightTokenBudget: z.number().int().positive().default(15_000),
    deepTokenBudget: z.number().int().positive().default(200_000),
  }).default({}),
  activation: z.object({
    semanticWorkingMemory: z.boolean().default(false),
    crossGoalLessons: z.boolean().default(false),
    semanticContext: z.boolean().default(false),
    autoAcquireKnowledge: z.boolean().default(false),
    learnedPatternHints: z.boolean().default(false),
    strategyTemplates: z.boolean().default(false),
    decisionHeuristics: z.boolean().default(false),
    graphTraversal: z.boolean().default(false),
  }).default({}),
  consolidation: z.object({
    memory: z.object({ enabled: z.boolean().default(true) }).default({}),
    agentMemory: z.object({ enabled: z.boolean().default(true) }).default({}),
    crossGoalTransfer: z.object({
      enabled: z.boolean().default(true),
      topKActiveGoals: z.number().int().positive().default(20),
    }).default({}),
    decisionHistory: z.object({
      enabled: z.boolean().default(true),
      retentionDays: z.number().int().positive().default(30),
    }).default({}),
    stallHistory: z.object({ enabled: z.boolean().default(true) }).default({}),
    sessionData: z.object({
      enabled: z.boolean().default(true),
      archiveAfterDays: z.number().int().positive().default(30),
    }).default({}),
    iterationLogs: z.object({
      enabled: z.boolean().default(true),
      archiveAfterDays: z.number().int().positive().default(30),
    }).default({}),
    gapHistory: z.object({ enabled: z.boolean().default(true) }).default({}),
    observationLogs: z.object({ enabled: z.boolean().default(true) }).default({}),
    reports: z.object({ enabled: z.boolean().default(true) }).default({}),
    trustScores: z.object({ enabled: z.boolean().default(true) }).default({}),
    strategyHistory: z.object({ enabled: z.boolean().default(true) }).default({}),
    verificationArtifacts: z.object({ enabled: z.boolean().default(true) }).default({}),
    archive: z.object({ enabled: z.boolean().default(true) }).default({}),
    knowledgeOptimization: z.object({
      enabled: z.boolean().default(true),
      redundancySimilarityThreshold: z.number().min(0).max(1).default(0.95),
    }).default({}),
  }).default({}),
});

export type DreamLogConfig = z.infer<typeof DreamLogConfigSchema>;

export const DreamPhaseSchema = z.enum(["A", "B", "C"]);
export type DreamPhase = z.infer<typeof DreamPhaseSchema>;

export const DreamTierSchema = z.enum(["light", "deep"]);
export type DreamTier = z.infer<typeof DreamTierSchema>;

export const IterationWindowSchema = z.object({
  goalId: z.string(),
  startIteration: z.number().int().nonnegative(),
  endIteration: z.number().int().nonnegative(),
  iterations: z.array(IterationLogSchema),
  evidenceRefs: z.array(z.string()).default([]),
  importance: z.number().min(0).max(1).optional(),
  source: z.enum(["importance", "recent", "regular"]).default("regular"),
});

export type IterationWindow = z.infer<typeof IterationWindowSchema>;

export const IngestionStatsSchema = z.object({
  linesRead: z.number().int().nonnegative(),
  malformedLines: z.number().int().nonnegative(),
  batchesBuilt: z.number().int().nonnegative(),
});

export type IngestionStats = z.infer<typeof IngestionStatsSchema>;

export const IngestionOutputSchema = z.object({
  prioritizedBatches: z.array(IterationWindowSchema),
  regularBatches: z.array(IterationWindowSchema),
  importanceEntries: z.array(ImportanceEntrySchema),
  sessionLogs: z.array(SessionLogSchema),
  stats: IngestionStatsSchema,
  watermarkTargets: z.object({
    goals: z.record(z.string(), z.number().int().nonnegative()).default({}),
    importanceBufferLine: z.number().int().nonnegative().default(0),
  }),
});

export type IngestionOutput = z.infer<typeof IngestionOutputSchema>;

export const DreamPatternCandidateSchema = z.object({
  pattern_type: z.string(),
  goal_id: z.string().optional(),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  evidence_refs: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type DreamPatternCandidate = z.infer<typeof DreamPatternCandidateSchema>;

export const DreamPatternResponseSchema = z.object({
  patterns: z.array(DreamPatternCandidateSchema).default([]),
});

export type DreamPatternResponse = z.infer<typeof DreamPatternResponseSchema>;

export const ScheduleSuggestionSchema = z.object({
  type: z.enum(["cron", "goal_trigger", "cleanup", "dream_cron"]),
  goalId: z.string().optional(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  proposal: z.string(),
});

export type ScheduleSuggestion = z.infer<typeof ScheduleSuggestionSchema>;

export const ScheduleSuggestionFileSchema = z.object({
  generated_at: z.string(),
  suggestions: z.array(ScheduleSuggestionSchema).default([]),
});

export type ScheduleSuggestionFile = z.infer<typeof ScheduleSuggestionFileSchema>;

export const DreamRunReportSchema = z.object({
  tier: DreamTierSchema,
  phasesCompleted: z.array(DreamPhaseSchema),
  goalsProcessed: z.array(z.string()),
  patternsPersisted: z.number().int().nonnegative(),
  scheduleSuggestions: z.number().int().nonnegative(),
  tokensEstimated: z.number().int().nonnegative(),
  partial: z.boolean().default(false),
  stats: IngestionStatsSchema,
  learnedPatterns: z.array(LearnedPatternSchema).default([]),
  suggestions: z.array(ScheduleSuggestionSchema).default([]),
});

export type DreamRunReport = z.infer<typeof DreamRunReportSchema>;

export const ConsolidationCategoryResultSchema = z.object({
  category: z.string(),
  status: z.enum(["completed", "skipped", "failed"]),
  metrics: z.record(z.string(), z.number()).default({}),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
});

export type ConsolidationCategoryResult = z.infer<typeof ConsolidationCategoryResultSchema>;

export const DreamReportSchema = z.object({
  timestamp: z.string(),
  tier: DreamTierSchema,
  status: z.enum(["completed", "partial", "failed"]),
  categories: z.array(ConsolidationCategoryResultSchema).default([]),
  summary: z.string(),
});

export type DreamReport = z.infer<typeof DreamReportSchema>;
