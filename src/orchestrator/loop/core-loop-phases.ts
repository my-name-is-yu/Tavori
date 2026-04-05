/**
 * core-loop-phases.ts
 *
 * Phases 1–4 of CoreLoop.runOneIteration() as standalone functions.
 * Each function accepts a PhaseCtx (deps + config + logger) plus phase-specific
 * parameters. They mutate `result` by reference and return values as documented.
 *
 * Phases 5–7 are in core-loop-phases-b.ts.
 */

import type { Logger } from "../../runtime/logger.js";
import type { ToolExecutor } from "../../tools/executor.js";
import type { Goal } from "../../base/types/goal.js";
import type { GapVector } from "../../base/types/gap.js";
import type { DriveScore } from "../../base/types/drive.js";
import {
  buildDriveContext,
  type CoreLoopDeps,
  type ResolvedLoopConfig,
  type LoopIterationResult,
} from "./core-loop-types.js";
import { logRewardComputation } from "../../platform/drive/reward-log.js";

/** Minimal context passed to every phase function. */
export interface PhaseCtx {
  deps: CoreLoopDeps;
  config: ResolvedLoopConfig;
  logger: Logger | undefined;
  toolExecutor?: ToolExecutor;
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

// ─── Phase 1b: Auto-decompose ───

/**
 * Automatically decompose an abstract goal into sub-goals using
 * TreeLoopOrchestrator.ensureGoalRefined(). Skipped when disabled,
 * when the goal already has children, or when the goal is a leaf.
 * Only root goals (decomposition_depth === 0) are auto-decomposed to
 * prevent recursive decomposition of child nodes.
 * Specificity checks are delegated to ensureGoalRefined internally.
 *
 * @param decomposedGoals - Set of goal IDs already decomposed this run.
 *   When provided, goals already in the set are skipped and the goal ID is
 *   added to the set after a successful decomposition attempt.
 */
export async function phaseAutoDecompose(
  goalId: string,
  goal: Goal,
  deps: CoreLoopDeps,
  config: ResolvedLoopConfig,
  logger: Logger | undefined,
  decomposedGoals?: Set<string>,
  isFirstIteration?: boolean
): Promise<void> {
  if (config.autoDecompose === false) return;
  if (!deps.treeLoopOrchestrator) return;

  if (goal.children_ids.length > 0) {
    logger?.debug("[CoreLoop] phaseAutoDecompose: skipped — goal already has children", { goalId });
    return;
  }

  if (goal.node_type === "leaf") {
    logger?.debug("[CoreLoop] phaseAutoDecompose: skipped — goal is leaf", { goalId });
    return;
  }

  // Only auto-decompose root goals — prevent recursive decomposition of children
  if ((goal.decomposition_depth ?? 0) > 0) {
    logger?.debug("[CoreLoop] phaseAutoDecompose: skipped — non-root goal (depth > 0)", { goalId, depth: goal.decomposition_depth });
    return;
  }

  // Skip if already decomposed this run
  if (decomposedGoals?.has(goalId)) {
    logger?.debug("[CoreLoop] phaseAutoDecompose: skipped — already decomposed this run", { goalId });
    return;
  }

  const force = isFirstIteration === true;
  if (force) {
    logger?.info("[decompose] forcing goal decomposition on first iteration", { goalId });
  } else {
    logger?.info("[CoreLoop] phaseAutoDecompose: decomposing abstract goal", { goalId });
  }
  decomposedGoals?.add(goalId);
  try {
    await deps.treeLoopOrchestrator.ensureGoalRefined(goalId, { force });
  } catch (err) {
    logger?.warn("[CoreLoop] phaseAutoDecompose: ensureGoalRefined failed (non-fatal)", {
      goalId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  logger?.info("[CoreLoop] phaseAutoDecompose: decomposition complete", { goalId });
}

// ─── Phase 2 helpers ───

/** Build a ToolCallContext from PhaseCtx for CoreLoop autonomous tool calls. */
export async function buildLoopToolContext(
  ctx: PhaseCtx,
  goalId: string
): Promise<import("../../tools/types.js").ToolCallContext> {
  let trustBalance = 0;
  if (ctx.deps.trustManager) {
    try {
      const balance = await ctx.deps.trustManager.getBalance(goalId);
      trustBalance = balance.balance;
    } catch {
      // Non-fatal — default to 0
    }
  }
  return {
    cwd: process.cwd(),
    goalId,
    trustBalance,
    preApproved: true,
    approvalFn: async () => false,
  };
}

// ─── Phase 2 ───

/** Run observation engine, reload goal after observation.
 * Observation failure is non-fatal — returns current goal state.
 * When ctx.toolExecutor is present, routes through the observe-goal tool first
 * and falls back to direct engine.observe() on tool failure. */
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

  // Tool path: route through ToolExecutor when available
  if (ctx.toolExecutor) {
    try {
      const toolCtx = await buildLoopToolContext(ctx, goalId);
      const toolResult = await ctx.toolExecutor.execute("observe-goal", { goal_id: goalId }, toolCtx);
      if (toolResult.success) {
        const reloaded = await ctx.deps.stateManager.loadGoal(goalId);
        if (reloaded) return reloaded;
        return goal;
      }
      ctx.logger?.warn(`CoreLoop: observe-goal tool failed: ${toolResult.error}, falling back to direct call`);
    } catch (err) {
      ctx.logger?.warn("CoreLoop: observe-goal tool threw (falling back to direct call)", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Direct path: fallback (or when toolExecutor is absent)
  try {
    const engine = ctx.deps.observationEngine;

    ctx.logger?.debug("CoreLoop: engine.getDataSources exists", { exists: true });
    const dataSources = engine.getDataSources();
    ctx.logger?.debug("CoreLoop: observation setup", { dataSourceCount: dataSources.length });

    await engine.observe(goalId, []);

    const reloaded = await ctx.deps.stateManager.loadGoal(goalId);
    if (reloaded) return reloaded;
  } catch (err) {
    ctx.logger?.warn("CoreLoop: observation failed (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
  }
  return goal;
}

// ─── Phase 3 ───

/** Calculate gap vector and aggregate.
 * Returns null on error.
 * When gap === 0, returns the gap result with skipTaskGeneration=true so the
 * caller continues to Phase 5 (SatisficingJudge) instead of short-circuiting.
 */
export async function calculateGapOrComplete(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  loopIndex: number,
  result: LoopIterationResult,
  startTime: number
): Promise<{ gapVector: GapVector; gapAggregate: number; skipTaskGeneration?: boolean } | null> {
  let gapVector: GapVector;
  let gapAggregate: number;
  try {
    // Refresh stale dimensions via tool measurement before gap calculation
    if (ctx.toolExecutor && goal.dimensions) {
      const { needsDirectMeasurement, measureDirectly } = await import("../../platform/drive/gap-calculator-tools.js");
      let anyRefreshed = false;
      for (const dim of goal.dimensions) {
        if (needsDirectMeasurement(dim)) {
          try {
            const refreshed = await measureDirectly(dim, ctx.toolExecutor, {
              cwd: process.cwd(),
              goalId,
              trustBalance: 0,
              preApproved: true,
              approvalFn: async () => false,
            });
            if (refreshed !== null) {
              dim.current_value = refreshed.value;
              dim.confidence = refreshed.confidence;
              anyRefreshed = true;
              ctx.logger?.debug(`[GapRefresh] Refreshed stale dimension ${dim.name}: confidence ${dim.confidence}`);
            }
          } catch (err) {
            ctx.logger?.warn(`[GapRefresh] Failed to refresh ${dim.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      // Persist refreshed dimension values to avoid re-measuring on the next iteration
      if (anyRefreshed) {
        try {
          await ctx.deps.stateManager.saveGoal(goal);
          ctx.logger?.debug('[GapRefresh] Persisted refreshed dimensions for goal ' + goalId);
        } catch (err) {
          ctx.logger?.warn?.('[GapRefresh] Failed to persist refreshed dimensions: ' + String(err));
        }
      }
    }
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

  // Gap zero check — gap is satisfied; skip task generation but continue to
  // Phase 5 so SatisficingJudge can enforce confidence and double-confirmation.
  if (gapAggregate === 0) {
    ctx.logger?.info(`[CoreLoop] gap=0 for goal ${goalId} — skipping task generation, deferring to SatisficingJudge`);
    return { gapVector, gapAggregate, skipTaskGeneration: true };
  }

  const avgConf = gapVector.gaps.length > 0
    ? gapVector.gaps.reduce((s, g) => s + g.confidence, 0) / gapVector.gaps.length
    : undefined;
  ctx.deps.onProgress?.({
    iteration: loopIndex + 1,
    maxIterations: ctx.config.maxIterations,
    phase: "Generating task...",
    gap: gapAggregate,
    confidence: avgConf,
  });

  return { gapVector, gapAggregate };
}

// ─── Phase 4 ───

/** Score drives, update DriveScoreAdapter, check knowledge gap.
 * Returns ranked DriveScores with highDissatisfactionDimensions, or null if the caller should
 * return result early (knowledge gap task generated or drive scoring failed). */
export async function scoreDrivesAndCheckKnowledge(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  gapVector: GapVector,
  loopIndex: number,
  result: LoopIterationResult,
  startTime: number,
  tryGenerateReport: (goalId: string, loopIndex: number, result: LoopIterationResult, goal: Goal) => void
): Promise<{ driveScores: DriveScore[]; highDissatisfactionDimensions: string[] } | null> {
  let driveScores: DriveScore[];
  let highDissatisfactionDimensions: string[] = [];
  try {
    const driveContext = buildDriveContext(goal);
    driveScores = ctx.deps.driveScorer.scoreAllDimensions(gapVector, driveContext);
    const rankedScores = ctx.deps.driveScorer.rankDimensions(driveScores);
    result.driveScores = rankedScores;
    driveScores = rankedScores;

    if (ctx.deps.driveScoreAdapter) {
      ctx.deps.driveScoreAdapter.update(driveScores);
    }

    // Extract dimensions with high dissatisfaction (> 0.7) for memory tier promotion
    highDissatisfactionDimensions = driveScores
      .filter((s) => s.dissatisfaction > 0.7)
      .map((s) => s.dimension_name);

    // Consolidated reward computation log (PULSEED_REWARD_LOG=1 to enable)
    const confidenceAvg =
      gapVector.gaps.reduce((sum, g) => sum + g.confidence, 0) /
      Math.max(gapVector.gaps.length, 1);
    let trustScore: number | null = null;
    if (ctx.deps.trustManager) {
      try {
        const balance = await ctx.deps.trustManager.getBalance(ctx.config.adapterType);
        trustScore = balance.balance;
      } catch {
        // Non-fatal: trust score is diagnostic-only
      }
    }
    logRewardComputation({
      goalId,
      iteration: loopIndex,
      gapAggregate: result.gapAggregate ?? 0,
      confidenceAvg,
      trustScore,
      driveScores,
      completionJudgment: null,
    });
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

      // Skip knowledge gap detection when:
      // 1. Observations are purely self-report (confidence <= 0.3, no data sources)
      // 2. Not the first iteration — prevents repeated gap detection from blocking
      //    task execution every loop. Gap detection runs once; after that, let the
      //    normal task cycle proceed.
      const skipGapDetection =
        observationContext.confidence <= 0.3 ||
        !Number.isFinite(observationContext.confidence) ||
        loopIndex > 0;
      const gapSignal = skipGapDetection
        ? null
        : await ctx.deps.knowledgeManager.detectKnowledgeGap(observationContext);
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

  return { driveScores, highDissatisfactionDimensions };
}
