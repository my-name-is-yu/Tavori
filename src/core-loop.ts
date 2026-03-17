import type { Logger } from "./runtime/logger.js";
import type { TaskCycleResult } from "./execution/task-lifecycle.js";
import type { IAdapter } from "./execution/adapter-layer.js";
import type { CapabilityDetector } from "./observation/capability-detector.js";
import type { CapabilityAcquisitionTask } from "./types/capability.js";
import { DriveScoreAdapter } from "./knowledge/memory-lifecycle.js";
import type { Goal } from "./types/goal.js";
import type { GapVector } from "./types/gap.js";
import type { DriveScore } from "./types/drive.js";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
        // Expire old proposals
        this.deps.curiosityEngine.checkAutoExpiration();

        // Reload goal to get latest state
        const currentGoal = this.deps.stateManager.loadGoal(goalId);
        if (currentGoal) {
          const allGoals = [currentGoal]; // MVP: single goal context

          if (this.deps.curiosityEngine.shouldExplore(allGoals)) {
            const triggers = this.deps.curiosityEngine.evaluateTriggers(allGoals);
            if (triggers.length > 0) {
              await this.deps.curiosityEngine.generateProposals(triggers, allGoals);
            }
          }
        }
      } catch (err) {
        // Curiosity failures should never break the main loop
        this.logger?.warn("CoreLoop: curiosity evaluation failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // After loop completes, trigger learning pipeline for goal completion
    if (this.deps.learningPipeline && finalStatus === "completed") {
      try {
        await this.deps.learningPipeline.onGoalCompleted(goalId);
      } catch {
        // non-fatal: learning pipeline failure should not block main loop
      }
    }

    // Trigger memory lifecycle close on completion
    if (this.deps.memoryLifecycleManager && finalStatus === "completed") {
      try {
        await this.deps.memoryLifecycleManager.onGoalClose(goalId, "completed");
      } catch {
        // non-fatal: memory lifecycle failure should not block main loop
      }
    }

    // Archive goal state on completion (only when autoArchive is explicitly enabled)
    if (finalStatus === "completed" && this.config.autoArchive) {
      try {
        this.deps.stateManager.archiveGoal(goalId);
      } catch {
        // non-fatal: archive failure should not block main loop
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

    // ─── 1. Load goal ───
    let goal: Goal;
    try {
      const loaded = this.deps.stateManager.loadGoal(goalId);
      if (!loaded) {
        result.error = `Goal "${goalId}" not found`;
        result.elapsedMs = Date.now() - startTime;
        return result;
      }
      goal = loaded;
    } catch (err) {
      result.error = `Failed to load goal: ${err instanceof Error ? err.message : String(err)}`;
      this.logger?.error(`CoreLoop: ${result.error}`, { goalId });
      result.elapsedMs = Date.now() - startTime;
      return result;
    }

    // ─── 1b. Tree aggregation ───
    if (this.deps.stateAggregator && goal.children_ids.length > 0) {
      try {
        this.deps.stateAggregator.aggregateChildStates(goalId);
        // Reload goal to pick up aggregated state
        const reloaded = this.deps.stateManager.loadGoal(goalId);
        if (reloaded) {
          goal = reloaded;
        }
      } catch {
        // Tree aggregation failure is non-fatal
      }
    }

    // ─── 2. Observe ───
    // Delegate the full 3-fallback chain to ObservationEngine.observe():
    //   1. DataSource (mechanical) — if a registered source covers the dimension
    //   2. LLM (independent_review) — if llmClient is available and no DataSource
    //   3. self_report — last resort
    // Passing an empty methods array tells observe() to iterate ALL dimensions.
    this.deps.onProgress?.({
      iteration: loopIndex + 1,
      maxIterations: this.config.maxIterations,
      phase: "Observing...",
    });
    try {
      const engine = this.deps.observationEngine as unknown as {
        observe?: (goalId: string, methods: unknown[]) => Promise<void> | void;
        getDataSources?: () => Array<{ sourceId: string }>;
      };

      this.logger?.debug("CoreLoop: engine.getDataSources exists", { exists: typeof engine.getDataSources === "function" });
      const dataSources = typeof engine.getDataSources === "function"
        ? engine.getDataSources()
        : [];
      this.logger?.debug("CoreLoop: observation setup", { dataSourceCount: dataSources.length });

      if (typeof engine.observe === "function") {
        // Empty methods array → observe() iterates all goal.dimensions using
        // its internal priority: DataSource → LLM → self_report
        await engine.observe(goalId, []);
      }

      // Reload goal after observation to pick up any updates
      const reloaded = this.deps.stateManager.loadGoal(goalId);
      if (reloaded) {
        goal = reloaded;
      }
    } catch (err) {
      // Observation failure is non-fatal — continue with current goal state
      this.logger?.warn("CoreLoop: observation failed (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
    }

    // ─── 3. Gap Calculate ───
    let gapVector: GapVector;
    let gapAggregate: number;
    try {
      gapVector = this.deps.gapCalculator.calculateGapVector(
        goalId,
        goal.dimensions,
        goal.uncertainty_weight
      );
      const gapValues = gapVector.gaps.map((g) => g.normalized_weighted_gap);
      gapAggregate = this.deps.gapCalculator.aggregateGaps(
        gapValues,
        goal.gap_aggregation
      );
      result.gapAggregate = gapAggregate;

      // Persist gap history entry
      this.deps.stateManager.appendGapHistoryEntry(goalId, {
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
      this.logger?.error(`CoreLoop: ${result.error}`, { goalId });
      result.elapsedMs = Date.now() - startTime;
      return result;
    }

    // ─── 3b. Gap Zero Check ───
    if (gapAggregate === 0) {
      this.logger?.info(`[CoreLoop] gap=0 for goal ${goalId} — skipping task generation`);
      result.completionJudgment = {
        is_complete: true,
        blocking_dimensions: [],
        low_confidence_dimensions: [],
        needs_verification_task: false,
        checked_at: new Date().toISOString(),
      };
      result.elapsedMs = Date.now() - startTime;
      return result;
    }

    this.deps.onProgress?.({
      iteration: loopIndex + 1,
      maxIterations: this.config.maxIterations,
      phase: "Generating task...",
      gap: gapAggregate,
    });

    // ─── 4. Drive Scoring ───
    let driveScores: DriveScore[];
    try {
      const driveContext = buildDriveContext(goal);
      driveScores = this.deps.driveScorer.scoreAllDimensions(gapVector, driveContext);
      const rankedScores = this.deps.driveScorer.rankDimensions(driveScores);
      result.driveScores = rankedScores;
      driveScores = rankedScores;

      // ─── 4a. Update DriveScoreAdapter for MemoryLifecycleManager ───
      // Propagate fresh dissatisfaction scores so compression delays and
      // relevance scoring in MemoryLifecycleManager reflect the current loop state.
      if (this.deps.driveScoreAdapter) {
        this.deps.driveScoreAdapter.update(driveScores);
      }
    } catch (err) {
      result.error = `Drive scoring failed: ${err instanceof Error ? err.message : String(err)}`;
      this.logger?.error(`CoreLoop: ${result.error}`, { goalId });
      result.elapsedMs = Date.now() - startTime;
      return result;
    }

    // ─── 4b. Knowledge Gap Check ───
    // Runs after drive scoring so strategies can be populated from actual strategy data.
    // strategies: null means "not yet loaded" (different from [] meaning "tried and found none").
    if (this.deps.knowledgeManager) {
      try {
        let strategies: unknown[] | null = null;
        try {
          const portfolio = this.deps.strategyManager.getPortfolio(goalId);
          strategies = portfolio !== null ? portfolio.strategies : null;
        } catch {
          // If strategy loading fails, leave as null (not yet available)
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

        const gapSignal = await this.deps.knowledgeManager.detectKnowledgeGap(observationContext);
        if (gapSignal !== null) {
          // Knowledge gap detected — generate acquisition task and return early
          const acquisitionTask = await this.deps.knowledgeManager.generateAcquisitionTask(
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
          this.tryGenerateReport(goalId, loopIndex, result, goal);
          result.elapsedMs = Date.now() - startTime;
          return result;
        }
      } catch {
        // Knowledge gap detection failure is non-fatal — continue with normal flow
      }
    }

    // ─── 5. Completion Check ───
    // R1-1: We record the pre-task judgment for reporting, but do NOT early-return here.
    // The task cycle always runs within an iteration. Completion is re-evaluated after the
    // task cycle (Step 7 post-task re-check) and the loop exits via the minIterations guard
    // in run() rather than short-circuiting here.
    try {
      const judgment = goal.children_ids.length > 0
        ? this.deps.satisficingJudge.judgeTreeCompletion(goalId)
        : this.deps.satisficingJudge.isGoalComplete(goal);
      result.completionJudgment = judgment;
    } catch (err) {
      result.error = `Completion check failed: ${err instanceof Error ? err.message : String(err)}`;
      this.logger?.error(`CoreLoop: ${result.error}`, { goalId });
      result.elapsedMs = Date.now() - startTime;
      return result;
    }

    // ─── 5b. Milestone Deadline Check ───
    try {
      // Load all sibling/related goals to find milestones (MVP: check the current goal itself)
      const allGoals = [goal];
      // Also load any child goals that may be milestones
      for (const childId of goal.children_ids) {
        const child = this.deps.stateManager.loadGoal(childId);
        if (child) allGoals.push(child);
      }

      const milestones = this.deps.stateManager.getMilestones(allGoals);
      if (milestones.length > 0) {
        const milestoneAlerts: Array<{ goalId: string; status: string; pace_ratio: number }> = [];
        for (const milestone of milestones) {
          // Compute currentAchievement from pace_snapshot if available, else use 0
          const currentAchievement =
            milestone.pace_snapshot?.achievement_ratio ??
            (typeof milestone.dimensions[0]?.current_value === "number"
              ? Math.min((milestone.dimensions[0].current_value as number) / 100, 1)
              : 0);

          const snapshot = this.deps.stateManager.evaluatePace(milestone, currentAchievement);

          // Save updated pace snapshot
          await this.deps.stateManager.savePaceSnapshot(milestone.id, snapshot);

          if (snapshot.status === "at_risk" || snapshot.status === "behind") {
            milestoneAlerts.push({
              goalId: milestone.id,
              status: snapshot.status,
              pace_ratio: snapshot.pace_ratio,
            });
          } else {
            // Milestone is on track or ahead — trigger learning
            if (this.deps.learningPipeline) {
              try {
                await this.deps.learningPipeline.onMilestoneReached(
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
      // Milestone check failure is non-fatal — continue with stall detection
    }

    // ─── 6. Stall Check ───
    try {
      // Load gap history for stall detection
      const gapHistory = this.deps.stateManager.loadGapHistory(goalId);

      // Check each dimension for stalls
      for (const dim of goal.dimensions) {
        const dimGapHistory = gapHistory
          .filter((entry) =>
            entry.gap_vector.some((g) => g.dimension_name === dim.name)
          )
          .map((entry) => {
            const g = entry.gap_vector.find((g) => g.dimension_name === dim.name);
            return { normalized_gap: g?.normalized_weighted_gap ?? 1 };
          });

        const stallReport = this.deps.stallDetector.checkDimensionStall(
          goalId,
          dim.name,
          dimGapHistory
        );

        if (stallReport) {
          result.stallDetected = true;
          result.stallReport = stallReport;

          // Trigger learning pipeline on stall detection
          if (this.deps.learningPipeline) {
            try {
              await this.deps.learningPipeline.onStallDetected(goalId, stallReport);
            } catch {
              // non-fatal: learning pipeline failure should not block main loop
            }
          }

          // Attempt pivot via StrategyManager
          const escalationLevel = this.deps.stallDetector.getEscalationLevel(goalId, dim.name);
          const newStrategy = await this.deps.strategyManager.onStallDetected(
            goalId,
            escalationLevel + 1
          );
          if (newStrategy) {
            result.pivotOccurred = true;
          }

          // Increment escalation
          this.deps.stallDetector.incrementEscalation(goalId, dim.name);
          break; // handle one stall per iteration
        }
      }

      // Check global stall
      if (!result.stallDetected) {
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

        const globalStall = this.deps.stallDetector.checkGlobalStall(goalId, allDimGaps);
        if (globalStall) {
          result.stallDetected = true;
          result.stallReport = globalStall;

          // Trigger learning pipeline on global stall detection
          if (this.deps.learningPipeline) {
            try {
              await this.deps.learningPipeline.onStallDetected(goalId, globalStall);
            } catch {
              // non-fatal: learning pipeline failure should not block main loop
            }
          }

          const newStrategy = await this.deps.strategyManager.onStallDetected(goalId, 2);
          if (newStrategy) {
            result.pivotOccurred = true;
          }
        }
      }

      // Portfolio: check rebalance after stall detection
      if (this.deps.portfolioManager) {
        try {
          const rebalanceTrigger = this.deps.portfolioManager.shouldRebalance(goalId);
          if (rebalanceTrigger) {
            const rebalanceResult = this.deps.portfolioManager.rebalance(goalId, rebalanceTrigger);
            if (rebalanceResult.new_generation_needed) {
              // All strategies terminated — regenerate via strategyManager
              await this.deps.strategyManager.onStallDetected(goalId, 3);
            }
          }
        } catch {
          // Portfolio rebalance errors are non-fatal
        }

        // Portfolio: handle WaitStrategy expiry
        try {
          const portfolio = this.deps.strategyManager.getPortfolio(goalId);
          if (portfolio) {
            for (const strategy of portfolio.strategies) {
              if (this.deps.portfolioManager.isWaitStrategy(strategy)) {
                const waitTrigger = this.deps.portfolioManager.handleWaitStrategyExpiry(
                  goalId,
                  strategy.id
                );
                if (waitTrigger) {
                  this.deps.portfolioManager.rebalance(goalId, waitTrigger);
                }
              }
            }
          }
        } catch {
          // WaitStrategy expiry errors are non-fatal
        }
      }
    } catch (err) {
      // Stall detection errors are non-fatal — log and continue
      // (we still want to run the task cycle)
      this.logger?.warn("CoreLoop: stall detection failed (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
    }

    // ─── 6b. Dependency Graph Scheduling Control ───
    // If the current goal is blocked by unresolved prerequisites, skip task
    // generation for this iteration and proceed directly to reporting.
    if (this.deps.goalDependencyGraph) {
      try {
        if (this.deps.goalDependencyGraph.isBlocked(goalId)) {
          const blockingGoals = this.deps.goalDependencyGraph.getBlockingGoals(goalId);
          result.error = `Goal ${goalId} is blocked by prerequisites: ${blockingGoals.join(", ")}`;
          // Skip task cycle — fall through to reporting
          return result;
        }
      } catch {
        // Dependency graph errors are non-fatal
      }
    }

    // ─── 7. Task Cycle ───
    try {
      const driveContext = buildDriveContext(goal);
      const adapter = this.deps.adapterRegistry.getAdapter(this.config.adapterType);

      // Portfolio: select strategy for next task before generation
      if (this.deps.portfolioManager) {
        try {
          const selectionResult = this.deps.portfolioManager.selectNextStrategyForTask(goalId);
          if (selectionResult) {
            // Wire selected strategy as the active strategy for this task cycle
            // by setting it via the onTaskComplete callback hook on taskLifecycle
            this.deps.taskLifecycle.setOnTaskComplete((strategyId: string) => {
              this.deps.portfolioManager!.recordTaskCompletion(strategyId);
            });
          }
        } catch {
          // Portfolio strategy selection is non-fatal
        }
      }

      // ─── 7a. Collect relevant knowledge context ───
      let knowledgeContext: string | undefined;
      if (this.deps.knowledgeManager) {
        try {
          const topDimension = driveScores[0]?.dimension_name ?? goal.dimensions[0]?.name;
          if (topDimension) {
            const entries = await this.deps.knowledgeManager.getRelevantKnowledge(
              goalId,
              topDimension
            );
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

      // ─── 7b. Pre-task capability check ───
      // Capability detection is handled inside TaskLifecycle.runTaskCycle to avoid
      // generating a persisted preview task that would become an orphan if no gap
      // is found. Duplicate detectDeficiency calls are also avoided this way.

      // ─── 7c. Fetch existing tasks for dedup context (adapter-agnostic) ───
      let existingTasks: string[] | undefined;
      if (adapter.listExistingTasks) {
        try {
          existingTasks = await adapter.listExistingTasks();
        } catch {
          // Non-fatal: proceed without existing tasks context
        }
      }

      // ─── 7d. Collect workspace context for task generation ───
      let workspaceContext: string | undefined;
      if (this.deps.contextProvider) {
        try {
          const topDimension = driveScores[0]?.dimension_name ?? goal.dimensions[0]?.name ?? "";
          workspaceContext = await this.deps.contextProvider(goalId, topDimension);
        } catch {
          // Non-fatal: proceed without workspace context
        }
      }

      this.logger?.debug("CoreLoop: running task cycle", { adapter: adapter.adapterType, goalId });
      this.deps.onProgress?.({
        iteration: loopIndex + 1,
        maxIterations: this.config.maxIterations,
        phase: "Executing task...",
        gap: result.gapAggregate,
      });
      const taskResult = await this.deps.taskLifecycle.runTaskCycle(
        goalId,
        gapVector,
        driveContext,
        adapter,
        knowledgeContext,
        existingTasks,
        workspaceContext
      );
      this.logger?.info("CoreLoop: task cycle result", { action: taskResult.action, taskId: taskResult.task.id });
      result.taskResult = taskResult;
      this.deps.onProgress?.({
        iteration: loopIndex + 1,
        maxIterations: this.config.maxIterations,
        phase: "Verifying result...",
        gap: result.gapAggregate,
        taskDescription: taskResult.task.work_description
          ? taskResult.task.work_description.split("\n")[0]?.slice(0, 80)
          : undefined,
      });

      // ─── Handle capability_acquiring: delegate acquisition to agent ───
      if (taskResult.action === "capability_acquiring" && taskResult.acquisition_task) {
        await this.handleCapabilityAcquisition(taskResult.acquisition_task, goalId, adapter);
      }

      // Portfolio: record task completion for the strategy that generated this task
      if (this.deps.portfolioManager && taskResult.action === "completed" && taskResult.task.strategy_id) {
        try {
          this.deps.portfolioManager.recordTaskCompletion(taskResult.task.strategy_id);
        } catch {
          // Non-fatal
        }
      }

      // Re-check completion after task execution
      const updatedGoal = this.deps.stateManager.loadGoal(goalId);
      if (updatedGoal) {
        const postTaskJudgment = updatedGoal.children_ids.length > 0
          ? this.deps.satisficingJudge.judgeTreeCompletion(updatedGoal.id)
          : this.deps.satisficingJudge.isGoalComplete(updatedGoal);
        result.completionJudgment = postTaskJudgment;
      }
    } catch (err) {
      result.error = `Task cycle failed: ${err instanceof Error ? err.message : String(err)}`;
      this.logger?.error(`CoreLoop: ${result.error}`, { goalId });
      result.elapsedMs = Date.now() - startTime;
      this.tryGenerateReport(goalId, loopIndex, result, goal);
      return result;
    }

    // Track curiosity goal loop count
    if (this.deps.curiosityEngine) {
      const currentGoal = this.deps.stateManager.loadGoal(goalId);
      if (currentGoal?.origin === "curiosity") {
        this.deps.curiosityEngine.incrementLoopCount(goalId);
      }
    }

    // ─── 7c. Transfer Detection (every 5 iterations, suggestion-only) ───
    this.transferCheckCounter++;
    if (this.deps.knowledgeTransfer && this.transferCheckCounter % 5 === 0) {
      try {
        const candidates = await this.deps.knowledgeTransfer.detectTransferOpportunities(goalId);
        if (candidates.length > 0) {
          result.transfer_candidates = candidates;
        }
      } catch {
        // non-fatal: transfer detection failure should not block main loop
      }
    }

    // ─── 8. Report ───
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

  // ─── Capability Acquisition Handler ───

  /**
   * Handles the "capability_acquiring" action from TaskLifecycle.
   * Delegates acquisition to an adapter, verifies the result, and registers
   * the capability on success. Retries up to 3 times before escalating.
   */
  private async handleCapabilityAcquisition(
    acquisitionTask: CapabilityAcquisitionTask,
    goalId: string,
    adapter: IAdapter
  ): Promise<void> {
    const capabilityDetector = this.deps.capabilityDetector;
    if (!capabilityDetector) {
      this.logger?.warn("CoreLoop: capability_acquiring action received but no capabilityDetector configured — skipping");
      return;
    }

    const capName = acquisitionTask.gap.missing_capability.name;
    const capType = acquisitionTask.gap.missing_capability.type;

    this.logger?.info("CoreLoop: handling capability acquisition", { capName, capType, method: acquisitionTask.method });

    // Build prompt from the acquisition task
    const prompt =
      `Capability Acquisition Task\n` +
      `Method: ${acquisitionTask.method}\n` +
      `Description: ${acquisitionTask.task_description}\n` +
      `Success criteria: ${acquisitionTask.success_criteria.join("; ")}\n\n` +
      `Instructions: Please acquire or set up the capability "${capName}" (${capType}). ` +
      `Follow the method "${acquisitionTask.method}" and ensure the success criteria are met.`;

    // Execute via adapter
    let agentResult;
    try {
      agentResult = await adapter.execute({ prompt, timeout_ms: 120000, adapter_type: adapter.adapterType });
    } catch (err) {
      this.logger?.error("CoreLoop: adapter execution failed during capability acquisition", {
        capName,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.recordCapabilityFailure(capabilityDetector, acquisitionTask, goalId);
      return;
    }

    // Build a Capability object for verification
    const capability = {
      id: capName.toLowerCase().replace(/\s+/g, "_"),
      name: capName,
      description: acquisitionTask.task_description,
      type: capType,
      status: "acquiring" as const,
    };

    // Verify the acquired capability
    let verificationResult;
    try {
      verificationResult = await capabilityDetector.verifyAcquiredCapability(
        capability,
        acquisitionTask,
        agentResult
      );
    } catch (err) {
      this.logger?.error("CoreLoop: capability verification threw an error", {
        capName,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.recordCapabilityFailure(capabilityDetector, acquisitionTask, goalId);
      return;
    }

    if (verificationResult === "pass") {
      // Success: register capability and set status to available
      this.capabilityAcquisitionFailures.delete(capName);
      try {
        await capabilityDetector.registerCapability(capability, {
          goal_id: goalId,
          originating_task_id: acquisitionTask.gap.related_task_id,
          acquired_at: new Date().toISOString(),
        });
        await capabilityDetector.setCapabilityStatus(capName, capType, "available");
        this.logger?.info("CoreLoop: capability acquired and registered successfully", { capName });
      } catch (err) {
        this.logger?.error("CoreLoop: failed to register capability after verification pass", {
          capName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (verificationResult === "escalate") {
      // Max verification attempts reached — escalate immediately
      this.capabilityAcquisitionFailures.delete(capName);
      await this.escalateCapability(capabilityDetector, acquisitionTask, goalId);
    } else {
      // "fail" — record failure and check threshold
      await this.recordCapabilityFailure(capabilityDetector, acquisitionTask, goalId);
    }
  }

  /**
   * Records a capability acquisition failure and escalates after 3 consecutive failures.
   */
  private async recordCapabilityFailure(
    capabilityDetector: CapabilityDetector,
    acquisitionTask: CapabilityAcquisitionTask,
    goalId: string
  ): Promise<void> {
    const capName = acquisitionTask.gap.missing_capability.name;
    const currentCount = (this.capabilityAcquisitionFailures.get(capName) ?? 0) + 1;
    this.capabilityAcquisitionFailures.set(capName, currentCount);

    this.logger?.warn("CoreLoop: capability acquisition failed", { capName, failureCount: currentCount });

    if (currentCount >= 3) {
      await this.escalateCapability(capabilityDetector, acquisitionTask, goalId);
    }
  }

  /**
   * Escalates a capability acquisition failure to the user and marks status as verification_failed.
   */
  private async escalateCapability(
    capabilityDetector: CapabilityDetector,
    acquisitionTask: CapabilityAcquisitionTask,
    goalId: string
  ): Promise<void> {
    const capName = acquisitionTask.gap.missing_capability.name;
    const capType = acquisitionTask.gap.missing_capability.type;

    this.logger?.warn("CoreLoop: escalating capability acquisition to user", { capName });
    try {
      await capabilityDetector.escalateToUser(acquisitionTask.gap, goalId);
      await capabilityDetector.setCapabilityStatus(capName, capType, "verification_failed");
    } catch (err) {
      this.logger?.error("CoreLoop: escalation failed", {
        capName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
