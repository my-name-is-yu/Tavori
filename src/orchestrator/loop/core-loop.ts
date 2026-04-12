import { sleep } from "../../base/utils/sleep.js";
import type { StateDiffCalculator } from "./state-diff.js";
import { IterationBudget } from "./iteration-budget.js";
import { saveLoopCheckpoint, restoreLoopCheckpoint } from "./checkpoint-manager-loop.js";
import { runPostLoopHooks } from "./post-loop-hooks.js";
import { generateLoopReport } from "./loop-report-helper.js";

import type { LoopIterationResult, LoopResult } from "./loop-result-types.js";
import type {
  LoopConfig,
  ResolvedLoopConfig,
  CoreLoopDeps,
} from "./core-loop/contracts.js";
import {
  runTreeIteration as runTreeIterationImpl,
  runMultiGoalIteration as runMultiGoalIterationImpl,
} from "./tree-loop-runner.js";
import { type StateDiffState } from "./core-loop/control.js";
import type { ITimeHorizonEngine } from "../../platform/time/time-horizon-engine.js";
import type { PacingResult } from "../../base/types/time-horizon.js";
import { CoreLoopLearning } from "./core-loop/learning.js";
import { StaticCorePhasePolicyRegistry } from "./core-loop/phase-policy.js";
import { CoreDecisionEngine } from "./core-loop/decision-engine.js";
import type { CorePhasePolicyRegistry } from "./core-loop/phase-policy.js";
import { CoreIterationKernel } from "./core-loop/iteration-kernel.js";

// Re-export types for backward compatibility
export type {
  GapCalculatorModule,
  DriveScorerModule,
  ExecutionSummaryParams,
  ReportingEngine,
  LoopConfig,
  ResolvedLoopConfig,
  CoreLoopDeps,
  ProgressEvent,
  ProgressPhase,
} from "./core-loop/contracts.js";
export type {
  LoopIterationResult,
  LoopResult,
} from "./loop-result-types.js";
export { buildDriveContext } from "./core-loop/contracts.js";
export { makeEmptyIterationResult } from "./loop-result-types.js";

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
  private readonly logger?: import("../../runtime/logger.js").Logger;
  private stopped = false;
  private readonly learning: CoreLoopLearning = new CoreLoopLearning();
  private readonly corePhasePolicyRegistry: CorePhasePolicyRegistry;
  private readonly coreDecisionEngine: CoreDecisionEngine;
  /** Optional StateDiffCalculator for loop-skip optimization. */
  private readonly stateDiff?: StateDiffCalculator;
  private stateDiffState = new Map<string, StateDiffState>();
  private pendingIterationDirectives = new Map<string, import("./loop-result-types.js").NextIterationDirective>();
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
    this.corePhasePolicyRegistry = deps.corePhasePolicyRegistry ?? new StaticCorePhasePolicyRegistry();
    this.coreDecisionEngine = deps.coreDecisionEngine ?? new CoreDecisionEngine();

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
    const dreamCollector = this.deps.hookManager?.getDreamCollector();
    const sessionId = dreamCollector?.buildSessionId(goalId, startedAt) ?? `${goalId}:${startedAt}`;
    this.stopped = false;
    // Reset state diff tracking for each run (snapshots are in-memory only)
    this.stateDiffState.clear();
    // Reset auto-decompose tracking for each run
    this.decomposedGoals.clear();
    this.pendingIterationDirectives.clear();

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
    let decisionCounters = {
      consecutiveErrors: 0,
      consecutiveDenied: 0,
      consecutiveEscalations: 0,
    };
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
        decisionCounters = {
          ...decisionCounters,
          consecutiveErrors: decisionCounters.consecutiveErrors + 1,
        };
        if (decisionCounters.consecutiveErrors >= this.config.maxConsecutiveErrors) {
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

      if (!this.config.dryRun && dreamCollector) {
        try {
          await dreamCollector.appendIterationResult({
            goalId,
            sessionId,
            iterationResult,
          });
        } catch (err) {
          this.logger?.warn("CoreLoop: failed to persist dream iteration log", {
            goalId,
            loopIndex,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

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

      const runDecision = this.coreDecisionEngine.evaluateRunDecision({
        iterationResult,
        loopIndex,
        minIterations: this.config.minIterations ?? 1,
        maxConsecutiveErrors: this.config.maxConsecutiveErrors,
        counters: decisionCounters,
      });
      decisionCounters = runDecision.counters;
      if (runDecision.shouldStop && runDecision.finalStatus) {
        finalStatus = runDecision.finalStatus;
        if (finalStatus === "completed" || finalStatus === "stalled") {
          void this.deps.hookManager?.emit("GoalStateChange", { goal_id: goalId, data: { newStatus: finalStatus } });
        }
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
        // Build velocity history from accumulated iterations
        let elapsedMs = 0;
        const startMs = new Date(startedAt).getTime();
        const gapHistory = iterations.map((it) => {
          elapsedMs += it.elapsedMs;
          return {
            timestamp: new Date(startMs + elapsedMs).toISOString(),
            normalizedGap: it.gapAggregate,
          };
        });
        this.lastPacingResult = this.timeHorizonEngine.evaluatePacing(
          goalId,
          iterationResult.gapAggregate,
          goal.deadline ?? null,
          gapHistory
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
    const completedAt = new Date().toISOString();
    await runPostLoopHooks({
      goalId,
      sessionId,
      completedAt,
      totalTokensUsed: totalTokens,
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
      completedAt,
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
    const result = await new CoreIterationKernel({
      deps: this.deps,
      getConfig: () => this.config,
      setConfig: (nextConfig) => {
        this.config = nextConfig;
      },
      logger: this.logger,
      stateDiff: this.stateDiff,
      stateDiffState: this.stateDiffState,
      decomposedGoals: this.decomposedGoals,
      timeHorizonEngine: this.timeHorizonEngine,
      corePhasePolicyRegistry: this.corePhasePolicyRegistry,
      coreDecisionEngine: this.coreDecisionEngine,
      capabilityFailures: this.learning.getCapabilityFailures(),
      incrementTransferCounter: () => this.learning.incrementTransferCounter(),
      getPendingDirective: (id) => this.pendingIterationDirectives.get(id),
    }).run({ goalId, loopIndex, isFirstIteration });
    if (result.nextIterationDirective) {
      this.pendingIterationDirectives.set(goalId, result.nextIterationDirective);
    } else {
      this.pendingIterationDirectives.delete(goalId);
    }
    return result;
  }

  /**
   * Tree-mode iteration: select one node via TreeLoopOrchestrator, run a
   * normal observe→gap→score→task cycle on that node, then aggregate upward.
   */
  async runTreeIteration(rootId: string, loopIndex: number, nodeConsumedMap: Map<string, number>): Promise<LoopIterationResult> {
    return runTreeIterationImpl(rootId, loopIndex, this.deps, this.config, this.logger,
      (id, idx) => this.runOneIteration(id, idx), nodeConsumedMap, {
        getPendingDirective: (id) => this.pendingIterationDirectives.get(id),
      });
  }

  /**
   * Run one iteration of the multi-goal loop.
   */
  async runMultiGoalIteration(loopIndex: number): Promise<LoopIterationResult> {
    return runMultiGoalIterationImpl(loopIndex, this.deps, this.config,
      (id, idx) => this.runOneIteration(id, idx), {
        getPendingDirective: (id) => this.pendingIterationDirectives.get(id),
      });
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
