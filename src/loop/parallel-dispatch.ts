/**
 * parallel-dispatch.ts
 *
 * Attempt TaskGroup decomposition and parallel execution.
 *
 * Returns a ParallelExecutionResult when the parallel path ran successfully,
 * or null when the caller should fall through to the normal single-task cycle.
 * Updates result.taskResult with a synthetic entry reflecting the parallel outcome.
 */

import type { Goal } from "../types/goal.js";
import type { CoreLoopDeps } from "./core-loop-types.js";
import type { LoopIterationResult } from "./core-loop-types.js";
import type { ParallelExecutionResult } from "../execution/parallel-executor.js";
import type { Logger } from "../runtime/logger.js";

export async function tryRunParallel(
  goalId: string,
  goal: Goal,
  gapAggregate: number,
  result: LoopIterationResult,
  startTime: number,
  deps: CoreLoopDeps,
  logger: Logger | undefined
): Promise<ParallelExecutionResult | null> {
  const { parallelExecutor, generateTaskGroupFn, adapterRegistry } = deps;
  if (!parallelExecutor || !generateTaskGroupFn) return null;

  // Only attempt parallel decomposition for multi-dimension goals (heuristic for "large")
  if (goal.dimensions.length < 2) return null;

  const topDimension = goal.dimensions[0]?.name ?? "";
  const currentState = String(goal.dimensions[0]?.current_value ?? "unknown");
  const availableAdapters = adapterRegistry?.listAdapters() ?? ["default"];

  const contextBlock = deps.contextProvider
    ? await deps.contextProvider(goalId, topDimension).catch(() => undefined)
    : undefined;

  let group: import("../types/index.js").TaskGroup | null = null;
  try {
    group = await generateTaskGroupFn({
      goalDescription: goal.title ?? goal.id,
      targetDimension: topDimension,
      currentState,
      gap: gapAggregate,
      availableAdapters,
      contextBlock,
    });
  } catch (err) {
    logger?.warn("CoreLoop: generateTaskGroupFn threw, falling back to single-task", {
      goalId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!group) {
    // LLM chose not to decompose — fall through to normal flow
    return null;
  }

  logger?.info("CoreLoop: TaskGroup detected, routing to ParallelExecutor", {
    goalId,
    subtaskCount: group.subtasks.length,
  });

  // Determine active strategy for feedback
  let strategyId: string | undefined;
  try {
    const activeStrategy = await deps.strategyManager.getActiveStrategy(goalId);
    strategyId = activeStrategy?.id;
  } catch (err) {
    logger?.warn("CoreLoop: strategyManager.getActiveStrategy failed", {
      goalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let parallelResult: ParallelExecutionResult;
  try {
    parallelResult = await parallelExecutor.execute(group, { goalId, strategy_id: strategyId });
  } catch (err) {
    logger?.error("CoreLoop: ParallelExecutor threw, falling back to single-task", {
      goalId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Map parallel outcome to a synthetic TaskCycleResult so downstream
  // logic (reporting, portfolio recording) can work without branching.
  const syntheticTask = group.subtasks[0];
  if (syntheticTask) {
    const action =
      parallelResult.overall_verdict === "pass"
        ? "completed"
        : parallelResult.overall_verdict === "partial"
        ? "keep"
        : "escalate";

    const confidence = parallelResult.overall_verdict === "pass" ? 0.9 : 0.4;
    const now = new Date().toISOString();

    result.taskResult = {
      task: syntheticTask,
      verificationResult: {
        task_id: syntheticTask.id,
        verdict: parallelResult.overall_verdict,
        confidence,
        evidence: parallelResult.results.map((r) => ({
          layer: "mechanical" as const,
          description: r.output || `subtask ${r.task_id}: ${r.verdict}`,
          confidence,
        })),
        dimension_updates: [],
        timestamp: now,
      },
      action,
    };
  }

  result.elapsedMs = Date.now() - startTime;
  return parallelResult;
}
