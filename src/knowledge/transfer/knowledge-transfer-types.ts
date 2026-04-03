import type { TransferCandidate } from "../../types/cross-portfolio.js";
import type { LearnedPattern } from "../../types/learning.js";
import type { StateManager } from "../../state/state-manager.js";

// ─── Internal Storage Types ───

export interface TransferContext {
  candidate: TransferCandidate;
  /** gap score at apply time (lower is better) */
  gap_at_apply: number;
  source_pattern: LearnedPattern | null;
}

/** Track consecutive neutral/negative outcomes per source pattern */
export interface PatternEffectivenessTracker {
  consecutive_non_positive: number;
  invalidated: boolean;
}

// ─── Shared Helper ───

/**
 * Estimate the current gap for a goal.
 * Returns 0.5 as a neutral default if goal state is unavailable.
 */
export async function estimateCurrentGap(
  goalId: string,
  stateManager: StateManager
): Promise<number> {
  try {
    const raw = await stateManager.readRaw(`goals/${goalId}/state.json`);
    if (raw && typeof raw === "object" && raw !== null) {
      const state = raw as Record<string, unknown>;
      if (typeof state["gap"] === "number") {
        return state["gap"] as number;
      }
      // Try gap_score from loop state
      if (typeof state["gap_score"] === "number") {
        return state["gap_score"] as number;
      }
    }
  } catch {
    // non-fatal
  }
  return 0.5;
}
