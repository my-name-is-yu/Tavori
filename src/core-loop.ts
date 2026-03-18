import { sleep } from "./utils/sleep.js";
import type { Logger } from "./runtime/logger.js";
import type { Goal } from "./types/goal.js";

import type {
  GapCalculatorModule,
  DriveScorerModule,
  ExecutionSummaryParams,
  ReportingEngine,
  LoopConfig,
  LoopIterationResult,
  LoopResult,
  CoreLoopDeps,
  ProgressEvent,
} from "./loop/core-loop-types.js";
import { buildDriveContext } from "./loop/core-loop-types.js";
import {
  runTreeIteration as runTreeIterationImpl,
  runMultiGoalIteration as runMultiGoalIterationImpl,
} from "./loop/tree-loop-runner.js";
import {
  loadGoalWithAggregation,
  observeAndReload,
  calculateGapOrComplete,
  scoreDrivesAndCheckKnowledge,
  type PhaseCtx,
} from "./loop/core-loop-phases.js";
import {
  checkCompletionAndMilestones,
  detectStallsAndRebalance,
  checkDependencyBlock,
  runTaskCycleWithContext,
} from "./loop/core-loop-phases-b.js";
import { handleCapabilityAcquisition } from "./loop/core-loop-capability.js";

// Re-export types for backward compatibility
export type {
  GapCalculatorModule,
  DriveScorerModule,
  ExecutionSummaryParams,
  ReportingEngine,
  LoopConfig,
  LoopIterationResult,
  LoopResult,
  CoreLoopDeps,
  ProgressEvent,
} from "./loop/core-loop-types.js";
export { buildDriveContext } from "./loop/core-loop-types.js";

const DEFAULT_CONFIG: Required<LoopConfig> = {
  maxIterations: 100,
  maxConsecutiveErrors: 3,
  delayBetweenLoopsMs: 1000,
  adapterType: "openai_codex_cli",
  treeMode: false,
  multiGoalMode: false,
  goalIds: [],
  minIterations: 1,
  autoArchive: false,
};

// ─── CoreLoop ───

/**
 * CoreLoop is the heart of Motiva — it orchestrates one full iteration of the
 * task discovery loop: observe → gap → score → completion check → stall check → task → report.
 *
 * It runs multiple iterations until the goal is complete (SatisficingJudge),
 * max iterations reached, stall escalation occurs, or an external stop signal.
 */
export class CoreLoop {
  private readonly deps: CoreLoopDeps;
  private readonly config: Required<LoopConfig>;
  private readonly logger?: Logger;
  private stopped = false;
  private lastLearningReviewAt: number = Date.now();
  private transferCheckCounter: number = 0;
  /** Tracks consecutive capability acquisition failures per capability name */
  private capabilityAcquisitionFailures: Map<string, number> = new Map();

  constructor(deps: CoreLoopDeps, config?: LoopConfig) {
    this.deps = deps;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = deps.logger;
  }

  // ─── Public API ───

