import type { Goal } from "../../base/types/goal.js";
import type { PaceSnapshot } from "../../base/types/goal.js";
import type { RescheduleOptions } from "../../base/types/state.js";

/**
 * Returns all goals with node_type === "milestone".
 */
export function getMilestones(goals: Goal[]): Goal[] {
  return goals.filter((g) => g.node_type === "milestone");
}

/**
 * Returns milestones whose target_date is in the past (overdue).
 * Goals without a target_date are excluded.
 */
export function getOverdueMilestones(goals: Goal[]): Goal[] {
  const now = new Date();
  return getMilestones(goals).filter((g) => {
    if (!g.target_date) return false;
    return new Date(g.target_date) < now;
  });
}

/**
 * Evaluate pace for a milestone goal.
 * currentAchievement (0-1) is computed by the caller (e.g. from SatisficingJudge).
 *
 * Pace evaluation logic (state-vector.md §8):
 *   elapsed_ratio = time_elapsed / total_duration   (creation → target_date)
 *   achievement_ratio = currentAchievement          (0-1)
 *   pace_ratio = achievement_ratio / elapsed_ratio  (guard divide-by-zero)
 *   on_track: pace_ratio >= 0.8
 *   at_risk:  pace_ratio >= 0.5
 *   behind:   pace_ratio < 0.5
 *
 * If no target_date is set, returns on_track with pace_ratio = 1.
 */
export function evaluatePace(milestone: Goal, currentAchievement: number): PaceSnapshot {
  const now = new Date();
  const evaluatedAt = now.toISOString();

  if (!milestone.target_date) {
    return {
      elapsed_ratio: 0,
      achievement_ratio: currentAchievement,
      pace_ratio: 1,
      status: "on_track",
      evaluated_at: evaluatedAt,
    };
  }

  const createdAt = new Date(milestone.created_at).getTime();
  const targetDate = new Date(milestone.target_date).getTime();
  const totalDuration = targetDate - createdAt;

  // If total_duration is 0 or negative (target_date <= created_at), treat as elapsed
  if (totalDuration <= 0) {
    const paceRatio = currentAchievement;
    const status = paceRatio >= 0.8 ? "on_track" : paceRatio >= 0.5 ? "at_risk" : "behind";
    return {
      elapsed_ratio: 1,
      achievement_ratio: currentAchievement,
      pace_ratio: paceRatio,
      status,
      evaluated_at: evaluatedAt,
    };
  }

  const elapsed = now.getTime() - createdAt;
  const elapsedRatio = Math.min(elapsed / totalDuration, 1);

  const ONE_SECOND_MS = 1000;
  let paceRatio: number;
  if (elapsed < ONE_SECOND_MS) {
    // Sub-second elapsed — treat as on_track to avoid flaky timing issues
    paceRatio = 1;
  } else {
    paceRatio = currentAchievement / elapsedRatio;
  }

  const status =
    paceRatio >= 0.8 ? "on_track" : paceRatio >= 0.5 ? "at_risk" : "behind";

  return {
    elapsed_ratio: elapsedRatio,
    achievement_ratio: currentAchievement,
    pace_ratio: paceRatio,
    status,
    evaluated_at: evaluatedAt,
  };
}

/**
 * Generate reschedule options when a milestone is behind.
 * Always returns 3 options: extend_deadline, reduce_target, renegotiate.
 */
export function generateRescheduleOptions(milestone: Goal, currentAchievement: number): RescheduleOptions {
  const snapshot = evaluatePace(milestone, currentAchievement);
  const now = new Date();

  // Extend deadline: add half the remaining duration
  let extendedDate: string | null = null;
  if (milestone.target_date) {
    const targetMs = new Date(milestone.target_date).getTime();
    const createdMs = new Date(milestone.created_at).getTime();
    const totalDuration = targetMs - createdMs;
    const halfDuration = Math.max(totalDuration * 0.5, 7 * 24 * 60 * 60 * 1000); // at least 7 days
    extendedDate = new Date(targetMs + halfDuration).toISOString();
  }

  // Reduce target: scale current threshold by currentAchievement + buffer
  let reducedTargetValue: number | null = null;
  const firstNumericDim = milestone.dimensions.find(
    (d) => typeof d.current_value === "number" && d.threshold.type === "min"
  );
  if (firstNumericDim && firstNumericDim.threshold.type === "min") {
    const originalTarget = firstNumericDim.threshold.value;
    reducedTargetValue = Math.round(originalTarget * Math.max(currentAchievement + 0.1, 0.5));
  }

  return {
    milestone_id: milestone.id,
    goal_id: milestone.parent_id ?? milestone.id,
    current_pace: snapshot.status,
    options: [
      {
        option_type: "extend_deadline",
        description: `Extend the deadline to give more time to reach the original target`,
        new_target_date: extendedDate,
        new_target_value: null,
      },
      {
        option_type: "reduce_target",
        description: `Lower the target value to match current pace`,
        new_target_date: null,
        new_target_value: reducedTargetValue,
      },
      {
        option_type: "renegotiate",
        description: `Trigger full goal renegotiation to reassess feasibility`,
        new_target_date: null,
        new_target_value: null,
      },
    ],
    generated_at: now.toISOString(),
  };
}
