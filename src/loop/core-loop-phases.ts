/**
 * core-loop-phases.ts
 *
 * Phases 1–4 of CoreLoop.runOneIteration() as standalone functions.
 * Each function accepts a PhaseCtx (deps + config + logger) plus phase-specific
 * parameters. They mutate `result` by reference and return values as documented.
 *
 * Phases 5–7 are in core-loop-phases-b.ts.
 */

import type { Logger } from "../runtime/logger.js";
import type { Goal } from "../types/goal.js";
import type { GapVector } from "../types/gap.js";
import type { DriveScore } from "../types/drive.js";
import {
  buildDriveContext,
  type CoreLoopDeps,
  type LoopConfig,
  type LoopIterationResult,
} from "./core-loop-types.js";

/** Minimal context passed to every phase function. */
export interface PhaseCtx {
  deps: CoreLoopDeps;
  config: Required<LoopConfig>;
  logger: Logger | undefined;
}

// ─── Phase 1 ───

/** Load goal from state, apply tree aggregation if applicable.
 * Returns the loaded Goal, or null if an error occurred (result is mutated). */
export async function loadGoalWithAggregation(
  ctx: PhaseCtx,
  goalId: string,
  result: LoopIterationResult,
  startTime: number
): Promise<Goal | null> {
  let goal: Goal;
  try {
    const loaded = await ctx.deps.stateManager.loadGoal(goalId);
    if (!loaded) {
      result.error = `Goal "${goalId}" not found`;
      result.elapsedMs = Date.now() - startTime;
      return null;
    }
    goal = loaded;
  } catch (err) {
    result.error = `Failed to load goal: ${err instanceof Error ? err.message : String(err)}`;
    ctx.logger?.error(`CoreLoop: ${result.error}`, { goalId });
    result.elapsedMs = Date.now() - startTime;
    return null;
  }

  // Tree aggregation
  if (ctx.deps.stateAggregator && goal.children_ids.length > 0) {
    try {
      await ctx.deps.stateAggregator.aggregateChildStates(goalId);
      const reloaded = await ctx.deps.stateManager.loadGoal(goalId);
      if (reloaded) goal = reloaded;
    } catch {
      // Tree aggregation failure is non-fatal
    }
  }

  return goal;
}

// ─── Phase 2 ───

/** Run observation engine, reload goal after observation.
 * Observation failure is non-fatal — returns current goal state. */
