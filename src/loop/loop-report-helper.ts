/**
 * loop-report-helper.ts
 *
 * Helper to generate and save a per-iteration execution report inside CoreLoop.
 */

import type { Goal } from "../types/goal.js";
import type { ReportingEngine, LoopIterationResult } from "./core-loop-types.js";
import type { Logger } from "../runtime/logger.js";
import { dimensionProgress } from "../drive/gap-calculator.js";

/**
 * Generate and save an execution summary report for one iteration.
 * Non-fatal: report generation failures are logged and swallowed.
 */
export async function generateLoopReport(
  goalId: string,
  loopIndex: number,
  iterationResult: LoopIterationResult,
  goal: Goal,
  reportingEngine: ReportingEngine,
  logger: Logger | undefined
): Promise<void> {
  try {
    const observation = goal.dimensions.map((d) => {
      const prog = dimensionProgress(d.current_value, d.threshold);
      let progress: number;
      if (prog !== null) {
        progress = prog;
      } else if (typeof d.current_value === "number") {
        progress = d.current_value;
      } else {
        progress = 0;
      }
      return {
        dimensionName: d.name,
        progress,
        confidence: d.confidence,
      };
    });

    const taskResult =
      iterationResult.taskResult !== null
        ? {
            taskId: iterationResult.taskResult.task.id,
            action: iterationResult.taskResult.action,
            dimension: iterationResult.taskResult.task.primary_dimension,
          }
        : null;

    const report = reportingEngine.generateExecutionSummary({
      goalId,
      loopIndex,
      observation,
      gapAggregate: iterationResult.gapAggregate,
      taskResult,
      stallDetected: iterationResult.stallDetected,
      pivotOccurred: iterationResult.pivotOccurred,
      elapsedMs: iterationResult.elapsedMs,
    });
    await reportingEngine.saveReport(report);
  } catch (err) {
    logger?.warn("CoreLoop: report generation failed", {
      goalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
