import type {
  GapObservation,
  PacingResult,
  PacingStatus,
  PacingRecommendation,
  CompletionProjection,
  TimeBudgetWithWait,
  TimeHorizonConfig,
} from "../../base/types/time-horizon.js";
import { TimeHorizonConfigSchema } from "../../base/types/time-horizon.js";

const EPSILON = 1e-9;

export interface ITimeHorizonEngine {
  evaluatePacing(
    goalId: string,
    currentGap: number,
    deadline: string | null,
    history: GapObservation[]
  ): PacingResult;

  projectCompletion(
    velocity: number,
    velocityStddev: number,
    remainingGap: number
  ): CompletionProjection;

  suggestObservationInterval(
    pacingResult: PacingResult,
    baseIntervalMs: number
  ): number;

  getTimeBudget(
    deadline: string | null,
    startTime: string,
    currentGap: number,
    initialGap: number,
    velocityPerHour: number
  ): TimeBudgetWithWait;
}

// ─── Velocity helpers ─────────────────────────────────────────────────────────

function calcPointVelocities(
  history: GapObservation[],
  windowSize: number
): number[] {
  const window = history.slice(-windowSize - 1);
  const velocities: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1];
    const curr = window[i];
    const hoursElapsed =
      (new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime()) /
      3_600_000;
    if (hoursElapsed <= 0) continue;
    velocities.push((prev.normalizedGap - curr.normalizedGap) / hoursElapsed);
  }
  return velocities;
}

function calcEmaVelocity(pointVelocities: number[], alpha: number): number {
  if (pointVelocities.length === 0) return 0;
  let ema = pointVelocities[0];
  for (let i = 1; i < pointVelocities.length; i++) {
    ema = alpha * pointVelocities[i] + (1 - alpha) * ema;
  }
  return ema;
}

function calcStddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function hoursFromNow(isoDate: string): number {
  return (new Date(isoDate).getTime() - Date.now()) / 3_600_000;
}

function addHoursToNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

// ─── Recommendation mapping ───────────────────────────────────────────────────

function deriveRecommendation(
  status: PacingStatus,
  confidence: number,
  isVelocityDeclining: boolean
): PacingRecommendation {
  switch (status) {
    case "ahead":
    case "on_track":
      return "maintain_course";
    case "behind":
      return confidence >= 0.6 ? "consider_strategy_change" : "increase_effort";
    case "critical":
      return confidence >= 0.6 ? "escalate_to_user" : "consider_strategy_change";
    case "no_deadline":
      return isVelocityDeclining
        ? "sustainable_pace_declining"
        : "sustainable_pace_ok";
  }
}

// ─── TimeHorizonEngine ────────────────────────────────────────────────────────

export class TimeHorizonEngine implements ITimeHorizonEngine {
  private readonly config: TimeHorizonConfig;

  constructor(config?: Partial<TimeHorizonConfig>) {
    this.config = TimeHorizonConfigSchema.parse(config ?? {});
  }

  evaluatePacing(
    _goalId: string,
    currentGap: number,
    deadline: string | null,
    history: GapObservation[]
  ): PacingResult {
    const { velocity_window_size, velocity_ema_alpha, min_observations_for_projection } =
      this.config;

    const pointVelocities = calcPointVelocities(history, velocity_window_size);
    const velocityPerHour = calcEmaVelocity(pointVelocities, velocity_ema_alpha);
    const velocityStddev = calcStddev(pointVelocities);

    const observationCount = history.length;
    const confidence = Math.min(1.0, observationCount / min_observations_for_projection);

    // No deadline — perpetual goal
    if (deadline === null) {
      const isVelocityDeclining = this.isVelocityDeclining(history);
      const recommendation = deriveRecommendation("no_deadline", confidence, isVelocityDeclining);
      return {
        status: "no_deadline",
        velocityPerHour,
        velocityStddev,
        projectedCompletionDate: null, // §6.2: no burn-down projection for perpetual goals
        timeRemainingHours: null,
        pacingRatio: null,
        confidence,
        recommendation,
      };
    }

    const timeRemainingHours = hoursFromNow(deadline);
    const requiredVelocity =
      timeRemainingHours > 0 ? currentGap / timeRemainingHours : Infinity;
    const effectiveVelocity = Math.max(velocityPerHour, EPSILON);
    const pacingRatio = requiredVelocity / effectiveVelocity;

    const status = this.classifyStatus(pacingRatio);
    const recommendation = deriveRecommendation(status, confidence, false);

    const projection =
      observationCount >= min_observations_for_projection && velocityPerHour > 0
        ? this.projectCompletion(velocityPerHour, velocityStddev, currentGap)
        : null;

    return {
      status,
      velocityPerHour,
      velocityStddev,
      projectedCompletionDate: projection?.estimatedDate ?? null,
      timeRemainingHours,
      pacingRatio,
      confidence,
      recommendation,
    };
  }