  /**
   * Run the full loop until completion or stop condition.
   */
  async run(goalId: string): Promise<LoopResult> {
    const startedAt = new Date().toISOString();
    this.stopped = false;

    // Load and validate goal
    const goal = this.deps.stateManager.loadGoal(goalId);
    if (!goal) {
      return {
        goalId,
        totalIterations: 0,
        finalStatus: "error",
        iterations: [],
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    if (goal.status !== "active" && goal.status !== "waiting") {
      return {
        goalId,
        totalIterations: 0,
        finalStatus: "error",
        iterations: [],
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    // Reset stall state AND gap history at the beginning of each run so prior
    // run's escalation and stale gap entries do not immediately poison a fresh start.
    for (const dim of goal.dimensions) {
      this.deps.stallDetector.resetEscalation(goalId, dim.name);
    }
    this.deps.stateManager.saveGapHistory(goalId, []);

    const iterations: LoopIterationResult[] = [];
    let consecutiveErrors = 0;
    let consecutiveDenied = 0;
    let consecutiveEscalations = 0;
    let finalStatus: LoopResult["finalStatus"] = "max_iterations";

    for (let loopIndex = 0; loopIndex < this.config.maxIterations; loopIndex++) {
      if (this.stopped) {
        finalStatus = "stopped";
        break;
      }

      const iterationResult = this.config.treeMode && this.deps.treeLoopOrchestrator
        ? await this.runTreeIteration(goalId, loopIndex)
        : await this.runOneIteration(goalId, loopIndex);
      iterations.push(iterationResult);

      // Check completion (R1-2: must complete at least minIterations before exiting)
      if (iterationResult.completionJudgment.is_complete &&
          loopIndex >= (this.config.minIterations ?? 1) - 1) {
        finalStatus = "completed";
        break;
      }

      // Check errors
      if (iterationResult.error !== null) {
        consecutiveErrors++;
        if (consecutiveErrors >= this.config.maxConsecutiveErrors) {
          finalStatus = "error";
          break;
        }
      } else {
        consecutiveErrors = 0;
      }

      // Check approval_denied and escalate counters
      const taskAction = iterationResult.taskResult?.action ?? null;

      if (taskAction === "approval_denied") {
        consecutiveDenied++;
        if (consecutiveDenied >= 3) {
          finalStatus = "stopped";
          break;
        }
      } else {
        consecutiveDenied = 0;
      }

      if (taskAction === "escalate") {
        consecutiveEscalations++;
        if (consecutiveEscalations >= 3) {
          finalStatus = "stalled";
          break;
        }
      } else {
        consecutiveEscalations = 0;
      }

      // Check stall escalation (escalation_level >= 3 means max escalation)
      if (
        iterationResult.stallDetected &&
        iterationResult.stallReport &&
        iterationResult.stallReport.escalation_level >= 3
      ) {
        finalStatus = "stalled";
        break;
      }

      // Check stopped again after iteration
      if (this.stopped) {
        finalStatus = "stopped";
        break;
      }

      // Periodic learning review
      if (this.deps.learningPipeline) {
        const now = Date.now();
        const intervalMs = this.getPeriodicReviewInterval(goalId);
        if (now - this.lastLearningReviewAt >= intervalMs) {
          try {
            await this.deps.learningPipeline.onPeriodicReview(goalId);
            this.lastLearningReviewAt = now;
          } catch {
            // non-fatal: learning pipeline failure should not block main loop
          }
        }
      }

      // Delay between loops (skip on last iteration)
      if (loopIndex < this.config.maxIterations - 1 && this.config.delayBetweenLoopsMs > 0) {
        await sleep(this.config.delayBetweenLoopsMs);
      }
    }

    // After loop completes, check curiosity triggers if engine is available
    if (this.deps.curiosityEngine && (finalStatus === "completed" || finalStatus === "max_iterations")) {
      try {
        this.deps.curiosityEngine.checkAutoExpiration();

        const currentGoal = this.deps.stateManager.loadGoal(goalId);
        if (currentGoal) {
          const allGoals = [currentGoal];
          if (this.deps.curiosityEngine.shouldExplore(allGoals)) {
            const triggers = this.deps.curiosityEngine.evaluateTriggers(allGoals);
            if (triggers.length > 0) {
              await this.deps.curiosityEngine.generateProposals(triggers, allGoals);
            }
          }
        }
      } catch (err) {
        this.logger?.warn("CoreLoop: curiosity evaluation failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // After loop completes, trigger learning pipeline for goal completion
    if (this.deps.learningPipeline && finalStatus === "completed") {
      try {
        await this.deps.learningPipeline.onGoalCompleted(goalId);
      } catch {
        // non-fatal
      }
    }

    // Trigger memory lifecycle close on completion
    if (this.deps.memoryLifecycleManager && finalStatus === "completed") {
      try {
        await this.deps.memoryLifecycleManager.onGoalClose(goalId, "completed");
      } catch {
        // non-fatal
      }
    }

    // Archive goal state on completion (only when autoArchive is explicitly enabled)
    if (finalStatus === "completed" && this.config.autoArchive) {
      try {
        this.deps.stateManager.archiveGoal(goalId);
      } catch {
        // non-fatal
      }
    }

    return {
      goalId,
      totalIterations: iterations.length,
      finalStatus,
      iterations,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Run a single iteration of the loop.
   */
  async runOneIteration(
    goalId: string,
    loopIndex: number
  ): Promise<LoopIterationResult> {
    const startTime = Date.now();
    const ctx: PhaseCtx = { deps: this.deps, config: this.config, logger: this.logger };

    // Default result (filled in progressively)
    const result: LoopIterationResult = {
      loopIndex,
      goalId,
      gapAggregate: 0,
      driveScores: [],
      taskResult: null,
      stallDetected: false,
      stallReport: null,
      pivotOccurred: false,
      completionJudgment: {
        is_complete: false,
        blocking_dimensions: [],
        low_confidence_dimensions: [],
        needs_verification_task: false,
        checked_at: new Date().toISOString(),
      },
      elapsedMs: 0,
      error: null,
    };

    // 1. Load goal + tree aggregation
    const loadedGoal = loadGoalWithAggregation(ctx, goalId, result, startTime);
    if (!loadedGoal) return result;
    let goal = loadedGoal;

    // 2. Observe + reload
    goal = await observeAndReload(ctx, goalId, goal, loopIndex);

    // 3. Gap calculate + zero check
    const gapResult = calculateGapOrComplete(ctx, goalId, goal, loopIndex, result, startTime);
    if (!gapResult) return result;
    const { gapVector, gapAggregate } = gapResult;

    // 4. Drive scoring + knowledge gap check
    const driveScores = await scoreDrivesAndCheckKnowledge(
      ctx, goalId, goal, gapVector, loopIndex, result, startTime,
      (id, idx, r, g) => this.tryGenerateReport(id, idx, r, g)
    );
    if (!driveScores) return result;

    // 5. Completion check + milestones
    await checkCompletionAndMilestones(ctx, goalId, goal, result, startTime);
    if (result.error) return result;

    // 6. Stall detection + rebalance
    await detectStallsAndRebalance(ctx, goalId, goal, result);

    // 6b. Dependency block check
    if (checkDependencyBlock(ctx, goalId, result)) return result;

    // 7. Task cycle with context
    const taskCycleOk = await runTaskCycleWithContext(
      ctx, goalId, goal, gapVector, driveScores, loopIndex, result, startTime,
      (task, gId, adapter) => handleCapabilityAcquisition(
        task as Parameters<typeof handleCapabilityAcquisition>[0],
        gId,
        adapter as Parameters<typeof handleCapabilityAcquisition>[2],
        this.deps.capabilityDetector,
        this.capabilityAcquisitionFailures,
        this.logger
      ),
      () => ++this.transferCheckCounter,
      (id, idx, r, g) => this.tryGenerateReport(id, idx, r, g)
    );
    if (!taskCycleOk) return result;

    // 8. Report
    this.tryGenerateReport(goalId, loopIndex, result, goal);

    result.elapsedMs = Date.now() - startTime;
    return result;
  }

  /**
   * Tree-mode iteration: select one node via TreeLoopOrchestrator, run a
   * normal observe→gap→score→task cycle on that node, then aggregate upward.
   *
   * Called by run() when treeMode=true.
   */
  async runTreeIteration(rootId: string, loopIndex: number): Promise<LoopIterationResult> {
    return runTreeIterationImpl(rootId, loopIndex, this.deps, this.config, this.logger,
      (id, idx) => this.runOneIteration(id, idx));
  }

  /**
   * Run one iteration of the multi-goal loop.
   *
   * Uses CrossGoalPortfolio (if available) to determine goal allocations,
   * then calls portfolioManager.selectNextStrategyAcrossGoals() to pick
   * which goal gets the next iteration. Falls back to equal allocation if
   * CrossGoalPortfolio is not injected.
   *
   * Requires config.multiGoalMode=true and config.goalIds to be set.
   * Throws if CrossGoalPortfolio is not injected and multiGoalMode is enabled.
   */
  async runMultiGoalIteration(loopIndex: number): Promise<LoopIterationResult> {
    return runMultiGoalIterationImpl(loopIndex, this.deps, this.config,
      (id, idx) => this.runOneIteration(id, idx));
  }

  /**
   * Stop the loop externally (e.g., on SIGTERM).
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Check if the loop has been stopped.
   */
  isStopped(): boolean {
    return this.stopped;
  }

  // ─── Private Helpers ───

  private getPeriodicReviewInterval(goalId: string): number {
    const goal = this.deps.stateManager.loadGoal(goalId);
    if (!goal?.target_date) {
      return 72 * 3600 * 1000; // default: 72 hours
    }
    const remainingDays = (new Date(goal.target_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (remainingDays <= 30) return 72 * 3600 * 1000;     // 短期: 72h
    if (remainingDays <= 180) return 168 * 3600 * 1000;   // 中期: 1week
    return 336 * 3600 * 1000;                              // 長期: 2weeks
  }

  private tryGenerateReport(
    goalId: string,
    loopIndex: number,
    iterationResult: LoopIterationResult,
    goal: Goal
  ): void {
    try {
      const observation = goal.dimensions.map((d) => ({
        dimensionName: d.name,
        progress: typeof d.current_value === "number" ? d.current_value : 0,
        confidence: d.confidence,
      }));

      const taskResult =
        iterationResult.taskResult !== null
          ? {
              taskId: iterationResult.taskResult.task.id,
              action: iterationResult.taskResult.action,
              dimension: iterationResult.taskResult.task.primary_dimension,
            }
          : null;

      const report = this.deps.reportingEngine.generateExecutionSummary({
        goalId,
        loopIndex,
        observation,
        gapAggregate: iterationResult.gapAggregate,
        taskResult,
        stallDetected: iterationResult.stallDetected,
        pivotOccurred: iterationResult.pivotOccurred,
        elapsedMs: iterationResult.elapsedMs,
      });
      this.deps.reportingEngine.saveReport(report);
    } catch {
      // Report generation failure is non-fatal
    }
  }
}
