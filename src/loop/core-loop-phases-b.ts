/**
 * core-loop-phases-b.ts
 *
 * Phases 5–7 of CoreLoop.runOneIteration() as standalone functions.
 * Phases 1–4 are in core-loop-phases.ts.
 */

import { randomUUID } from "node:crypto";
import type { Goal } from "../types/goal.js";
import type { GapVector, GapHistoryEntry } from "../types/gap.js";
import type { StallReport } from "../types/stall.js";
import type { DriveScore } from "../types/drive.js";
import {
  buildDriveContext,
  type LoopIterationResult,
} from "./core-loop-types.js";
import type { PhaseCtx } from "./core-loop-phases.js";
import {
  getMilestones,
  evaluatePace,
} from "../goal/milestone-evaluator.js";

// ─── Phase 5 ───

/** Completion check + milestone deadline check.
 * Sets result.error on fatal failure, sets result.completionJudgment. */
export async function checkCompletionAndMilestones(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  result: LoopIterationResult,
  startTime: number
): Promise<void> {
  // R1-1: record pre-task judgment (do NOT early-return here)
  try {
    const judgment = goal.children_ids.length > 0
      ? await ctx.deps.satisficingJudge.judgeTreeCompletion(goalId)
      : ctx.deps.satisficingJudge.isGoalComplete(goal);
    result.completionJudgment = judgment;

    // Wire satisficing callback to MemoryLifecycleManager
    // SatisficingJudge fires (goalId, satisfiedDimensions[]) but MLM expects per-dimension calls
    if (ctx.deps.memoryLifecycleManager) {
      const blockingSet = new Set(judgment.blocking_dimensions);
      for (const dim of goal.dimensions) {
        const isSatisfied = !blockingSet.has(dim.name);
        ctx.deps.memoryLifecycleManager.onSatisficingJudgment(goalId, dim.name, isSatisfied);
      }
    }
  } catch (err) {
    result.error = `Completion check failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.logger?.error(`CoreLoop: ${result.error}`, { goalId });
    result.elapsedMs = Date.now() - startTime;
    return;
  }

  // Milestone deadline check
  try {
    const allGoals = [goal];
    for (const childId of goal.children_ids) {
      const child = await ctx.deps.stateManager.loadGoal(childId);
      if (child) allGoals.push(child);
    }

    const milestones = getMilestones(allGoals);
    if (milestones.length > 0) {
      const milestoneAlerts: Array<{ goalId: string; status: string; pace_ratio: number }> = [];
      for (const milestone of milestones) {
        const currentAchievement =
          milestone.pace_snapshot?.achievement_ratio ??
          (typeof milestone.dimensions[0]?.current_value === "number"
            ? Math.min((milestone.dimensions[0].current_value as number) / 100, 1)
            : 0);

        const snapshot = evaluatePace(milestone, currentAchievement);
        await ctx.deps.stateManager.savePaceSnapshot(milestone.id, snapshot);

        if (snapshot.status === "at_risk" || snapshot.status === "behind") {
          milestoneAlerts.push({
            goalId: milestone.id,
            status: snapshot.status,
            pace_ratio: snapshot.pace_ratio,
          });
        } else {
          if (ctx.deps.learningPipeline) {
            try {
              await ctx.deps.learningPipeline.onMilestoneReached(
                goalId,
                `Milestone ${milestone.title}: pace ${snapshot.status}`
              );
            } catch {
              // non-fatal
            }
          }
        }
      }
      if (milestoneAlerts.length > 0) {
        result.milestoneAlerts = milestoneAlerts;
      }
    }
  } catch {
    // Milestone check failure is non-fatal
  }
}

// ─── Phase 6 ───

/** Stall detection per-dimension and globally, plus portfolio rebalance. */
export async function detectStallsAndRebalance(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  result: LoopIterationResult
): Promise<void> {
  try {
    const gapHistory = await ctx.deps.stateManager.loadGapHistory(goalId);

    // Per-dimension stall check
    for (const dim of goal.dimensions) {
      const dimGapHistory = gapHistory
        .filter((entry) =>
          entry.gap_vector.some((g) => g.dimension_name === dim.name)
        )
        .map((entry) => {
          const g = entry.gap_vector.find((g) => g.dimension_name === dim.name);
          return { normalized_gap: g?.normalized_weighted_gap ?? 1 };
        });

      const stallReport = ctx.deps.stallDetector.checkDimensionStall(
        goalId,
        dim.name,
        dimGapHistory
      );

      if (stallReport) {
        result.stallDetected = true;
        result.stallReport = stallReport;

        const escalationLevel = await ctx.deps.stallDetector.getEscalationLevel(goalId, dim.name);
        await applyStallAction(ctx, goalId, goal, dimGapHistory, stallReport, escalationLevel, dim.name, result, "");
        break;
      }
    }

    // Global stall check
    if (!result.stallDetected) {
      await checkGlobalStall(ctx, goalId, goal, result, gapHistory);
    }

    // Portfolio: check rebalance after stall detection
    if (ctx.deps.portfolioManager) {
      await rebalancePortfolio(ctx, goalId, goal);
    }
  } catch (err) {
    ctx.logger?.warn("CoreLoop: stall detection failed (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
  }
}

// ─── Shared stall-action helper ───

/** Apply REFINE/PIVOT/ESCALATE logic for a detected stall (per-dimension or global).
 * @param dimHistory      Gap history slice used for analysis (single-dim or first-dim for global).
 * @param stallReport     The detected StallReport.
 * @param escalationLevel Current escalation level for the stall dimension.
 * @param incrementDimName Dimension name passed to incrementEscalation after handling.
 * @param logPrefix       Short prefix for log messages, e.g. "" or "global ".
 */
async function applyStallAction(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  dimHistory: Array<{ normalized_gap: number }>,
  stallReport: StallReport,
  escalationLevel: number,
  incrementDimName: string,
  result: LoopIterationResult,
  logPrefix: string
): Promise<void> {
  if (ctx.deps.learningPipeline) {
    try {
      await ctx.deps.learningPipeline.onStallDetected(goalId, stallReport);
    } catch {
      // non-fatal
    }
  }

  const activeStrategyForRecord = await Promise.resolve(ctx.deps.strategyManager.getActiveStrategy(goalId)).catch(() => null);
  const strategyIdForRecord = activeStrategyForRecord?.id ?? "unknown";

  // M14-S2: analyze stall cause to determine REFINE/PIVOT/ESCALATE
  // Falls back to PIVOT behavior when analyzeStallCause is unavailable
  const analysis = ctx.deps.stallDetector.analyzeStallCause?.(dimHistory);
  result.stallAnalysis = analysis;

  if (analysis?.recommended_action === "refine") {
    // REFINE: keep current strategy, just log and continue
    ctx.logger?.info(`CoreLoop: ${logPrefix}stall REFINE — parameter_issue detected, keeping strategy`, {
      goalId,
      evidence: analysis.evidence,
    });
  } else if (stallReport.suggested_cause === "information_deficit" && ctx.deps.goalRefiner) {
    // Observation-failure stall: re-refine the leaf to get better dimensions
    ctx.logger?.info(`CoreLoop: ${logPrefix}observation-failure stall — calling reRefineLeaf`, { goalId });
    try {
      await ctx.deps.goalRefiner.reRefineLeaf(goalId, stallReport.suggested_cause!);
    } catch (reRefineErr) {
      ctx.logger?.warn(`CoreLoop: ${logPrefix}reRefineLeaf failed (non-fatal)`, {
        goalId,
        err: reRefineErr instanceof Error ? reRefineErr.message : String(reRefineErr),
      });
    }
  } else if (analysis?.recommended_action === "escalate") {
    // ESCALATE: set escalation level to max to trigger loop exit
    ctx.logger?.warn(`CoreLoop: ${logPrefix}stall ESCALATE — goal_unreachable detected`, {
      goalId,
      evidence: analysis.evidence,
    });
    await ctx.deps.strategyManager.onStallDetected(goalId, 3, goal.origin ?? "general");
    result.pivotOccurred = true;
  } else {
    // PIVOT: switch strategy, but check pivot count limit first
    const portfolio = await ctx.deps.strategyManager.getPortfolio(goalId);
    const activeStrategy = portfolio?.strategies.find((s) => s.state === "active");
    const pivotCount = activeStrategy?.pivot_count ?? 0;
    const maxPivotCount = activeStrategy?.max_pivot_count ?? 2;

    if (pivotCount >= maxPivotCount) {
      // Auto-escalate when pivot limit reached
      ctx.logger?.warn(`CoreLoop: ${logPrefix}stall auto-ESCALATE — pivot_count limit reached`, {
        goalId,
        pivotCount,
        maxPivotCount,
      });
      await ctx.deps.strategyManager.onStallDetected(goalId, 3, goal.origin ?? "general");
      result.pivotOccurred = true;
    } else {
      const newStrategy = await ctx.deps.strategyManager.onStallDetected(
        goalId,
        escalationLevel + 1,
        goal.origin ?? "general"
      );
      if (newStrategy) {
        result.pivotOccurred = true;
        if (activeStrategy?.id) {
          try {
            await ctx.deps.strategyManager.incrementPivotCount(goalId, activeStrategy.id);
          } catch {
            // non-fatal
          }
        }
      }
    }
  }

  // M14-S3: Record decision (non-fatal)
  if (ctx.deps.knowledgeManager) {
    try {
      const latestGap = dimHistory[dimHistory.length - 1]?.normalized_gap ?? 1;
      await ctx.deps.knowledgeManager.recordDecision({
        id: randomUUID(),
        goal_id: goalId,
        goal_type: goal.origin ?? "general",
        strategy_id: strategyIdForRecord,
        hypothesis: activeStrategyForRecord?.hypothesis,
        decision: analysis?.recommended_action ?? "pivot",
        context: {
          gap_value: latestGap,
          stall_count: stallReport.escalation_level,
          cycle_count: dimHistory.length,
          trust_score: 0,
        },
        outcome: "pending",
        timestamp: new Date().toISOString(),
        what_worked: [],
        what_failed: [],
        suggested_next: [],
      });
    } catch {
      // non-fatal: never block the loop for decision recording
    }
  }

  if (incrementDimName) {
    await ctx.deps.stallDetector.incrementEscalation(goalId, incrementDimName);
  }
}

/** Global stall detection: check all dimensions together, handle REFINE/PIVOT/ESCALATE. */
async function checkGlobalStall(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  result: LoopIterationResult,
  gapHistory: GapHistoryEntry[]
): Promise<void> {
  const allDimGaps = new Map<string, Array<{ normalized_gap: number }>>();
  for (const dim of goal.dimensions) {
    const dimGapHistory = gapHistory
      .filter((entry) =>
        entry.gap_vector.some((g) => g.dimension_name === dim.name)
      )
      .map((entry) => {
        const g = entry.gap_vector.find((g) => g.dimension_name === dim.name);
        return { normalized_gap: g?.normalized_weighted_gap ?? 1 };
      });
    allDimGaps.set(dim.name, dimGapHistory);
  }

  const globalStall = ctx.deps.stallDetector.checkGlobalStall(goalId, allDimGaps);
  if (!globalStall) return;

  result.stallDetected = true;
  result.stallReport = globalStall;

  const firstDimHistory = allDimGaps.values().next().value ?? [];
  const firstDimName = goal.dimensions[0]?.name ?? "";

  // Pass escalationLevel=1 so that escalationLevel+1=2, preserving the original global PIVOT level
  await applyStallAction(ctx, goalId, goal, firstDimHistory, globalStall, 1, firstDimName, result, "global ");
}

/** Portfolio rebalance: check for rebalance triggers and handle wait strategy expiry. */
async function rebalancePortfolio(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal
): Promise<void> {
  if (!ctx.deps.portfolioManager) return;
  try {
    const rebalanceTrigger = await ctx.deps.portfolioManager.shouldRebalance(goalId);
    if (rebalanceTrigger) {
      const rebalanceResult = await ctx.deps.portfolioManager.rebalance(goalId, rebalanceTrigger);
      if (rebalanceResult.new_generation_needed) {
        await ctx.deps.strategyManager.onStallDetected(goalId, 3, goal.origin ?? "general");
      }
    }
  } catch {
    // Portfolio rebalance errors are non-fatal
  }

  try {
    const portfolio = await ctx.deps.strategyManager.getPortfolio(goalId);
    if (portfolio) {
      for (const strategy of portfolio.strategies) {
        if (ctx.deps.portfolioManager.isWaitStrategy(strategy)) {
          const waitTrigger = await ctx.deps.portfolioManager.handleWaitStrategyExpiry(
            goalId,
            strategy.id
          );
          if (waitTrigger) {
            await ctx.deps.portfolioManager.rebalance(goalId, waitTrigger);
          }
        }
      }
    }
  } catch {
    // WaitStrategy expiry errors are non-fatal
  }
}

// ─── Phase 6b ───

/** Check dependency graph block.
 * Returns true if goal is blocked (result.error set, caller should return). */
export function checkDependencyBlock(
  ctx: PhaseCtx,
  goalId: string,
  result: LoopIterationResult
): boolean {
  if (ctx.deps.goalDependencyGraph) {
    try {
      if (ctx.deps.goalDependencyGraph.isBlocked(goalId)) {
        const blockingGoals = ctx.deps.goalDependencyGraph.getBlockingGoals(goalId);
        result.error = `Goal ${goalId} is blocked by prerequisites: ${blockingGoals.join(", ")}`;
        return true;
      }
    } catch {
      // Dependency graph errors are non-fatal
    }
  }
  return false;
}

// ─── Phase 7 ───

/** Callbacks passed to runTaskCycleWithContext to keep mutable state and side-effects on CoreLoop. */
export interface LoopCallbacks {
  handleCapabilityAcquisition: (task: unknown, goalId: string, adapter: unknown) => Promise<void>;
  incrementTransferCounter: () => number;
  tryGenerateReport: (goalId: string, loopIndex: number, result: LoopIterationResult, goal: Goal) => void;
}

/** Collect context, run task cycle, handle capability acquisition,
 * transfer detection, and post-task completion re-check.
 * Returns true on success, false if the caller should return result early.
 * `transferCheckCounter` is incremented via the callback to keep mutable state on CoreLoop. */
export async function runTaskCycleWithContext(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  gapVector: GapVector,
  driveScores: DriveScore[],
  highDissatisfactionDimensions: string[],
  loopIndex: number,
  result: LoopIterationResult,
  startTime: number,
  callbacks: LoopCallbacks
): Promise<boolean> {
  const { handleCapabilityAcquisition, incrementTransferCounter, tryGenerateReport } = callbacks;
  try {
    const driveContext = buildDriveContext(goal);
    const adapter = ctx.deps.adapterRegistry.getAdapter(ctx.config.adapterType);

    // Portfolio: select strategy for next task
    if (ctx.deps.portfolioManager) {
      try {
        const selectionResult = await ctx.deps.portfolioManager.selectNextStrategyForTask(goalId);
        if (selectionResult) {
          ctx.deps.taskLifecycle.setOnTaskComplete((strategyId: string) => {
            ctx.deps.portfolioManager?.recordTaskCompletion(strategyId);
          });
        }
      } catch {
        // Portfolio strategy selection is non-fatal
      }
    }

    // Collect knowledge context
    let knowledgeContext: string | undefined;
    if (ctx.deps.knowledgeManager) {
      try {
        const topDimension = driveScores[0]?.dimension_name ?? goal.dimensions[0]?.name;
        if (topDimension) {
          const entries = await ctx.deps.knowledgeManager.getRelevantKnowledge(goalId, topDimension);
          if (entries.length > 0) {
            knowledgeContext = entries
              .map((e) => `Q: ${e.question}\nA: ${e.answer}`)
              .join("\n\n");
          }
        }
      } catch {
        // Knowledge retrieval failure is non-fatal
      }
    }

    // Tier-aware memory selection: use highDissatisfactionDimensions and dynamic budget
    if (ctx.deps.memoryLifecycleManager) {
      try {
        const dimensions = goal.dimensions.map((d) => d.name);
        const maxDissatisfaction = driveScores.length > 0
          ? Math.max(...driveScores.map((s) => s.dissatisfaction))
          : 0;
        const satisfiedDimensions = goal.dimensions
          .filter((d) => !result.completionJudgment?.blocking_dimensions.includes(d.name))
          .map((d) => d.name);
        await ctx.deps.memoryLifecycleManager.selectForWorkingMemoryTierAware(
          goalId,
          dimensions,
          [],
          10,
          [goalId],
          [],
          satisfiedDimensions,
          highDissatisfactionDimensions,
          maxDissatisfaction
        );
      } catch {
        // Memory selection failure is non-fatal
      }
    }

    // Fetch existing tasks for dedup context
    let existingTasks: string[] | undefined;
    if (adapter.listExistingTasks) {
      try {
        existingTasks = await adapter.listExistingTasks();
      } catch {
        // Non-fatal: proceed without existing tasks context
      }
    }

    // Collect workspace context
    let workspaceContext: string | undefined;
    if (ctx.deps.contextProvider) {
      try {
        const topDimension = driveScores[0]?.dimension_name ?? goal.dimensions[0]?.name ?? "";
        workspaceContext = await ctx.deps.contextProvider(goalId, topDimension);
      } catch {
        // Non-fatal: proceed without workspace context
      }
    }

    ctx.logger?.debug("CoreLoop: running task cycle", { adapter: adapter.adapterType, goalId });
    ctx.deps.onProgress?.({
      iteration: loopIndex + 1,
      maxIterations: ctx.config.maxIterations,
      phase: "Executing task...",
      gap: result.gapAggregate,
    });
    const taskResult = await ctx.deps.taskLifecycle.runTaskCycle(
      goalId,
      gapVector,
      driveContext,
      adapter,
      knowledgeContext,
      existingTasks,
      workspaceContext
    );
    ctx.logger?.info("CoreLoop: task cycle result", { action: taskResult.action, taskId: taskResult.task.id });
    result.taskResult = taskResult;
    ctx.deps.onProgress?.({
      iteration: loopIndex + 1,
      maxIterations: ctx.config.maxIterations,
      phase: "Verifying result...",
      gap: result.gapAggregate,
      taskDescription: taskResult.task.work_description
        ? taskResult.task.work_description.split("\n")[0]?.slice(0, 80)
        : undefined,
    });

    // Handle capability_acquiring
    if (taskResult.action === "capability_acquiring" && taskResult.acquisition_task) {
      await handleCapabilityAcquisition(taskResult.acquisition_task, goalId, adapter);
    }

    // Portfolio: record task completion
    if (ctx.deps.portfolioManager && taskResult.action === "completed" && taskResult.task.strategy_id) {
      try {
        ctx.deps.portfolioManager.recordTaskCompletion(taskResult.task.strategy_id);
      } catch {
        // Non-fatal
      }
    }

    // Re-check completion after task execution
    const updatedGoal = await ctx.deps.stateManager.loadGoal(goalId);
    if (updatedGoal) {
      const postTaskJudgment = updatedGoal.children_ids.length > 0
        ? await ctx.deps.satisficingJudge.judgeTreeCompletion(updatedGoal.id)
        : ctx.deps.satisficingJudge.isGoalComplete(updatedGoal);
      result.completionJudgment = postTaskJudgment;
    }
  } catch (err) {
    result.error = `Task cycle failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.logger?.error(`CoreLoop: ${result.error}`, { goalId });
    result.elapsedMs = Date.now() - startTime;
    tryGenerateReport(goalId, loopIndex, result, goal);
    return false;
  }

  // Track curiosity goal loop count
  if (ctx.deps.curiosityEngine) {
    const currentGoal = await ctx.deps.stateManager.loadGoal(goalId);
    if (currentGoal?.origin === "curiosity") {
      ctx.deps.curiosityEngine.incrementLoopCount(goalId);
    }
  }

  // Transfer Detection (every 5 iterations, suggestion-only)
  const transferCount = incrementTransferCounter();
  if (ctx.deps.knowledgeTransfer && transferCount % 5 === 0) {
    try {
      const candidates = await ctx.deps.knowledgeTransfer.detectTransferOpportunities(goalId);
      if (candidates.length > 0) {
        result.transfer_candidates = candidates;
      }
    } catch {
      // non-fatal
    }
  }

  return true;
}