  projectCompletion(
    velocity: number,
    velocityStddev: number,
    remainingGap: number
  ): CompletionProjection {
    if (velocity <= 0) {
      return {
        estimatedDate: null,
        confidenceInterval: null,
        isAchievable: false,
      };
    }

    const hoursRemaining = remainingGap / velocity;
    const estimatedDate = addHoursToNow(hoursRemaining);

    const optimisticVelocity = velocity + velocityStddev;
    const pessimisticVelocity = Math.max(velocity - velocityStddev, EPSILON);

    const optimisticHours = remainingGap / optimisticVelocity;
    const pessimisticHours = remainingGap / pessimisticVelocity;

    const confidenceInterval = {
      optimistic: addHoursToNow(optimisticHours),
      pessimistic: addHoursToNow(pessimisticHours),
    };

    // isAchievable is always true when there is no deadline to compare against;
    // callers that have a deadline should compare pessimistic date themselves.
    const isAchievable = true;

    return { estimatedDate, confidenceInterval, isAchievable };
  }

  suggestObservationInterval(pacingResult: PacingResult, baseIntervalMs: number): number {
    const { observation_interval_multipliers } = this.config;
    const status = pacingResult.status;
    let multiplier: number;
    switch (status) {
      case "critical":
        multiplier = observation_interval_multipliers.critical;
        break;
      case "behind":
        multiplier = observation_interval_multipliers.behind;
        break;
      case "on_track":
        multiplier = observation_interval_multipliers.on_track;
        break;
      case "ahead":
        multiplier = observation_interval_multipliers.ahead;
        break;
      case "no_deadline":
        multiplier = observation_interval_multipliers.no_deadline;
        break;
      default:
        multiplier = 1.0;
    }
    return baseIntervalMs * multiplier;
  }

  getTimeBudget(
    deadline: string | null,
    startTime: string,
    currentGap: number,
    initialGap: number,
    velocityPerHour: number
  ): TimeBudgetWithWait {
    const now = Date.now();
    const startMs = new Date(startTime).getTime();
    const elapsedHours = (now - startMs) / 3_600_000;

    let totalHours: number | null = null;
    let remainingHours: number | null = null;
    let percentElapsed: number | null = null;

    if (deadline !== null) {
      const deadlineMs = new Date(deadline).getTime();
      totalHours = (deadlineMs - startMs) / 3_600_000;
      remainingHours = (deadlineMs - now) / 3_600_000;
      percentElapsed = totalHours > 0 ? elapsedHours / totalHours : null;
    }

    const percentGapRemaining = initialGap > 0 ? currentGap / initialGap : 0;

    const criticalThreshold = this.config.pacing_thresholds.critical;
    const capturedRemainingHours = remainingHours;
    const capturedVelocity = velocityPerHour;
    const capturedCurrentGap = currentGap;

    const canAffordWait = (waitHours: number): boolean => {
      if (capturedVelocity <= 0) return false;
      if (capturedRemainingHours === null) return true; // no deadline, can always wait
      const newRemainingHours = capturedRemainingHours - waitHours;
      if (newRemainingHours <= 0) return false;
      const newRequiredVelocity = capturedCurrentGap / newRemainingHours;
      const newPacingRatio = newRequiredVelocity / Math.max(capturedVelocity, EPSILON);
      return newPacingRatio <= criticalThreshold;
    };

    return {
      totalHours,
      elapsedHours,
      remainingHours,
      percentElapsed,
      percentGapRemaining,
      canAffordWait,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private classifyStatus(pacingRatio: number): PacingStatus {
    const { ahead, behind, critical } = this.config.pacing_thresholds;
    if (pacingRatio < ahead) return "ahead";
    if (pacingRatio < behind) return "on_track";
    if (pacingRatio < critical) return "behind";
    return "critical";
  }

  private isVelocityDeclining(history: GapObservation[]): boolean {
    const { velocity_window_size, velocity_ema_alpha, sustainable_pace_decline_threshold } =
      this.config;
    if (history.length < 2) return false;

    const allVelocities = calcPointVelocities(history, history.length);
    const recentVelocities = calcPointVelocities(history, velocity_window_size);

    const historicalEma = calcEmaVelocity(allVelocities, velocity_ema_alpha);
    const recentEma = calcEmaVelocity(recentVelocities, velocity_ema_alpha);

    if (historicalEma <= 0) return true; // no positive historical velocity is itself a decline
    return recentEma < historicalEma * (1 - sustainable_pace_decline_threshold);
  }
}
