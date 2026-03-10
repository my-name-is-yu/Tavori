import { StateManager } from "./state-manager.js";
import { StallReportSchema, StallStateSchema } from "./types/stall.js";
import type { StallReport, StallState } from "./types/stall.js";

// ─── Feedback category → N loops mapping ───

const FEEDBACK_CATEGORY_N: Record<string, number> = {
  immediate: 3,
  medium_term: 5,
  long_term: 10,
};

const DEFAULT_N = 5;

// ─── Time thresholds ───

const DEFAULT_DURATION_HOURS_BY_CATEGORY: Record<string, number> = {
  coding: 2,
  implementation: 2,
  research: 4,
  investigation: 4,
};

const DEFAULT_DURATION_HOURS_FALLBACK = 3;

// ─── Stall thresholds ───

const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const ESCALATION_CAP = 3;

// ─── Decay factor constants ───

const DECAY_FACTOR_STALLED = 0.6;
const RECOVERY_SCHEDULE: Array<{ loops: number; factor: number }> = [
  { loops: 0, factor: 0.75 },
  { loops: 2, factor: 0.9 },
  { loops: 4, factor: 1.0 },
];

/**
 * StallDetector detects stalls (circuit breaker) in the Motiva orchestrator loop.
 * Supports 4 stall types: dimension_stall, time_exceeded, consecutive_failure, global_stall.
 */
export class StallDetector {
  private readonly stateManager: StateManager;

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  // ─── Public Methods ───

  /**
   * Check if a single dimension's gap has not improved for N loops.
   * N is determined by the feedbackCategory (immediate/medium_term/long_term).
   */
  checkDimensionStall(
    goalId: string,
    dimensionName: string,
    gapHistory: Array<{ normalized_gap: number }>,
    feedbackCategory?: string
  ): StallReport | null {
    const n = feedbackCategory
      ? (FEEDBACK_CATEGORY_N[feedbackCategory] ?? DEFAULT_N)
      : DEFAULT_N;

    if (gapHistory.length < n + 1) {
      // Not enough history to determine a stall
      return null;
    }

    const recent = gapHistory.slice(-n - 1);
    const oldest = recent[0].normalized_gap;
    const latest = recent[recent.length - 1].normalized_gap;

    // "No improvement" = latest gap is not less than the oldest (in the window)
    if (latest < oldest) {
      return null; // improved
    }

    const escalationLevel = this.getEscalationLevel(goalId, dimensionName);

    return StallReportSchema.parse({
      stall_type: "dimension_stall",
      goal_id: goalId,
      dimension_name: dimensionName,
      task_id: null,
      detected_at: new Date().toISOString(),
      escalation_level: escalationLevel,
      suggested_cause: "approach_failure",
      decay_factor: DECAY_FACTOR_STALLED,
    });
  }

  /**
   * Check if a task has exceeded its time threshold (estimate × 2, or default by category).
   */
  checkTimeExceeded(task: {
    task_id?: string;
    goal_id: string;
    estimated_duration?: { value: number; unit: string } | null;
    started_at?: string | null;
    task_category?: string;
  }): StallReport | null {
    if (!task.started_at) {
      return null;
    }

    const startedAt = new Date(task.started_at);
    const now = new Date();
    const elapsedMs = now.getTime() - startedAt.getTime();
    const elapsedHours = elapsedMs / (1000 * 60 * 60);

    const thresholdHours = this.computeTimeThreshold(task.estimated_duration, task.task_category);

    if (elapsedHours <= thresholdHours) {
      return null;
    }

    return StallReportSchema.parse({
      stall_type: "time_exceeded",
      goal_id: task.goal_id,
      dimension_name: null,
      task_id: task.task_id ?? null,
      detected_at: new Date().toISOString(),
      escalation_level: 0,
      suggested_cause: "external_dependency",
      decay_factor: DECAY_FACTOR_STALLED,
    });
  }

  /**
   * Check if a dimension has had 3+ consecutive failures.
   */
  checkConsecutiveFailures(
    goalId: string,
    dimensionName: string,
    consecutiveFailureCount: number
  ): StallReport | null {
    if (consecutiveFailureCount < CONSECUTIVE_FAILURE_THRESHOLD) {
      return null;
    }

    const escalationLevel = this.getEscalationLevel(goalId, dimensionName);

    return StallReportSchema.parse({
      stall_type: "consecutive_failure",
      goal_id: goalId,
      dimension_name: dimensionName,
      task_id: null,
      detected_at: new Date().toISOString(),
      escalation_level: escalationLevel,
      suggested_cause: "approach_failure",
      decay_factor: DECAY_FACTOR_STALLED,
    });
  }

  /**
   * Check if ALL dimensions show no improvement for loopThreshold loops.
   * Returns null if any dimension improved.
   */
  checkGlobalStall(
    goalId: string,
    allDimensionGaps: Map<string, Array<{ normalized_gap: number }>>,
    loopThreshold = DEFAULT_N
  ): StallReport | null {
    if (allDimensionGaps.size === 0) {
      return null;
    }

    for (const [, gapHistory] of allDimensionGaps) {
      if (gapHistory.length < loopThreshold + 1) {
        // Not enough data for this dimension — treat as not stalled (insufficient evidence)
        return null;
      }

      const recent = gapHistory.slice(-loopThreshold - 1);
      const oldest = recent[0].normalized_gap;
      const latest = recent[recent.length - 1].normalized_gap;

      if (latest < oldest) {
        // At least one dimension improved — not a global stall
        return null;
      }
    }

    // All dimensions are non-improving
    return StallReportSchema.parse({
      stall_type: "global_stall",
      goal_id: goalId,
      dimension_name: null,
      task_id: null,
      detected_at: new Date().toISOString(),
      escalation_level: 0,
      suggested_cause: "goal_infeasible",
      decay_factor: DECAY_FACTOR_STALLED,
    });
  }

