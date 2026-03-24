import { sleep } from "./utils/sleep.js";
import type { Logger } from "./runtime/logger.js";
import type { Goal } from "./types/goal.js";
import type { TaskGroup } from "./types/index.js";
import { evaluateTaskComplexity, generateTaskGroup } from "./execution/task-generation.js";
import type { ParallelExecutionResult } from "./execution/parallel-executor.js";

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
import { CoreLoopLearning } from "./loop/core-loop-learning.js";
import { dimensionProgress } from "./drive/gap-calculator.js";

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
  dryRun: false,
};

// ─── CoreLoop ───

/**
 * CoreLoop is the heart of Tavori — it orchestrates one full iteration of the
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
  private readonly learning: CoreLoopLearning = new CoreLoopLearning();

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

    // Reset stall state AND gap history at the beginning of each run so prior
    // run's escalation and stale gap entries do not immediately poison a fresh start.
    for (const dim of goal.dimensions) {
      await this.deps.stallDetector.resetEscalation(goalId, dim.name);
    }
    await this.deps.stateManager.saveGapHistory(goalId, []);

    // Restore dimension/trust state from checkpoint if present (§4.8), but always
    // start loopIndex at 0 so --max-iterations is per-run, not cumulative across runs.
    // NOTE: this checkpoint (goals/<goalId>/checkpoint.json) is for crash-recovery state
    // (dimension values, trust balance) — NOT for resuming loop count.  It is distinct
    // from CheckpointManager in src/execution/checkpoint-manager.ts, which handles
    // multi-agent session transfer (passing state from one agent session to another).
    const startLoopIndex = 0;
    try {
      const checkpoint = await this.deps.stateManager.readRaw(`goals/${goalId}/checkpoint.json`);
      if (
        checkpoint &&
        typeof checkpoint === "object" &&
        typeof (checkpoint as Record<string, unknown>).cycle_number === "number"
      ) {
        const cp = checkpoint as {
          cycle_number: number;
          last_verified_task_id?: string;
          dimension_snapshot?: Record<string, number>;
          trust_snapshot?: number;
          timestamp?: string;
        };
        // Restore dimension values from snapshot
        if (cp.dimension_snapshot && typeof cp.dimension_snapshot === "object") {
          const goalData = await this.deps.stateManager.readRaw(`goals/${goalId}/goal.json`);
          if (goalData && typeof goalData === "object") {
            const goalObj = goalData as Record<string, unknown>;
            const dims = goalObj.dimensions as Array<Record<string, unknown>> | undefined;
            if (dims) {
              for (const dim of dims) {
                const snapshotVal = cp.dimension_snapshot[String(dim.name)];
                if (typeof snapshotVal === "number") {
                  dim.current_value = snapshotVal;
                }
              }
              await this.deps.stateManager.writeRaw(`goals/${goalId}/goal.json`, goalObj);
            }
          }
        }
        // Restore trust balance for the adapter domain from snapshot
        if (typeof cp.trust_snapshot === "number" && this.deps.trustManager) {
          try {
            await this.deps.trustManager.setOverride(
              this.config.adapterType,
              cp.trust_snapshot,
              "checkpoint_restore"
            );
          } catch {
            // Non-fatal — trust restore failure should not abort the run
          }
        }
      }
    } catch {
      // Checkpoint restore failure is non-fatal — start from beginning
    }

    const iterations: LoopIterationResult[] = [];
    let consecutiveErrors = 0;
    let consecutiveDenied = 0;
    let consecutiveEscalations = 0;
    let finalStatus: LoopResult["finalStatus"] = "max_iterations";

    for (let loopIndex = startLoopIndex; loopIndex < this.config.maxIterations; loopIndex++) {
      if (this.stopped) {
        finalStatus = "stopped";
        break;
      }

      const iterationResult = this.config.treeMode && this.deps.treeLoopOrchestrator
        ? await this.runTreeIteration(goalId, loopIndex)
        : await this.runOneIteration(goalId, loopIndex);
      iterations.push(iterationResult);

      // Save checkpoint after each successful verify step (§4.8)
      if (!this.config.dryRun && iterationResult.error === null && iterationResult.taskResult !== null) {
        try {
          const currentGoalForCp = await this.deps.stateManager.readRaw(`goals/${goalId}/goal.json`);
          const dimensionSnapshot: Record<string, number> = {};
          if (currentGoalForCp && typeof currentGoalForCp === "object") {
            const dims = (currentGoalForCp as Record<string, unknown>).dimensions as
              | Array<Record<string, unknown>>
              | undefined;
            if (dims) {
              for (const dim of dims) {
                if (typeof dim.name === "string" && typeof dim.current_value === "number") {
                  dimensionSnapshot[dim.name] = dim.current_value;
                }
              }
            }
          }
          let trustSnapshot: number | undefined;
          if (this.deps.trustManager) {
            try {
              const trustBalance = await this.deps.trustManager.getBalance(this.config.adapterType);
              trustSnapshot = trustBalance.balance;
            } catch {
              // Non-fatal
            }
          }
          await this.deps.stateManager.writeRaw(`goals/${goalId}/checkpoint.json`, {
            cycle_number: loopIndex + 1,
            last_verified_task_id: iterationResult.taskResult.task.id,
            dimension_snapshot: dimensionSnapshot,
            trust_snapshot: trustSnapshot,
            timestamp: new Date().toISOString(),
          });
        } catch {
          // Checkpoint save failure is non-fatal
        }
      }

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
      await this.learning.checkPeriodicReview(goalId, this.deps, this.logger);

      // Delay between loops (skip on last iteration)
      if (loopIndex < this.config.maxIterations - 1 && this.config.delayBetweenLoopsMs > 0) {
        await sleep(this.config.delayBetweenLoopsMs);
      }
    }

    // Persist final status to disk before post-loop hooks
    if (finalStatus === "completed" && !this.config.dryRun) {
      try {
        const goalState = await this.deps.stateManager.loadGoal(goalId);
        if (goalState) {
          goalState.status = "completed";
          await this.deps.stateManager.saveGoal(goalState);
        }
      } catch (err) {
        this.logger?.warn("CoreLoop: failed to persist final status", { goalId, finalStatus, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // After loop completes, check curiosity triggers if engine is available
    if (this.deps.curiosityEngine && (finalStatus === "completed" || finalStatus === "max_iterations")) {
      try {
        this.deps.curiosityEngine.checkAutoExpiration();

        const currentGoal = await this.deps.stateManager.loadGoal(goalId);
        if (currentGoal) {
          const allGoals = [currentGoal];
          if (await this.deps.curiosityEngine.shouldExplore(allGoals)) {
            const triggers = await this.deps.curiosityEngine.evaluateTriggers(allGoals);
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
    if (finalStatus === "completed") {
      await this.learning.onGoalCompleted(goalId, this.deps, this.logger);
    }

    // Trigger memory lifecycle close on completion
    if (this.deps.memoryLifecycleManager && finalStatus === "completed") {
      try {
        await this.deps.memoryLifecycleManager.onGoalClose(goalId, "completed");
      } catch (err) {
        // non-fatal
        this.logger?.warn("CoreLoop: memoryLifecycleManager.onGoalClose failed", { goalId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Archive goal state on completion (only when autoArchive is explicitly enabled)
    if (finalStatus === "completed" && this.config.autoArchive && !this.config.dryRun) {
      try {
        await this.deps.stateManager.archiveGoal(goalId);
      } catch (err) {
        // non-fatal
        this.logger?.warn("CoreLoop: stateManager.archiveGoal failed", { goalId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Save a final run report for non-completed exits (max_iterations, error, stalled, stopped).
    // Per-iteration reports are saved inside runOneIteration, but when an iteration exits early
    // (e.g. gap calculation error, dependency block) no report is written for that iteration.
    // This guarantees at least one report exists after every run so `tavori status` can display it.
    if (finalStatus !== "completed" && iterations.length > 0) {
      try {
        const finalGoal = await this.deps.stateManager.loadGoal(goalId);
        if (finalGoal) {
          const lastIteration = iterations[iterations.length - 1]!;
          await this.tryGenerateReport(goalId, lastIteration.loopIndex, lastIteration, finalGoal);
        }
      } catch (err) {
        // non-fatal
        this.logger?.warn("CoreLoop: final run report generation failed", { goalId, finalStatus, error: err instanceof Error ? err.message : String(err) });
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
    const loadedGoal = await loadGoalWithAggregation(ctx, goalId, result, startTime);
    if (!loadedGoal) return result;
    let goal = loadedGoal;

    // 2. Observe + reload
    goal = await observeAndReload(ctx, goalId, goal, loopIndex);

    // 3. Gap calculate + zero check
    const gapResult = await calculateGapOrComplete(ctx, goalId, goal, loopIndex, result, startTime);
    if (!gapResult) {
      // null means a hard error occurred — result.error is already set
      return result;
    }
    const { gapVector, gapAggregate, skipTaskGeneration } = gapResult;

    // 4. Drive scoring + knowledge gap check (skip when gap=0 — no task needed)
    let driveScores: import("./types/drive.js").DriveScore[] = [];
    let highDissatisfactionDimensions: string[] = [];
    if (!skipTaskGeneration) {
      const driveResult = await scoreDrivesAndCheckKnowledge(
        ctx, goalId, goal, gapVector, loopIndex, result, startTime,
        (id, idx, r, g) => this.tryGenerateReport(id, idx, r, g)
      );
      if (!driveResult) return result;
      driveScores = driveResult.driveScores;
      highDissatisfactionDimensions = driveResult.highDissatisfactionDimensions;
    }

    // 5. Completion check + milestones
    await checkCompletionAndMilestones(ctx, goalId, goal, result, startTime);
    if (result.error) return result;

    // 6. Stall detection + rebalance
    // Run even when gap=0 (skipTaskGeneration=true): if gap=0 persists but
    // is_complete=false (e.g. waiting for double-confirmation), stall detection
    // must still fire so the loop can escalate rather than spin indefinitely.
    await detectStallsAndRebalance(ctx, goalId, goal, result);

    // When gap=0, SatisficingJudge in Phase 5 is the authority on completion.
    // If it says not complete (e.g. low confidence), continue the loop normally
    // but skip task generation since there is no gap to close.
    if (skipTaskGeneration) {
      await this.tryGenerateReport(goalId, loopIndex, result, goal);
      result.elapsedMs = Date.now() - startTime;
      return result;
    }

    // 6b. Dependency block check
    if (checkDependencyBlock(ctx, goalId, result)) return result;

    // 6c. TaskGroup detection and routing (M15 Phase 2)
    // When parallelExecutor and generateTaskGroupFn are both provided, attempt
    // to decompose large tasks into a TaskGroup and execute in parallel waves.
    if (this.deps.parallelExecutor && this.deps.generateTaskGroupFn) {
      const parallelResult = await this.tryRunParallel(
        goalId, goal, gapAggregate, result, startTime
      );
      if (parallelResult !== null) {
        // Parallel path completed — skip normal task cycle
        await this.tryGenerateReport(goalId, loopIndex, result, goal);
        result.elapsedMs = Date.now() - startTime;
        return result;
      }
      // parallelResult === null means TaskGroup decomposition was skipped or failed;
      // fall through to normal single-task cycle below.
    }

    // 7. Task cycle with context
    const taskCycleOk = await runTaskCycleWithContext(
      ctx, goalId, goal, gapVector, driveScores, highDissatisfactionDimensions, loopIndex, result, startTime,
      (task, gId, adapter) => handleCapabilityAcquisition(
        task as Parameters<typeof handleCapabilityAcquisition>[0],
        gId,
        adapter as Parameters<typeof handleCapabilityAcquisition>[2],
        this.deps.capabilityDetector,
        this.learning.getCapabilityFailures(),
        this.logger
      ),
      () => this.learning.incrementTransferCounter(),
      (id, idx, r, g) => this.tryGenerateReport(id, idx, r, g)
    );
    if (!taskCycleOk) return result;

    // 8. Report
    await this.tryGenerateReport(goalId, loopIndex, result, goal);

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

  /**
   * Attempt TaskGroup decomposition and parallel execution.
   *
   * Returns a ParallelExecutionResult when the parallel path ran successfully,
   * or null when the caller should fall through to the normal single-task cycle.
   * Updates result.taskResult with a synthetic entry reflecting the parallel outcome.
   */
  private async tryRunParallel(
    goalId: string,
    goal: Goal,
    gapAggregate: number,
    result: import("./loop/core-loop-types.js").LoopIterationResult,
    startTime: number
  ): Promise<ParallelExecutionResult | null> {
    const { parallelExecutor, generateTaskGroupFn, adapterRegistry } = this.deps;
    if (!parallelExecutor || !generateTaskGroupFn) return null;

    // Only attempt parallel decomposition for multi-dimension goals (heuristic for "large")
    if (goal.dimensions.length < 2) return null;

    const topDimension = goal.dimensions[0]?.name ?? "";
    const currentState = String(goal.dimensions[0]?.current_value ?? "unknown");
    const availableAdapters = adapterRegistry?.listAdapters() ?? ["default"];

    const contextBlock = this.deps.contextProvider
      ? await this.deps.contextProvider(goalId, topDimension).catch(() => undefined)
      : undefined;

    let group: TaskGroup | null = null;
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
      this.logger?.warn("CoreLoop: generateTaskGroupFn threw, falling back to single-task", {
        goalId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    if (!group) {
      // LLM chose not to decompose — fall through to normal flow
      return null;
    }

    this.logger?.info("CoreLoop: TaskGroup detected, routing to ParallelExecutor", {
      goalId,
      subtaskCount: group.subtasks.length,
    });

    // Determine active strategy for feedback
    let strategyId: string | undefined;
    try {
      const activeStrategy = await this.deps.strategyManager.getActiveStrategy(goalId);
      strategyId = activeStrategy?.id;
    } catch (err) {
      // non-fatal
      this.logger?.warn("CoreLoop: strategyManager.getActiveStrategy failed", { goalId, error: err instanceof Error ? err.message : String(err) });
    }

    let parallelResult: ParallelExecutionResult;
    try {
      parallelResult = await parallelExecutor.execute(group, { goalId, strategy_id: strategyId });
    } catch (err) {
      this.logger?.error("CoreLoop: ParallelExecutor threw, falling back to single-task", {
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

  private async tryGenerateReport(
    goalId: string,
    loopIndex: number,
    iterationResult: LoopIterationResult,
    goal: Goal
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
      await this.deps.reportingEngine.saveReport(report);
    } catch (err) {
      // Report generation failure is non-fatal
      this.logger?.warn("CoreLoop: report generation failed", { goalId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
