import type { Logger } from "../../runtime/logger.js";
import type { StateDiffCalculator, IterationSnapshot } from "./state-diff.js";
import { tryRunParallel } from "./parallel-dispatch.js";
import { generateLoopReport } from "./loop-report-helper.js";
import type {
  ResolvedLoopConfig,
  LoopIterationResult,
  CoreLoopDeps,
} from "./core-loop-types.js";
import type { Goal } from "../../base/types/goal.js";

// ─── State diff check ───

export interface StateDiffState {
  previousSnapshot: IterationSnapshot | null;
  consecutiveSkips: number;
}

/**
 * Runs the state diff check for a loop iteration.
 *
 * Returns an object indicating whether to skip the rest of the iteration.
 * When `shouldSkip` is true, `result` has been fully populated with skip info
 * and the caller should return it immediately.
 * When `shouldSkip` is false, the loop should continue normally.
 */
export async function runStateDiffCheck(
  stateDiff: StateDiffCalculator,
  stateDiffStateMap: Map<string, StateDiffState>,
  goalId: string,
  goal: Goal,
  loopIndex: number,
  config: ResolvedLoopConfig,
  deps: CoreLoopDeps,
  result: LoopIterationResult,
  startTime: number,
  logger?: Logger
): Promise<{ shouldSkip: boolean }> {
  const diffState = stateDiffStateMap.get(goalId) ?? { previousSnapshot: null, consecutiveSkips: 0 };
  const snapshot = stateDiff.buildSnapshot(goal, loopIndex);
  const diff = stateDiff.compare(diffState.previousSnapshot, snapshot);
  diffState.previousSnapshot = snapshot;

  if (!diff.hasChange && diffState.consecutiveSkips < config.maxConsecutiveSkips) {
    diffState.consecutiveSkips++;
    stateDiffStateMap.set(goalId, diffState);
    logger?.info(
      `[CoreLoop] iteration ${loopIndex} skipped: no state change detected ` +
      `(consecutiveSkips=${diffState.consecutiveSkips}/${config.maxConsecutiveSkips})`,
      { goalId }
    );
    result.skipped = true;
    result.skipReason = "no_state_change";
    deps.onProgress?.({
      iteration: loopIndex + 1,
      maxIterations: config.maxIterations,
      phase: "Skipped",
      skipReason: result.skipReason,
    });
    // Carry forward completion status from the already-loaded goal so a
    // completed goal is not forced through 5 more iterations.
    const goalState = await deps.stateManager.loadGoal(goalId);
    if (goalState?.status === "completed") {
      result.completionJudgment.is_complete = true;
    }
    deps.onProgress?.({
      iteration: loopIndex + 1,
      maxIterations: config.maxIterations,
      phase: "Skipped (no state change)",
    });
    result.elapsedMs = Date.now() - startTime;
    return { shouldSkip: true };
  }

  // Reset skip counter — full loop is running
  diffState.consecutiveSkips = 0;
  stateDiffStateMap.set(goalId, diffState);
  if (!diff.hasChange) {
    logger?.info(
      `[CoreLoop] max consecutive skips reached (${config.maxConsecutiveSkips}), ` +
      "forcing full iteration for stall detection",
      { goalId }
    );
  }
  return { shouldSkip: false };
}

// ─── Parallel execution check ───

/**
 * Attempts to run the iteration in parallel (TaskGroup mode).
 *
 * Returns `true` if the parallel path was taken (caller should return result),
 * `false` if parallel was skipped/unavailable (fall through to normal task cycle).
 */
export async function tryParallelExecution(
  goalId: string,
  goal: Goal,
  gapAggregate: number,
  result: LoopIterationResult,
  startTime: number,
  deps: CoreLoopDeps,
  loopIndex: number,
  logger?: Logger
): Promise<boolean> {
  if (!deps.parallelExecutor || !deps.generateTaskGroupFn) {
    return false;
  }
  const parallelResult = await tryRunParallel(
    goalId, goal, gapAggregate, result, startTime, deps, logger
  );
  if (parallelResult !== null) {
    // Parallel path completed — skip normal task cycle
    await generateLoopReport(goalId, loopIndex, result, goal, deps.reportingEngine, logger);
    result.elapsedMs = Date.now() - startTime;
    return true;
  }
  return false;
}
