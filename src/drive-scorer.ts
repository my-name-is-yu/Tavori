import type {
  DissatisfactionScore,
  DeadlineScore,
  OpportunityScore,
  DriveScore,
  DriveConfig,
  DriveContext,
} from "./types/drive.js";
import { DriveConfigSchema } from "./types/drive.js";
import type { GapVector } from "./types/gap.js";

/**
 * DriveScorer implements the three-drive scoring pipeline defined in drive-scoring.md:
 *   Dissatisfaction Drive × Deadline Drive × Opportunity Drive → combined DriveScore
 *
 * All functions are pure (no side effects).
 *
 * Key design constraints:
 * - Input is normalized_weighted_gap from GapCalculator pipeline ([0, 1]).
 * - Final score = max(dissatisfaction, deadline, opportunity).
 * - Deadline urgency override kicks in when urgency >= urgency_override_threshold.
 */

// ─── Default Config ───

function defaultConfig(): DriveConfig {
  return DriveConfigSchema.parse({});
}

// ─── Helpers ───

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ─── Dissatisfaction Drive ───

/**
 * Score the dissatisfaction drive for a single dimension.
 *
 * Formula from drive-scoring.md section 1:
 *   decay_factor(t) = decay_floor + (1 - decay_floor) × (1 - exp(-t / recovery_time))
 *   score = normalized_weighted_gap × decay_factor
 *
 * At t=0: decay_factor = decay_floor (floor, not zero)
 * At t→∞: decay_factor → 1.0 (full weight recovered)
 *
 * @param normalizedWeightedGap - pipeline output from GapCalculator [0, 1+]
 * @param timeSinceLastAttemptHours - hours elapsed since last attempt (>= 0)
 * @param config - optional drive configuration
 */
export function scoreDissatisfaction(
  normalizedWeightedGap: number,
  timeSinceLastAttemptHours: number,
  config?: DriveConfig
): DissatisfactionScore {
  const cfg = config ?? defaultConfig();
  const { decay_floor, recovery_time_hours } = cfg;

  const t = Math.max(0, timeSinceLastAttemptHours);
  const decayFactor =
    decay_floor + (1 - decay_floor) * (1 - Math.exp(-t / recovery_time_hours));

  const score = normalizedWeightedGap * decayFactor;

  return {
    dimension_name: "",
    normalized_weighted_gap: normalizedWeightedGap,
    decay_factor: decayFactor,
    score,
  };
}

// ─── Deadline Drive ───

/**
 * Score the deadline drive for a single dimension.
 *
 * Formula from drive-scoring.md section 2:
 *   urgency(T) = exp(urgency_steepness × (1 - T / deadline_horizon))
 *   score = normalized_weighted_gap × urgency
 *
 * Special cases:
 *   T >= deadline_horizon → urgency = 1.0
 *   T < 0 (overdue)       → score = cap (urgency at T=0)
 *   deadline = null        → score = 0, urgency = 0
 *
 * @param normalizedWeightedGap - pipeline output from GapCalculator [0, 1+]
 * @param timeRemainingHours - hours until deadline; null if no deadline; negative if overdue
 * @param config - optional drive configuration
 */
export function scoreDeadline(
  normalizedWeightedGap: number,
  timeRemainingHours: number | null,
  config?: DriveConfig
): DeadlineScore {
  const cfg = config ?? defaultConfig();
  const { deadline_horizon_hours, urgency_steepness } = cfg;

  if (timeRemainingHours === null) {
    return {
      dimension_name: "",
      normalized_weighted_gap: normalizedWeightedGap,
      urgency: 0,
      score: 0,
    };
  }

  // Cap value: urgency at T=0 (moment of deadline)
  const urgencyAtZero = Math.exp(urgency_steepness * (1 - 0 / deadline_horizon_hours));

  let urgency: number;
  if (timeRemainingHours >= deadline_horizon_hours) {
    // Far from deadline — urgency is at its minimum (1.0 by formula at T=horizon)
    urgency = 1.0;
  } else if (timeRemainingHours < 0) {
    // Overdue: cap at urgency computed at T=0
    urgency = urgencyAtZero;
  } else {
    urgency = Math.exp(
      urgency_steepness * (1 - timeRemainingHours / deadline_horizon_hours)
    );
  }

  const score = normalizedWeightedGap * urgency;

  return {
    dimension_name: "",
    normalized_weighted_gap: normalizedWeightedGap,
    urgency,
    score,
  };
}

// ─── Opportunity Drive ───

/**
 * Score the opportunity drive for a single dimension.
 *
 * Formula from drive-scoring.md section 3:
 *   freshness_decay(t) = exp(-ln(2) × t / half_life)
 *   score = opportunity_value × freshness_decay
 *
 * @param opportunityValue - computed opportunity value [0.0, 2.0]
 * @param timeSinceDetectedHours - hours elapsed since opportunity was detected
 * @param config - optional drive configuration
 */