export async function observeAndReload(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  loopIndex: number
): Promise<Goal> {
  ctx.deps.onProgress?.({
    iteration: loopIndex + 1,
    maxIterations: ctx.config.maxIterations,
    phase: "Observing...",
  });
  try {
    const engine = ctx.deps.observationEngine as unknown as {
      observe?: (goalId: string, methods: unknown[]) => Promise<void> | void;
      getDataSources?: () => Array<{ sourceId: string }>;
    };

    ctx.logger?.debug("CoreLoop: engine.getDataSources exists", { exists: typeof engine.getDataSources === "function" });
    const dataSources = typeof engine.getDataSources === "function"
      ? engine.getDataSources()
      : [];
    ctx.logger?.debug("CoreLoop: observation setup", { dataSourceCount: dataSources.length });

    if (typeof engine.observe === "function") {
      await engine.observe(goalId, []);
    }

    const reloaded = await ctx.deps.stateManager.loadGoal(goalId);
    if (reloaded) return reloaded;
  } catch (err) {
    ctx.logger?.warn("CoreLoop: observation failed (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
  }
  return goal;
}

// ─── Phase 3 ───

/** Calculate gap vector and aggregate. Returns null if gap is zero
 * (result is mutated with early completion) or on error. */
export async function calculateGapOrComplete(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  loopIndex: number,
  result: LoopIterationResult,
  startTime: number
): Promise<{ gapVector: GapVector; gapAggregate: number } | null> {
  let gapVector: GapVector;
  let gapAggregate: number;
  try {
    gapVector = ctx.deps.gapCalculator.calculateGapVector(
      goalId,
      goal.dimensions,
      goal.uncertainty_weight
    );
    const gapValues = gapVector.gaps.map((g) => g.normalized_weighted_gap);
    gapAggregate = ctx.deps.gapCalculator.aggregateGaps(
      gapValues,
      goal.gap_aggregation
    );
    result.gapAggregate = gapAggregate;

    await ctx.deps.stateManager.appendGapHistoryEntry(goalId, {
      iteration: loopIndex,
      timestamp: new Date().toISOString(),
      gap_vector: gapVector.gaps.map((g) => ({
        dimension_name: g.dimension_name,
        normalized_weighted_gap: g.normalized_weighted_gap,
      })),
      confidence_vector: gapVector.gaps.map((g) => ({
        dimension_name: g.dimension_name,
        confidence: g.confidence,
      })),
    });
  } catch (err) {
    result.error = `Gap calculation failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.logger?.error(`CoreLoop: ${result.error}`, { goalId });
    result.elapsedMs = Date.now() - startTime;
    return null;
  }

  // Gap zero check — goal already satisfied
  if (gapAggregate === 0) {
    ctx.logger?.info(`[CoreLoop] gap=0 for goal ${goalId} — skipping task generation`);
    result.completionJudgment = {
      is_complete: true,
      blocking_dimensions: [],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    };
    result.elapsedMs = Date.now() - startTime;
    return null;
  }

  ctx.deps.onProgress?.({
    iteration: loopIndex + 1,
    maxIterations: ctx.config.maxIterations,
    phase: "Generating task...",
    gap: gapAggregate,
  });

  return { gapVector, gapAggregate };
}

// ─── Phase 4 ───

/** Score drives, update DriveScoreAdapter, check knowledge gap.
 * Returns ranked DriveScores, or null if the caller should return result early
 * (knowledge gap task generated or drive scoring failed). */
export async function scoreDrivesAndCheckKnowledge(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  gapVector: GapVector,
  loopIndex: number,
  result: LoopIterationResult,
  startTime: number,
  tryGenerateReport: (goalId: string, loopIndex: number, result: LoopIterationResult, goal: Goal) => void
): Promise<DriveScore[] | null> {
  let driveScores: DriveScore[];
  try {
    const driveContext = buildDriveContext(goal);
    driveScores = ctx.deps.driveScorer.scoreAllDimensions(gapVector, driveContext);
    const rankedScores = ctx.deps.driveScorer.rankDimensions(driveScores);
    result.driveScores = rankedScores;
    driveScores = rankedScores;

    if (ctx.deps.driveScoreAdapter) {
      ctx.deps.driveScoreAdapter.update(driveScores);
    }
  } catch (err) {
    result.error = `Drive scoring failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.logger?.error(`CoreLoop: ${result.error}`, { goalId });
    result.elapsedMs = Date.now() - startTime;
    return null;
  }

  // Knowledge gap check
  if (ctx.deps.knowledgeManager) {
    try {
      let strategies: unknown[] | null = null;
      try {
        const portfolio = await ctx.deps.strategyManager.getPortfolio(goalId);
        strategies = portfolio !== null ? portfolio.strategies : null;
      } catch {
        // If strategy loading fails, leave as null
      }

      const observationContext = {
        observations: goal.dimensions.map((d) => ({
          name: d.name,
          current_value: d.current_value,
          confidence: d.confidence,
        })),
        strategies,
        confidence: gapVector.gaps.reduce((sum, g) => sum + g.confidence, 0) /
          Math.max(gapVector.gaps.length, 1),
      };

      const gapSignal = await ctx.deps.knowledgeManager.detectKnowledgeGap(observationContext);
      if (gapSignal !== null) {
        const acquisitionTask = await ctx.deps.knowledgeManager.generateAcquisitionTask(
          gapSignal,
          goalId
        );
        const acquisitionVerification = {
          task_id: acquisitionTask.id,
          verdict: "pass" as const,
          confidence: 0.9,
          evidence: [
            {
              layer: "mechanical" as const,
              description: "Knowledge acquisition task generated for gap: " + gapSignal.signal_type,
              confidence: 0.9,
            },
          ],
          dimension_updates: [],
          timestamp: new Date().toISOString(),
        };
        result.taskResult = {
          task: acquisitionTask,
          verificationResult: acquisitionVerification,
          action: "completed",
        };
        tryGenerateReport(goalId, loopIndex, result, goal);
        result.elapsedMs = Date.now() - startTime;
        return null;
      }
    } catch {
      // Knowledge gap detection failure is non-fatal
    }
  }

  return driveScores;
}
