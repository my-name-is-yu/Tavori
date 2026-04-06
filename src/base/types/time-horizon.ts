import { z } from "zod";

export const GapObservationSchema = z.object({
  timestamp: z.string(),
  normalizedGap: z.number(),
});
export type GapObservation = z.infer<typeof GapObservationSchema>;

export const PacingStatusEnum = z.enum(["ahead", "on_track", "behind", "critical", "no_deadline"]);
export type PacingStatus = z.infer<typeof PacingStatusEnum>;

export const PacingRecommendationEnum = z.enum([
  "maintain_course", "increase_effort", "consider_strategy_change",
  "escalate_to_user", "sustainable_pace_ok", "sustainable_pace_declining",
]);
export type PacingRecommendation = z.infer<typeof PacingRecommendationEnum>;

export const PacingResultSchema = z.object({
  status: PacingStatusEnum,
  velocityPerHour: z.number(),
  velocityStddev: z.number(),
  projectedCompletionDate: z.string().nullable(),
  timeRemainingHours: z.number().nullable(),
  pacingRatio: z.number().nullable(),
  confidence: z.number().min(0).max(1),
  recommendation: PacingRecommendationEnum,
});
export type PacingResult = z.infer<typeof PacingResultSchema>;

export const CompletionProjectionSchema = z.object({
  estimatedDate: z.string().nullable(),
  confidenceInterval: z.object({ optimistic: z.string(), pessimistic: z.string() }).nullable(),
  isAchievable: z.boolean(),
});
export type CompletionProjection = z.infer<typeof CompletionProjectionSchema>;

export const TimeBudgetSchema = z.object({
  totalHours: z.number().nullable(),
  elapsedHours: z.number(),
  remainingHours: z.number().nullable(),
  percentElapsed: z.number().nullable(),
  percentGapRemaining: z.number(),
});
export type TimeBudget = z.infer<typeof TimeBudgetSchema>;

export type TimeBudgetWithWait = TimeBudget & {
  canAffordWait(waitHours: number): boolean;
};

export const PacingAlertSchema = z.object({
  type: z.literal("PACING_ALERT"),
  goalId: z.string(),
  status: PacingStatusEnum,
  pacingRatio: z.number(),
  currentStrategy: z.string().nullable(),
});
export type PacingAlert = z.infer<typeof PacingAlertSchema>;

export const TimeHorizonConfigSchema = z.object({
  velocity_window_size: z.number().default(10),
  velocity_ema_alpha: z.number().default(0.3),
  pacing_thresholds: z.object({
    ahead: z.number().default(0.8),
    behind: z.number().default(1.2),
    critical: z.number().default(2.0),
  }).default({}),
  min_observations_for_projection: z.number().default(3),
  sustainable_pace_decline_threshold: z.number().default(0.3),
  pacing_urgency_weight: z.number().default(0.5),
  observation_interval_multipliers: z.object({
    critical: z.number().default(1.0),
    behind: z.number().default(0.5),
    on_track: z.number().default(1.0),
    ahead: z.number().default(2.0),
    no_deadline: z.number().default(1.5),
  }).default({}),
});
export type TimeHorizonConfig = z.infer<typeof TimeHorizonConfigSchema>;
