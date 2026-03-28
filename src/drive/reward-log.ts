/**
 * reward-log.ts
 *
 * Consolidated JSON log output for the reward (drive score) computation.
 * Controlled by the PULSEED_REWARD_LOG environment variable.
 *
 * Usage:
 *   PULSEED_REWARD_LOG=1 pulseed run <goal>
 *
 * Each log line is a single JSON object written to stderr so it does not
 * pollute stdout / TUI output. Default: OFF.
 */

import type { DriveScore } from "../types/drive.js";
import type { CompletionJudgment } from "../types/satisficing.js";

export interface RewardLogEntry {
  ts: string;
  goal_id: string;
  iteration: number;
  gap_aggregate: number;
  confidence_avg: number;
  trust_score: number | null;
  drive_scores: Array<{
    dimension: string;
    dissatisfaction: number;
    deadline: number;
    opportunity: number;
    final_score: number;
    dominant_drive: string;
  }>;
  top_dimension: string | null;
  is_complete: boolean;
  blocking_dimensions: string[];
}

/**
 * Returns true when PULSEED_REWARD_LOG=1 is set in the environment.
 */
export function isRewardLogEnabled(): boolean {
  return process.env["PULSEED_REWARD_LOG"] === "1";
}

/**
 * Emit a single JSON line to stderr with all major reward computation inputs/outputs.
 * No-op when PULSEED_REWARD_LOG is not set to "1".
 */
export function logRewardComputation(params: {
  goalId: string;
  iteration: number;
  gapAggregate: number;
  confidenceAvg: number;
  trustScore: number | null;
  driveScores: DriveScore[];
  completionJudgment: CompletionJudgment | null;
}): void {
  if (!isRewardLogEnabled()) return;

  const entry: RewardLogEntry = {
    ts: new Date().toISOString(),
    goal_id: params.goalId,
    iteration: params.iteration,
    gap_aggregate: params.gapAggregate,
    confidence_avg: params.confidenceAvg,
    trust_score: params.trustScore,
    drive_scores: params.driveScores.map((s) => ({
      dimension: s.dimension_name,
      dissatisfaction: s.dissatisfaction,
      deadline: s.deadline,
      opportunity: s.opportunity,
      final_score: s.final_score,
      dominant_drive: s.dominant_drive,
    })),
    // assumes driveScores sorted by score desc (caller contract)
    top_dimension: params.driveScores[0]?.dimension_name ?? null,
    is_complete: params.completionJudgment?.is_complete ?? false,
    blocking_dimensions: params.completionJudgment?.blocking_dimensions ?? [],
  };

  process.stderr.write(JSON.stringify(entry) + "\n");
}
