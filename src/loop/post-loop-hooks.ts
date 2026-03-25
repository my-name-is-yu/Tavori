/**
 * post-loop-hooks.ts
 *
 * Post-loop side effects executed at the end of CoreLoop.run():
 *   - Curiosity trigger evaluation
 *   - Learning pipeline (goal completion)
 *   - Memory lifecycle close
 *   - Goal archive
 *   - Final run report generation
 */

import type { CoreLoopDeps, ResolvedLoopConfig, LoopResult, LoopIterationResult } from "./core-loop-types.js";
import type { Goal } from "../types/goal.js";
import type { Logger } from "../runtime/logger.js";

export interface PostLoopHooksParams {
  goalId: string;
  finalStatus: LoopResult["finalStatus"];
  iterations: LoopIterationResult[];
  deps: CoreLoopDeps;
  config: ResolvedLoopConfig;
  logger: Logger | undefined;
  tryGenerateReport: (
    goalId: string,
    loopIndex: number,
    iterationResult: LoopIterationResult,
    goal: Goal
  ) => Promise<void>;
}

/**
 * Run all post-loop hooks in sequence. Each hook is non-fatal.
 */
export async function runPostLoopHooks(params: PostLoopHooksParams): Promise<void> {
  const { goalId, finalStatus, iterations, deps, config, logger, tryGenerateReport } = params;

  // Persist final status to disk before post-loop hooks
  if (finalStatus === "completed" && !config.dryRun) {
    try {
      const goalState = await deps.stateManager.loadGoal(goalId);
      if (goalState) {
        goalState.status = "completed";
        await deps.stateManager.saveGoal(goalState);
      }
    } catch (err) {
      logger?.warn("CoreLoop: failed to persist final status", {
        goalId,
        finalStatus,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Curiosity trigger evaluation
  if (deps.curiosityEngine && (finalStatus === "completed" || finalStatus === "max_iterations")) {
    try {
      deps.curiosityEngine.checkAutoExpiration();
      const currentGoal = await deps.stateManager.loadGoal(goalId);
      if (currentGoal) {
        const allGoals = [currentGoal];
        if (await deps.curiosityEngine.shouldExplore(allGoals)) {
          const triggers = await deps.curiosityEngine.evaluateTriggers(allGoals);
          if (triggers.length > 0) {
            await deps.curiosityEngine.generateProposals(triggers, allGoals);
          }
        }
      }
    } catch (err) {
      logger?.warn("CoreLoop: curiosity evaluation failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Learning pipeline — goal completion callback handled by CoreLoopLearning caller
  // (onGoalCompleted is called from CoreLoop.run() after this function, to keep
  //  CoreLoopLearning state inside CoreLoop. This hook only handles non-learning side effects.)

  // Memory lifecycle close on completion
  if (deps.memoryLifecycleManager && finalStatus === "completed") {
    try {
      await deps.memoryLifecycleManager.onGoalClose(goalId, "completed");
    } catch (err) {
      logger?.warn("CoreLoop: memoryLifecycleManager.onGoalClose failed", {
        goalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Archive goal state on completion (only when autoArchive is explicitly enabled)
  if (finalStatus === "completed" && config.autoArchive && !config.dryRun) {
    try {
      await deps.stateManager.archiveGoal(goalId);
    } catch (err) {
      logger?.warn("CoreLoop: stateManager.archiveGoal failed", {
        goalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Final run report for non-completed exits
  if (finalStatus !== "completed" && iterations.length > 0) {
    try {
      const finalGoal = await deps.stateManager.loadGoal(goalId);
      if (finalGoal) {
        const lastIteration = iterations[iterations.length - 1]!;
        await tryGenerateReport(goalId, lastIteration.loopIndex, lastIteration, finalGoal);
      }
    } catch (err) {
      logger?.warn("CoreLoop: final run report generation failed", {
        goalId,
        finalStatus,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
