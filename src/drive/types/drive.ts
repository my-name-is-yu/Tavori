import { z } from "zod";

// --- Dissatisfaction Drive Score ---

export const DissatisfactionScoreSchema = z.object({
  dimension_name: z.string(),
  normalized_weighted_gap: z.number(),
  decay_factor: z.number(),
  score: z.number(),
});
export type DissatisfactionScore = z.infer<typeof DissatisfactionScoreSchema>;

// --- Deadline Drive Score ---

export const DeadlineScoreSchema = z.object({
  dimension_name: z.string(),
  normalized_weighted_gap: z.number(),
  urgency: z.number(),
  score: z.number(),
});
export type DeadlineScore = z.infer<typeof DeadlineScoreSchema>;

// --- Opportunity Drive Score ---

export const OpportunityScoreSchema = z.object({
  dimension_name: z.string(),
  opportunity_value: z.number(),
  freshness_decay: z.number(),
  score: z.number(),
});
export type OpportunityScore = z.infer<typeof OpportunityScoreSchema>;

// --- Final Drive Score (per dimension) ---

export const DriveScoreSchema = z.object({
  dimension_name: z.string(),
  dissatisfaction: z.number(),
  deadline: z.number(),
  opportunity: z.number(),
  final_score: z.number(),
  dominant_drive: z.enum(["dissatisfaction", "deadline", "opportunity"]),
});
export type DriveScore = z.infer<typeof DriveScoreSchema>;

// --- Drive Configuration ---

export const DriveConfigSchema = z.object({
  // Dissatisfaction drive
  decay_floor: z.number().default(0.3),
  recovery_time_hours: z.number().default(24),
  // Deadline drive
  deadline_horizon_hours: z.number().default(168),
  urgency_steepness: z.number().default(3.0),
  urgency_override_threshold: z.number().default(10.0),
  // Opportunity drive
  half_life_hours: z.number().default(12),
});
export type DriveConfig = z.infer<typeof DriveConfigSchema>;

// --- Event (for drive system) ---

export const PulSeedEventSchema = z.object({
  type: z.enum(["external", "internal"]),
  source: z.string(),
  timestamp: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type PulSeedEvent = z.infer<typeof PulSeedEventSchema>;

// --- Stage 2 additions ---

export const DriveContextSchema = z.object({
  time_since_last_attempt: z.record(z.string(), z.number()),
  deadlines: z.record(z.string(), z.number().nullable()),
  opportunities: z.record(z.string(), z.object({
    value: z.number(),
    detected_at: z.string(),
  })),
});
export type DriveContext = z.infer<typeof DriveContextSchema>;

export const PaceConfigSchema = z.object({
  min_check_interval_hours: z.number().default(1),
  max_check_interval_hours: z.number().default(24),
  max_consecutive_actions: z.number().default(5),
  cooldown_duration_hours: z.number().default(6),
  significant_change_threshold: z.number().default(0.05),
  backoff_factor: z.number().default(1.5),
});
export type PaceConfig = z.infer<typeof PaceConfigSchema>;

export const GoalScheduleSchema = z.object({
  goal_id: z.string(),
  next_check_at: z.string(),
  check_interval_hours: z.number(),
  last_triggered_at: z.string().nullable().default(null),
  consecutive_actions: z.number().default(0),
  cooldown_until: z.string().nullable().default(null),
  current_interval_hours: z.number(),
});
export type GoalSchedule = z.infer<typeof GoalScheduleSchema>;