export function scoreOpportunity(
  opportunityValue: number,
  timeSinceDetectedHours: number,
  config?: DriveConfig
): OpportunityScore {
  const cfg = config ?? defaultConfig();
  const { half_life_hours } = cfg;

  const t = Math.max(0, timeSinceDetectedHours);
  const freshnessDecay = Math.exp((-Math.LN2 * t) / half_life_hours);
  const score = opportunityValue * freshnessDecay;

  return {
    dimension_name: "",
    opportunity_value: opportunityValue,
    freshness_decay: freshnessDecay,
    score,
  };
}

// ─── Opportunity Value Computation ───

/**
 * Compute the opportunity value from its components.
 *
 * Formula from drive-scoring.md section 3:
 *   value = downstream_impact × (1 + external_bonus + timing_bonus)
 *
 * @param downstreamImpact - fraction of dimensions that depend on this one [0.0, 1.0]
 * @param externalBonus - bonus from event queue (0.0 | 0.25 | 0.5)
 * @param timingBonus - bonus from LLM evaluation (0.0 | 0.25 | 0.5)
 * @returns opportunity value in [0.0, 2.0]
 */
export function computeOpportunityValue(
  downstreamImpact: number,
  externalBonus: number,
  timingBonus: number
): number {
  return downstreamImpact * (1 + externalBonus + timingBonus);
}

// ─── Score Combination ───

/**
 * Combine the three drive scores into a final DriveScore.
 *
 * Formula from drive-scoring.md:
 *   final_score = max(dissatisfaction.score, deadline.score, opportunity.score)
 *   dominant_drive = whichever drive had the max score
 *
 * Override: if deadline.urgency >= urgency_override_threshold:
 *   final_score = deadline.score
 *   dominant_drive = "deadline"
 *
 * @param dissatisfaction - result from scoreDissatisfaction
 * @param deadline - result from scoreDeadline
 * @param opportunity - result from scoreOpportunity
 * @param config - optional drive configuration
 */
export function combineDriveScores(
  dissatisfaction: DissatisfactionScore,
  deadline: DeadlineScore,
  opportunity: OpportunityScore,
  config?: DriveConfig
): DriveScore {
  const cfg = config ?? defaultConfig();
  const { urgency_override_threshold } = cfg;

  // Deadline urgency override takes precedence
  if (deadline.urgency >= urgency_override_threshold) {
    return {
      dimension_name: dissatisfaction.dimension_name,
      dissatisfaction: dissatisfaction.score,
      deadline: deadline.score,
      opportunity: opportunity.score,
      final_score: deadline.score,
      dominant_drive: "deadline",
    };
  }

  // Normal case: max of the three scores
  const scores: Array<{ drive: "dissatisfaction" | "deadline" | "opportunity"; value: number }> = [
    { drive: "dissatisfaction", value: dissatisfaction.score },
    { drive: "deadline", value: deadline.score },
    { drive: "opportunity", value: opportunity.score },
  ];

  let best = scores[0]!;
  for (const s of scores) {
    if (s.value > best.value) {
      best = s;
    }
  }

  return {
    dimension_name: dissatisfaction.dimension_name,
    dissatisfaction: dissatisfaction.score,
    deadline: deadline.score,
    opportunity: opportunity.score,
    final_score: best.value,
    dominant_drive: best.drive,
  };
}

// ─── All Dimensions ───

/**
 * Score all dimensions in a GapVector using the provided context.
 *
 * For each dimension in gapVector.gaps:
 *   1. Retrieve context (timeSinceLastAttempt, deadline, opportunity)
 *   2. Compute all three drive scores
 *   3. Combine into a DriveScore
 *
 * @param gapVector - output from GapCalculator.calculateGapVector
 * @param context - per-dimension context (timings, deadlines, opportunities)
 * @param config - optional drive configuration
 */
export function scoreAllDimensions(
  gapVector: GapVector,
  context: DriveContext,
  config?: DriveConfig
): DriveScore[] {
  return gapVector.gaps.map((weightedGap) => {
    const dimName = weightedGap.dimension_name;
    const nwg = weightedGap.normalized_weighted_gap;

    const timeSince = context.time_since_last_attempt[dimName] ?? 0;
    const deadline = context.deadlines[dimName] !== undefined
      ? context.deadlines[dimName]!
      : null;
    const opp = context.opportunities[dimName];

    const dissatisfactionRaw = scoreDissatisfaction(nwg, timeSince, config);
    const deadlineRaw = scoreDeadline(nwg, deadline, config);
    const opportunityRaw = opp !== null && opp !== undefined
      ? (() => {
          const timeSinceDetected = (Date.now() - new Date(opp.detected_at).getTime()) / (1000 * 60 * 60);
          return scoreOpportunity(opp.value, timeSinceDetected, config);
        })()
      : scoreOpportunity(0, 0, config);

    const combined = combineDriveScores(
      dissatisfactionRaw,
      deadlineRaw,
      opportunityRaw,
      config
    );

    return { ...combined, dimension_name: dimName };
  });
}

// ─── Ranking ───

/**
 * Sort DriveScore array by final_score descending (highest priority first).
 *
 * @param scores - array of DriveScore objects
 * @returns new array sorted by final_score descending
 */
export function rankDimensions(scores: DriveScore[]): DriveScore[] {
  return [...scores].sort((a, b) => b.final_score - a.final_score);
}
