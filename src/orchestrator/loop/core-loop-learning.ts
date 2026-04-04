/**
 * core-loop-learning.ts
 *
 * Encapsulates learning/transfer/capability-acquisition state and logic
 * extracted from CoreLoop. Holds three fields that were previously inline on
 * CoreLoop and exposes methods used in run() and runOneIteration().
 */

import type { Logger } from "../../runtime/logger.js";
import type { CoreLoopDeps } from "./core-loop-types.js";

export class CoreLoopLearning {
  private lastLearningReviewAt: number = Date.now();
  private transferCheckCounter: number = 0;
  /** Tracks consecutive capability acquisition failures per capability name */
  private capabilityAcquisitionFailures: Map<string, number> = new Map();

  getCapabilityFailures(): Map<string, number> {
    return this.capabilityAcquisitionFailures;
  }

  incrementTransferCounter(): number {
    return ++this.transferCheckCounter;
  }

  /**
   * Returns the periodic learning review interval in milliseconds based on
   * how much time remains until the goal's target_date.
   */
  async getPeriodicReviewInterval(
    goalId: string,
    stateManager: CoreLoopDeps["stateManager"]
  ): Promise<number> {
    const goal = await stateManager.loadGoal(goalId);
    if (!goal?.target_date) {
      return 72 * 3600 * 1000; // default: 72 hours
    }
    const remainingDays =
      (new Date(goal.target_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (remainingDays <= 30) return 72 * 3600 * 1000;   // 短期: 72h
    if (remainingDays <= 180) return 168 * 3600 * 1000; // 中期: 1week
    return 336 * 3600 * 1000;                           // 長期: 2weeks
  }

  /**
   * Checks whether it is time to run a periodic learning review and, if so,
   * calls learningPipeline.onPeriodicReview(). Non-fatal — errors are logged
   * but do not bubble up.
   */
  async checkPeriodicReview(
    goalId: string,
    deps: CoreLoopDeps,
    logger: Logger | undefined
  ): Promise<void> {
    if (!deps.learningPipeline) return;

    const now = Date.now();
    const intervalMs = await this.getPeriodicReviewInterval(goalId, deps.stateManager);
    if (now - this.lastLearningReviewAt >= intervalMs) {
      try {
        await deps.learningPipeline.onPeriodicReview(goalId);
        this.lastLearningReviewAt = now;
      } catch (err) {
        // non-fatal: learning pipeline failure should not block main loop
        logger?.warn("CoreLoop: learningPipeline.onPeriodicReview failed", {
          goalId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Called after the run loop completes with finalStatus === "completed".
   * Triggers learningPipeline.onGoalCompleted(). Non-fatal.
   */
  async onGoalCompleted(
    goalId: string,
    deps: CoreLoopDeps,
    logger: Logger | undefined
  ): Promise<void> {
    if (!deps.learningPipeline) return;

    try {
      await deps.learningPipeline.onGoalCompleted(goalId);
    } catch (err) {
      // non-fatal
      logger?.warn("CoreLoop: learningPipeline.onGoalCompleted failed", {
        goalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
