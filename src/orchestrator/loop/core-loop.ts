import { sleep } from "../../base/utils/sleep.js";
import type { Logger } from "../../runtime/logger.js";
import type { StateDiffCalculator } from "./state-diff.js";
import { IterationBudget } from "./iteration-budget.js";
import { saveLoopCheckpoint, restoreLoopCheckpoint } from "./checkpoint-manager-loop.js";
import { runPostLoopHooks } from "./post-loop-hooks.js";
import { generateLoopReport } from "./loop-report-helper.js";

import { makeEmptyIterationResult } from "./core-loop-types.js";
import type {
  LoopConfig,
  ResolvedLoopConfig,
  LoopIterationResult,
  LoopResult,
  CoreLoopDeps,
} from "./core-loop-types.js";
import {
  runTreeIteration as runTreeIterationImpl,
  runMultiGoalIteration as runMultiGoalIterationImpl,
} from "./tree-loop-runner.js";
import {
  loadGoalWithAggregation,
  observeAndReload,
  calculateGapOrComplete,
  scoreDrivesAndCheckKnowledge,
  phaseAutoDecompose,
  type PhaseCtx,
} from "./core-loop-phases.js";
import {
  checkCompletionAndMilestones,
  detectStallsAndRebalance,
  checkDependencyBlock,
  runTaskCycleWithContext,
  type LoopCallbacks,
} from "./core-loop-phases-b.js";
import {
  runStateDiffCheck,
  tryParallelExecution,
  type StateDiffState,
} from "./core-loop-phases-c.js";
import { handleCapabilityAcquisition } from "./core-loop-capability.js";
import type { ITimeHorizonEngine } from "../../platform/time/time-horizon-engine.js";
import type { PacingResult } from "../../base/types/time-horizon.js";
import { CoreLoopLearning } from "./core-loop-learning.js";

// Re-export types for backward compatibility
export type {
  GapCalculatorModule,
  DriveScorerModule,
  ExecutionSummaryParams,
  ReportingEngine,
  LoopConfig,
  ResolvedLoopConfig,
  LoopIterationResult,
  LoopResult,
  CoreLoopDeps,
  ProgressEvent,
  ProgressPhase,
} from "./core-loop-types.js";
export { buildDriveContext, makeEmptyIterationResult } from "./core-loop-types.js";

const DEFAULT_CONFIG: Required<Omit<LoopConfig, "iterationBudget">> = {
  maxIterations: 100,
  maxConsecutiveErrors: 3,
  delayBetweenLoopsMs: 1000,
  adapterType: "openai_codex_cli",
  treeMode: false,
  multiGoalMode: false,
  goalIds: [],
  minIterations: 1,
  autoArchive: false,
  dryRun: false,
  maxConsecutiveSkips: 5,
  autoDecompose: true,
  autoConsolidateOnComplete: true,
  consolidationRawThreshold: 20,
};

// ─── CoreLoop ───

/**
 * CoreLoop is the heart of PulSeed — it orchestrates one full iteration of the
 * task discovery loop: observe → gap → score → completion check → stall check → task → report.
 *
 * It runs multiple iterations until the goal is complete (SatisficingJudge),
 * max iterations reached, stall escalation occurs, or an external stop signal.
 */
export class CoreLoop {
  private readonly deps: CoreLoopDeps;
  /** Mutable config — may be updated mid-run (e.g. treeMode enabled after decomposition). */
  private config: ResolvedLoopConfig;
  private readonly logger?: Logger;
  private stopped = false;
  private readonly learning: CoreLoopLearning = new CoreLoopLearning();
  /** Optional StateDiffCalculator for loop-skip optimization. */
  private readonly stateDiff?: StateDiffCalculator;
  private stateDiffState = new Map<string, StateDiffState>();
  /** Tracks goals that have already been through auto-decompose this run. */
  private decomposedGoals = new Set<string>();
  /** Optional TimeHorizonEngine for adaptive observation interval (Gap 4). */
  private timeHorizonEngine?: ITimeHorizonEngine;
  /** Last known pacing result — updated each iteration for adaptive delay. */
  private lastPacingResult?: PacingResult;

  constructor(deps: CoreLoopDeps, config?: LoopConfig, stateDiff?: StateDiffCalculator) {
    this.deps = deps;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = deps.logger;
    this.stateDiff = stateDiff;

    // Wire optional StrategyTemplateRegistry into StrategyManager for auto-templating
    if (deps.strategyTemplateRegistry) {
      deps.strategyManager.setStrategyTemplateRegistry(deps.strategyTemplateRegistry);
    }
  }