  /**
   * Classify the root cause of a stall based on stall type and goal context.
   */
  classifyStallCause(
    stallType: string,
    goal: { dimensions?: Array<{ confidence?: number }> }
  ): string {
    // Check for low-confidence dimensions → information_deficit
    const hasLowConfidence = goal.dimensions?.some(
      (d) => d.confidence !== undefined && d.confidence < 0.5
    );

    if (hasLowConfidence) {
      return "information_deficit";
    }

    switch (stallType) {
      case "dimension_stall":
        return "approach_failure";

      case "time_exceeded":
        return "external_dependency";

      case "consecutive_failure":
        return "approach_failure";

      case "global_stall":
        return "goal_infeasible";

      default:
        return "approach_failure";
    }
  }

  /**
   * Compute the decay_factor for the dissatisfaction drive score.
   * - Stalled: 0.6
   * - Recently recovered: follows a schedule (0.75 → 0.90 → 1.0)
   * - Normal (not stalled, no recovery): 1.0
   */
  computeDecayFactor(isStalled: boolean, loopsSinceRecovery: number | null): number {
    if (isStalled) {
      return DECAY_FACTOR_STALLED;
    }

    if (loopsSinceRecovery === null) {
      // Not stalled, no recent recovery
      return 1.0;
    }

    // Recovery schedule: find the highest threshold that has been reached
    let factor = 1.0;
    for (const { loops, factor: scheduledFactor } of RECOVERY_SCHEDULE) {
      if (loopsSinceRecovery >= loops) {
        factor = scheduledFactor;
      }
    }

    return factor;
  }

  /**
   * Returns true if the plateau_until date is in the future (stall detection suppressed).
   */
  isSuppressed(plateauUntil: string | null): boolean {
    if (plateauUntil === null) {
      return false;
    }

    const until = new Date(plateauUntil);
    const now = new Date();
    return now < until;
  }

  /**
   * Load the StallState for a goal from StateManager.
   * Returns a default state if not found.
   */
  getStallState(goalId: string): StallState {
    const raw = this.stateManager.readRaw(`stalls/${goalId}.json`);
    if (raw === null) {
      return StallStateSchema.parse({
        goal_id: goalId,
        dimension_escalation: {},
        global_escalation: 0,
        decay_factors: {},
        recovery_loops: {},
      });
    }

    return StallStateSchema.parse(raw);
  }

  /**
   * Persist the StallState for a goal via StateManager.
   */
  saveStallState(goalId: string, state: StallState): void {
    const parsed = StallStateSchema.parse(state);
    this.stateManager.writeRaw(`stalls/${goalId}.json`, parsed);
  }

  /**
   * Get the current escalation level for a dimension (default: 0).
   */
  getEscalationLevel(goalId: string, dimensionName: string): number {
    const state = this.getStallState(goalId);
    return state.dimension_escalation[dimensionName] ?? 0;
  }

  /**
   * Increment the escalation level for a dimension (cap at ESCALATION_CAP).
   * Persists and returns the new level.
   */
  incrementEscalation(goalId: string, dimensionName: string): number {
    const state = this.getStallState(goalId);
    const current = state.dimension_escalation[dimensionName] ?? 0;
    const next = Math.min(current + 1, ESCALATION_CAP);
    state.dimension_escalation[dimensionName] = next;
    this.saveStallState(goalId, state);
    return next;
  }

  /**
   * Reset the escalation level for a dimension to 0 and persist.
   */
  resetEscalation(goalId: string, dimensionName: string): void {
    const state = this.getStallState(goalId);
    state.dimension_escalation[dimensionName] = 0;
    this.saveStallState(goalId, state);
  }

  // ─── Private Helpers ───

  /**
   * Compute the time threshold in hours for a task.
   */
  private computeTimeThreshold(
    estimatedDuration: { value: number; unit: string } | null | undefined,
    taskCategory?: string
  ): number {
    if (estimatedDuration) {
      const estimatedHours = this.durationToHours(estimatedDuration);
      return estimatedHours * 2;
    }

    if (taskCategory) {
      const defaultHours = DEFAULT_DURATION_HOURS_BY_CATEGORY[taskCategory];
      if (defaultHours !== undefined) {
        return defaultHours;
      }
    }

    return DEFAULT_DURATION_HOURS_FALLBACK;
  }

  /**
   * Convert a duration object to hours.
   */
  private durationToHours(duration: { value: number; unit: string }): number {
    switch (duration.unit) {
      case "minutes":
        return duration.value / 60;
      case "hours":
        return duration.value;
      case "days":
        return duration.value * 24;
      case "weeks":
        return duration.value * 24 * 7;
      default:
        return duration.value; // assume hours as fallback
    }
  }
}
