import { z } from "zod";

// --- Threshold Types ---

export const ThresholdTypeEnum = z.enum([
  "min",
  "max",
  "range",
  "present",
  "match",
]);
export type ThresholdType = z.infer<typeof ThresholdTypeEnum>;

export const MinThresholdSchema = z.object({
  type: z.literal("min"),
  value: z.number(),
});
export type MinThreshold = z.infer<typeof MinThresholdSchema>;

export const MaxThresholdSchema = z.object({
  type: z.literal("max"),
  value: z.number(),
});
export type MaxThreshold = z.infer<typeof MaxThresholdSchema>;

export const RangeThresholdSchema = z.object({
  type: z.literal("range"),
  low: z.number(),
  high: z.number(),
});
export type RangeThreshold = z.infer<typeof RangeThresholdSchema>;

export const PresentThresholdSchema = z.object({
  type: z.literal("present"),
});
export type PresentThreshold = z.infer<typeof PresentThresholdSchema>;

export const MatchThresholdSchema = z.object({
  type: z.literal("match"),
  value: z.union([z.string(), z.number(), z.boolean()]),
});
export type MatchThreshold = z.infer<typeof MatchThresholdSchema>;

export const ThresholdSchema = z.discriminatedUnion("type", [
  MinThresholdSchema,
  MaxThresholdSchema,
  RangeThresholdSchema,
  PresentThresholdSchema,
  MatchThresholdSchema,
]);
export type Threshold = z.infer<typeof ThresholdSchema>;

// --- Observation Types ---

export const ObservationTypeEnum = z.enum([
  "mechanical",
  "llm_review",
  "api_query",
  "file_check",
  "manual",
  "git_diff",
  "grep_check",
  "test_run",
]);
export type ObservationType = z.infer<typeof ObservationTypeEnum>;

export const ConfidenceTierEnum = z.enum([
  "mechanical",
  "independent_review",
  "self_report",
]);
export type ConfidenceTier = z.infer<typeof ConfidenceTierEnum>;

export const ObservationMethodSchema = z.object({
  type: ObservationTypeEnum,
  source: z.string(),
  schedule: z.string().nullable(),
  endpoint: z.string().nullable(),
  confidence_tier: ConfidenceTierEnum,
});
export type ObservationMethod = z.infer<typeof ObservationMethodSchema>;

// --- Observation Trigger ---

export const ObservationTriggerEnum = z.enum([
  "post_task",
  "periodic",
  "event_driven",
]);
export type ObservationTrigger = z.infer<typeof ObservationTriggerEnum>;

// --- Observation Layer ---

export const ObservationLayerEnum = z.enum([
  "mechanical",
  "independent_review",
  "self_report",
]);
export type ObservationLayer = z.infer<typeof ObservationLayerEnum>;

// --- Aggregation Types ---

export const AggregationTypeEnum = z.enum(["min", "weighted_avg", "max", "all_required"]);
export type AggregationType = z.infer<typeof AggregationTypeEnum>;

// --- Goal Aggregation (for gap rollup) ---

export const GapAggregationEnum = z.enum(["max", "weighted_avg", "sum"]);
export type GapAggregation = z.infer<typeof GapAggregationEnum>;

// --- Feasibility Assessment ---

export const FeasibilityAssessmentEnum = z.enum([
  "realistic",
  "ambitious",
  "infeasible",
]);
export type FeasibilityAssessment = z.infer<typeof FeasibilityAssessmentEnum>;

// --- Goal Negotiation Response ---

export const NegotiationResponseTypeEnum = z.enum([
  "accept",
  "counter_propose",
  "flag_as_ambitious",
]);
export type NegotiationResponseType = z.infer<typeof NegotiationResponseTypeEnum>;

// --- Reversibility ---

export const ReversibilityEnum = z.enum([
  "reversible",
  "irreversible",
  "unknown",
]);
export type Reversibility = z.infer<typeof ReversibilityEnum>;

// --- Verification Verdict ---

export const VerdictEnum = z.enum(["pass", "partial", "fail"]);
export type Verdict = z.infer<typeof VerdictEnum>;

// --- Task Status ---

export const TaskStatusEnum = z.enum([
  "pending",
  "running",
  "completed",
  "timed_out",
  "error",
]);
export type TaskStatus = z.infer<typeof TaskStatusEnum>;

// --- Stall Types ---

export const StallTypeEnum = z.enum([
  "dimension_stall",
  "time_exceeded",
  "consecutive_failure",
  "global_stall",
  "predicted_plateau",
  "predicted_regression",
]);
export type StallType = z.infer<typeof StallTypeEnum>;

export const StallCauseEnum = z.enum([
  "information_deficit",
  "approach_failure",
  "capability_limit",
  "external_dependency",
  "goal_infeasible",
]);
export type StallCause = z.infer<typeof StallCauseEnum>;

// --- Strategy State ---

export const StrategyStateEnum = z.enum([
  "candidate",
  "active",
  "evaluating",
  "suspended",
  "completed",
  "terminated",
]);
export type StrategyState = z.infer<typeof StrategyStateEnum>;

// --- Duration ---

export const DurationSchema = z.object({
  value: z.number(),
  unit: z.enum(["minutes", "hours", "days", "weeks"]),
});
export type Duration = z.infer<typeof DurationSchema>;

// --- Pace Status (for milestones) ---

export const PaceStatusEnum = z.enum(["on_track", "at_risk", "behind"]);
export type PaceStatus = z.infer<typeof PaceStatusEnum>;

// --- Event Types ---

export const EventTypeEnum = z.enum(["external", "internal"]);
export type EventType = z.infer<typeof EventTypeEnum>;

// --- Dependency Types ---

export const DependencyTypeEnum = z.enum([
  "prerequisite",
  "resource_conflict",
  "synergy",
  "conflict",
  "strategy_dependency",
]);
export type DependencyType = z.infer<typeof DependencyTypeEnum>;

// --- Report Types ---

export const ReportTypeEnum = z.enum([
  "daily_summary",
  "weekly_report",
  "urgent_alert",
  "approval_request",
  "stall_escalation",
  "goal_completion",
  "strategy_change",
  "capability_escalation",
  "execution_summary",
]);
export type ReportType = z.infer<typeof ReportTypeEnum>;

export const VerbosityLevelEnum = z.enum(["minimal", "standard", "detailed"]);
export type VerbosityLevel = z.infer<typeof VerbosityLevelEnum>;