  // ─── Public API ───

  /**
   * Run the full loop until completion or stop condition.
   * @param options.maxIterations - Override config.maxIterations for this run only (e.g. per-cycle budget from DaemonRunner).
   */
  async run(goalId: string, options?: { maxIterations?: number }): Promise<LoopResult> {
    const startedAt = new Date().toISOString();
    this.stopped = false;
    // Reset state diff tracking for each run (snapshots are in-memory only)
    this.stateDiffState.clear();
    // Reset auto-decompose tracking for each run
    this.decomposedGoals.clear();

    // Load and validate goal
    const goal = await this.deps.stateManager.loadGoal(goalId);
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
      const msg = `Goal "${goalId}" cannot be run: status is "${goal.status}" (expected "active" or "waiting")`;
      this.logger?.error(msg);
      return {
        goalId,
        totalIterations: 0,
        finalStatus: "error",
        errorMessage: msg,
        iterations: [],
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    // Reset stall escalation state at the beginning of each run so prior
    // run's escalation does not immediately poison a fresh start.
    for (const dim of goal.dimensions) {
      await this.deps.stallDetector.resetEscalation(goalId, dim.name);
    }

    // Restore dimension/trust state from checkpoint if present (§4.8).
    const startLoopIndex = await restoreLoopCheckpoint(
      this.deps.stateManager,
      goalId,
      this.config.adapterType,
      this.deps.trustManager
    );

    const iterations: LoopIterationResult[] = [];
    let totalTokens = 0;
    let consecutiveErrors = 0;
    let consecutiveDenied = 0;
    let consecutiveEscalations = 0;
    let finalStatus: LoopResult["finalStatus"] = "max_iterations";

    // Effective maxIterations: runtime override takes precedence over config.
    const effectiveMaxIterations = options?.maxIterations ?? this.config.maxIterations;

    // Use the provided iterationBudget if set; otherwise create a local one.
    const budget: IterationBudget = this.config.iterationBudget
      ?? new IterationBudget(effectiveMaxIterations);

    // Per-node iteration tracking for tree mode.
    const nodeConsumedMap = new Map<string, number>();

    for (let loopIndex = startLoopIndex; loopIndex < startLoopIndex + effectiveMaxIterations; loopIndex++) {
      if (this.stopped) {
        finalStatus = "stopped";
        break;
      }

      if (budget.exhausted) {
        this.logger?.info("Iteration budget exhausted, stopping loop");
        break;
      }

      void this.deps.hookManager?.emit("LoopCycleStart", { goal_id: goalId, data: { loopIndex } });

      let iterationResult: LoopIterationResult;
      try {
        iterationResult = this.config.treeMode && this.deps.treeLoopOrchestrator
          ? await this.runTreeIteration(goalId, loopIndex, nodeConsumedMap)
          : await this.runOneIteration(goalId, loopIndex, loopIndex === startLoopIndex);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger?.error(`[CoreLoop] unexpected error in iteration ${loopIndex}: ${msg}`);
        consecutiveErrors++;
        if (consecutiveErrors >= this.config.maxConsecutiveErrors) {
          finalStatus = "error";
          break;
        }
        continue;
      }

      // Carry forward gapAggregate from the previous iteration when this one was skipped.
      if (iterationResult.skipped && iterations.length >= 1) {
        iterationResult.gapAggregate = iterations[iterations.length - 1]!.gapAggregate;
      }

      // Only consume budget for non-skipped iterations.
      if (!iterationResult.skipped) {
        const { allowed, warnings } = budget.consume();
        for (const w of warnings) { this.logger?.warn(w); }
        if (!allowed) {
          this.logger?.info("Iteration budget exhausted, stopping loop");
          break;
        }
      }
      void this.deps.hookManager?.emit("LoopCycleEnd", { goal_id: goalId, data: { loopIndex, status: iterationResult.error ? "error" : "ok" } });

      iterations.push(iterationResult);
      // Accumulate token usage from iteration.
      totalTokens += iterationResult.tokensUsed ?? 0;

      // Save checkpoint after each successful verify step (§4.8)
      if (!this.config.dryRun && iterationResult.error === null && iterationResult.taskResult !== null) {
        await saveLoopCheckpoint(
          this.deps.stateManager,
          goalId,
          loopIndex,
          iterationResult,
          this.config.adapterType,
          this.deps.trustManager,
          this.logger
        );
      }

      // Check completion (R1-2: must complete at least minIterations before exiting)
      if (iterationResult.completionJudgment.is_complete &&
          loopIndex >= (this.config.minIterations ?? 1) - 1) {
        finalStatus = "completed";
        void this.deps.hookManager?.emit("GoalStateChange", { goal_id: goalId, data: { newStatus: "completed" } });
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
        void this.deps.hookManager?.emit("GoalStateChange", { goal_id: goalId, data: { newStatus: "stalled" } });
        break;
      }

      if (this.stopped) {
        finalStatus = "stopped";
        break;
      }

      // Periodic learning review
      await this.learning.checkPeriodicReview(goalId, this.deps, this.logger);

      // Gap 4: derive a PacingResult from this iteration to feed adaptive delay.
      if (this.timeHorizonEngine) {
        this.lastPacingResult = this.timeHorizonEngine.evaluatePacing(
          goalId,
          iterationResult.gapAggregate,
          null,  // no deadline available at this scope; pacing classifies as no_deadline
          []     // no history; velocity will be zero → critical if gap > 0
        );
      }

      // Delay between loops (skip on last iteration)
      if (loopIndex < startLoopIndex + effectiveMaxIterations - 1 && this.config.delayBetweenLoopsMs > 0) {
        // Gap 4: adaptive observation frequency — scale delay by pacing status when
        // a TimeHorizonEngine is available. Falls back to fixed delayBetweenLoopsMs.
        let delay = this.config.delayBetweenLoopsMs;
        if (this.timeHorizonEngine && this.lastPacingResult) {
          delay = this.timeHorizonEngine.suggestObservationInterval(this.lastPacingResult, delay);
        }
        await sleep(delay);
      }
    }

    // Run post-loop hooks (curiosity, memory lifecycle, archive, final report)
    await runPostLoopHooks({
      goalId,
      finalStatus,
      iterations,
      deps: this.deps,
      config: this.config,
      logger: this.logger,
      tryGenerateReport: (id, idx, r, g) => generateLoopReport(id, idx, r, g, this.deps.reportingEngine, this.logger),
    });

    if (finalStatus === "completed") {
      await this.learning.onGoalCompleted(goalId, this.deps, this.logger);
    }

    return {
      goalId,
      totalIterations: iterations.length,
      finalStatus,
      iterations,
      startedAt,
      completedAt: new Date().toISOString(),
      tokensUsed: totalTokens,
    };
  }

  /**
   * Run a single iteration of the loop.
   */
  async runOneIteration(
    goalId: string,
    loopIndex: number,
    isFirstIteration?: boolean
  ): Promise<LoopIterationResult> {
    const startTime = Date.now();
    const ctx: PhaseCtx = { deps: this.deps, config: this.config, logger: this.logger, toolExecutor: this.deps.toolExecutor, timeHorizonEngine: this.timeHorizonEngine };

    // Default result (filled in progressively)
    const result: LoopIterationResult = makeEmptyIterationResult(goalId, loopIndex);

    this.logger?.info(`[CoreLoop] iteration ${loopIndex + 1} starting`, { goalId, loopIndex });

    // 1. Load goal + tree aggregation
    const loadedGoal = await loadGoalWithAggregation(ctx, goalId, result, startTime);
    if (!loadedGoal) return result;
    let goal = loadedGoal;

    await phaseAutoDecompose(goalId, goal, this.deps, this.config, this.logger, this.decomposedGoals, isFirstIteration);

    // After decomposition: if children were created, reload and switch to tree mode.
    if (!goal.children_ids.length) {
      const reloadedAfterDecompose = await this.deps.stateManager.loadGoal(goalId);
      if (reloadedAfterDecompose && reloadedAfterDecompose.children_ids.length > 0) {
        goal = reloadedAfterDecompose;
        if (this.deps.treeLoopOrchestrator) {
          this.config = { ...this.config, treeMode: true };
          this.logger?.info("[CoreLoop] treeMode enabled after auto-decomposition", { goalId, childrenCount: goal.children_ids.length });
        }
      }
    }

    // 2. Observe + reload
    goal = await observeAndReload(ctx, goalId, goal, loopIndex);

    // 2b. State diff check (Pillar 2: State Diff + Loop Skip)
    if (this.stateDiff) {
      const { shouldSkip } = await runStateDiffCheck(
        this.stateDiff, this.stateDiffState, goalId, goal,
        loopIndex, this.config, this.deps, result, startTime, this.logger
      );
      if (shouldSkip) return result;
    }

    // 3. Gap calculate + zero check
    const gapResult = await calculateGapOrComplete(ctx, goalId, goal, loopIndex, result, startTime);
    if (!gapResult) return result;
    const { gapVector, gapAggregate, skipTaskGeneration } = gapResult;

    this.logger?.info(`[iter ${loopIndex}] gap: ${gapAggregate.toFixed(2)} | ${(gapVector.gaps ?? []).map((g: any) => `${g.dimension_name}=${g.normalized_weighted_gap.toFixed(2)}`).join(', ')}`);

    // 4. Drive scoring + knowledge gap check (skip when gap=0 — no task needed)
    let driveScores: import("../../base/types/drive.js").DriveScore[] = [];
    let highDissatisfactionDimensions: string[] = [];
    if (!skipTaskGeneration) {
      const driveResult = await scoreDrivesAndCheckKnowledge(
        ctx, goalId, goal, gapVector, loopIndex, result, startTime,
        (id, idx, r, g) => generateLoopReport(id, idx, r, g, this.deps.reportingEngine, this.logger)
      );
      if (!driveResult) return result;
      driveScores = driveResult.driveScores;
      highDissatisfactionDimensions = driveResult.highDissatisfactionDimensions;
    }

    // 5. Completion check + milestones
    await checkCompletionAndMilestones(ctx, goalId, goal, result, startTime);
    if (result.error) return result;

    // 6. Stall detection + rebalance
    await detectStallsAndRebalance(ctx, goalId, goal, result);

    if (result.stallDetected && result.stallReport) {
      this.logger?.warn(`[iter ${loopIndex}] stall detected: ${result.stallReport.stall_type}`, { escalation: result.stallReport.escalation_level });
    }

    if (skipTaskGeneration) {
      await generateLoopReport(goalId, loopIndex, result, goal, this.deps.reportingEngine, this.logger);
      result.elapsedMs = Date.now() - startTime;
      return result;
    }

    // 6b. Dependency block check
    if (checkDependencyBlock(ctx, goalId, result)) return result;

    // 6c. TaskGroup detection and routing (M15 Phase 2)
    const tookParallelPath = await tryParallelExecution(
      goalId, goal, gapAggregate, result, startTime, this.deps, loopIndex, this.logger
    );
    if (tookParallelPath) return result;

    // 7. Task cycle with context
    const loopCallbacks: LoopCallbacks = {
      handleCapabilityAcquisition: (task, gId, adapter) => handleCapabilityAcquisition(
        task as Parameters<typeof handleCapabilityAcquisition>[0],
        gId,
        adapter as Parameters<typeof handleCapabilityAcquisition>[2],
        this.deps.capabilityDetector,
        this.learning.getCapabilityFailures(),
        this.logger
      ),
      incrementTransferCounter: () => this.learning.incrementTransferCounter(),
      tryGenerateReport: (id, idx, r, g) => generateLoopReport(id, idx, r, g, this.deps.reportingEngine, this.logger),
    };
    const taskCycleOk = await runTaskCycleWithContext(
      ctx, goalId, goal, gapVector, driveScores, highDissatisfactionDimensions, loopIndex, result, startTime,
      loopCallbacks
    );
    if (!taskCycleOk) return result;

    // 8. Report
    await generateLoopReport(goalId, loopIndex, result, goal, this.deps.reportingEngine, this.logger);

    result.elapsedMs = Date.now() - startTime;
    return result;
  }

  /**
   * Tree-mode iteration: select one node via TreeLoopOrchestrator, run a
   * normal observe→gap→score→task cycle on that node, then aggregate upward.
   */
  async runTreeIteration(rootId: string, loopIndex: number, nodeConsumedMap: Map<string, number>): Promise<LoopIterationResult> {
    return runTreeIterationImpl(rootId, loopIndex, this.deps, this.config, this.logger,
      (id, idx) => this.runOneIteration(id, idx), nodeConsumedMap);
  }

  /**
   * Run one iteration of the multi-goal loop.
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
   * Attach a TimeHorizonEngine for adaptive observation frequency (Gap 4).
   * When set, the delay between iterations is scaled by pacing status instead
   * of using the fixed delayBetweenLoopsMs value.
   */
  setTimeHorizonEngine(engine: ITimeHorizonEngine): void {
    this.timeHorizonEngine = engine;
  }

  /**
   * Check if the loop has been stopped.
   */
  isStopped(): boolean {
    return this.stopped;
  }

}
