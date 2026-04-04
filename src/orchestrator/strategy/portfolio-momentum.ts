import type { MomentumInfo, MomentumTrend } from "../../base/types/cross-portfolio.js";

// ─── Momentum ───

/**
 * Calculate momentum for a single goal based on recent state snapshots.
 *
 * @param goalId — goal to evaluate
 * @param snapshots — array of recent progress values (0-1), ordered oldest → newest
 *                    (typically last 5 iterations). Minimum 2 values required.
 * @returns MomentumInfo
 */
export function calculateMomentum(goalId: string, snapshots: number[]): MomentumInfo {
  if (snapshots.length === 0) {
    return { goalId, recentProgress: 0, velocity: 0, trend: "stalled" };
  }

  if (snapshots.length === 1) {
    return { goalId, recentProgress: 0, velocity: 0, trend: "stalled" };
  }

  // recentProgress = total delta from first to last snapshot
  const recentProgress = snapshots[snapshots.length - 1]! - snapshots[0]!;

  // velocity = smoothed average per-step delta (EMA-style: weight recent steps more)
  const deltas: number[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    deltas.push(snapshots[i]! - snapshots[i - 1]!);
  }

  // Simple smoothed velocity: weighted average where later deltas have higher weight
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < deltas.length; i++) {
    const w = i + 1; // weight increases for more recent deltas
    weightedSum += deltas[i]! * w;
    weightTotal += w;
  }
  const velocity = weightTotal > 0 ? weightedSum / weightTotal : 0;

  // Trend detection:
  //   stalled:       velocity ≈ 0 (< 0.005)
  //   accelerating:  later half average > earlier half average
  //   decelerating:  later half average < earlier half average (by ≥ threshold)
  //   steady:        otherwise
  let trend: MomentumTrend;

  const STALL_THRESHOLD = 0.005;
  if (Math.abs(velocity) < STALL_THRESHOLD) {
    trend = "stalled";
  } else if (deltas.length >= 2) {
    const mid = Math.floor(deltas.length / 2);
    const earlyAvg = deltas.slice(0, mid).reduce((s, d) => s + d, 0) / mid;
    const lateAvg = deltas.slice(mid).reduce((s, d) => s + d, 0) / (deltas.length - mid);

    const ACCEL_THRESHOLD = 0.002;
    if (lateAvg > earlyAvg + ACCEL_THRESHOLD) {
      trend = "accelerating";
    } else if (lateAvg < earlyAvg - ACCEL_THRESHOLD) {
      trend = "decelerating";
    } else {
      trend = "steady";
    }
  } else {
    // Only 1 delta — classify by sign
    trend = velocity > 0 ? "steady" : "stalled";
  }

  return { goalId, recentProgress, velocity, trend };
}
