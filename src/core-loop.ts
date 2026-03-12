import type { StateManager } from "./state-manager.js";
import type { ObservationEngine } from "./observation-engine.js";
import type { TaskLifecycle, TaskCycleResult } from "./task-lifecycle.js";
import type { SatisficingJudge } from "./satisficing-judge.js";
import type { StallDetector } from "./stall-detector.js";
import type { StrategyManager } from "./strategy-manager.js";
import type { DriveSystem } from "./drive-system.js";
import type { AdapterRegistry, IAdapter } from "./adapter-layer.js";
import type { KnowledgeManager } from "./knowledge-manager.js";
import type { CapabilityDetector } from "./capability-detector.js";
import type { Goal } from "./types/goal.js";
import type { GapVector } from "./types/gap.js";
import type { DriveContext, DriveScore } from "./types/drive.js";
import type { CompletionJudgment } from "./types/satisficing.js";
import type { StallReport } from "./types/stall.js";

// ─── GapCalculator module interface (pure functions) ───

export interface GapCalculatorModule {
  calculateGapVector: (
    goalId: string,
    dimensions: Goal["dimensions"],
    globalUncertaintyWeight?: number
  ) => GapVector;
  aggregateGaps: (
    childGaps: number[],
    method?: "max" | "weighted_avg" | "sum",
    weights?: number[]
  ) => number;
}

// ─── DriveScorerModule interface (pure functions) ───

export interface DriveScorerModule {
  scoreAllDimensions: (
    gapVector: GapVector,
    context: DriveContext,
    config?: unknown
  ) => DriveScore[];
  rankDimensions: (scores: DriveScore[]) => DriveScore[];
}

// ─── ReportingEngine interface (minimal — being implemented in parallel) ───

export interface ExecutionSummaryParams {
  goalId: string;
  loopIndex: number;
  observation: { dimensionName: string; progress: number; confidence: number }[];
  gapAggregate: number;
  taskResult: { taskId: string; action: string; dimension: string } | null;
  stallDetected: boolean;
  pivotOccurred: boolean;
  elapsedMs: number;
}

export interface ReportingEngine {
  generateExecutionSummary(params: ExecutionSummaryParams): unknown;
  saveReport(report: unknown): void;
}

// ─── Config ───

export interface LoopConfig {
  maxIterations?: number;
  maxConsecutiveErrors?: number;
  delayBetweenLoopsMs?: number;
  adapterType?: string;
}

const DEFAULT_CONFIG: Required<LoopConfig> = {
  maxIterations: 100,
  maxConsecutiveErrors: 3,
  delayBetweenLoopsMs: 1000,
  adapterType: "claude_api",
};

// ─── Result types ───

export interface LoopIterationResult {
  loopIndex: number;
  goalId: string;
  gapAggregate: number;
  driveScores: DriveScore[];
  taskResult: TaskCycleResult | null;
  stallDetected: boolean;
  stallReport: StallReport | null;
  pivotOccurred: boolean;
  completionJudgment: CompletionJudgment;
  elapsedMs: number;
  error: string | null;
}

export interface LoopResult {
  goalId: string;
  totalIterations: number;
  finalStatus: "completed" | "stalled" | "max_iterations" | "error" | "stopped";
  iterations: LoopIterationResult[];
  startedAt: string;
  completedAt: string;
}

// ─── Dependencies ───

export interface CoreLoopDeps {
  stateManager: StateManager;
  observationEngine: ObservationEngine;
  gapCalculator: GapCalculatorModule;
  driveScorer: DriveScorerModule;
  taskLifecycle: TaskLifecycle;
  satisficingJudge: SatisficingJudge;
  stallDetector: StallDetector;
  strategyManager: StrategyManager;
  reportingEngine: ReportingEngine;
  driveSystem: DriveSystem;
  adapterRegistry: AdapterRegistry;
  knowledgeManager?: KnowledgeManager;
  capabilityDetector?: CapabilityDetector;
}

// ─── Helpers ───

/**
 * Build DriveContext from goal state.
 * For each dimension, compute hours since last update.
 * Deadline comes from goal.deadline if set.
 */
export function buildDriveContext(goal: Goal): DriveContext {
  const timeSinceLastAttempt: Record<string, number> = {};
  const deadlines: Record<string, number | null> = {};
  const opportunities: Record<string, { value: number; detected_at: string }> = {};

  const now = Date.now();

  for (const dim of goal.dimensions) {
    // Calculate hours since last update
    if (dim.last_updated) {
      const lastUpdated = new Date(dim.last_updated).getTime();
      timeSinceLastAttempt[dim.name] = (now - lastUpdated) / (1000 * 60 * 60);
    } else {
      // No previous attempt — use a large number to indicate high staleness
      timeSinceLastAttempt[dim.name] = 168; // 1 week default
    }

    // Deadline: compute hours remaining from goal.deadline
    if (goal.deadline) {
      const deadlineTime = new Date(goal.deadline).getTime();
      const hoursRemaining = (deadlineTime - now) / (1000 * 60 * 60);
      deadlines[dim.name] = hoursRemaining;
    } else {
      deadlines[dim.name] = null;
    }
  }

  return {
    time_since_last_attempt: timeSinceLastAttempt,
    deadlines,
    opportunities,
  };
}

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
  private stopped = false;

  constructor(deps: CoreLoopDeps, config?: LoopConfig) {
    this.deps = deps;
    this.config = { ...DEFAULT_CONFIG, ...config };
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

      const iterationResult = await this.runOneIteration(goalId, loopIndex);
      iterations.push(iterationResult);

      // Check completion
      if (iterationResult.completionJudgment.is_complete) {
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

      // Delay between loops (skip on last iteration)
      if (loopIndex < this.config.maxIterations - 1 && this.config.delayBetweenLoopsMs > 0) {
        await sleep(this.config.delayBetweenLoopsMs);
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
      result.elapsedMs = Date.now() - startTime;
      return result;
    }

    // ─── 2. Observe ───
    // Build self_report observation methods from goal dimensions and observe.
    try {
      const methods = goal.dimensions.map((dim) => ({
        type: "manual" as const,
        source: `self_report:${dim.name}`,
        schedule: null,
        endpoint: null,
        confidence_tier: "self_report" as const,
      }));
      // observe() is an extension point; call it if available on the engine
      const engine = this.deps.observationEngine as unknown as {
        observe?: (goalId: string, methods: unknown[]) => Promise<void> | void;
      };
      if (typeof engine.observe === "function") {
        await engine.observe(goalId, methods);
        // Reload goal after observation to pick up any updates
        const reloaded = this.deps.stateManager.loadGoal(goalId);
        if (reloaded) {
          goal = reloaded;
        }
      }
    } catch (err) {
      // Observation failure is non-fatal — continue with current goal state
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
      result.elapsedMs = Date.now() - startTime;
      return result;
    }

    // ─── 4. Drive Scoring ───
    let driveScores: DriveScore[];
    try {
      const driveContext = buildDriveContext(goal);
      driveScores = this.deps.driveScorer.scoreAllDimensions(gapVector, driveContext);
      const rankedScores = this.deps.driveScorer.rankDimensions(driveScores);
      result.driveScores = rankedScores;
      driveScores = rankedScores;
    } catch (err) {
      result.error = `Drive scoring failed: ${err instanceof Error ? err.message : String(err)}`;
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
    try {
      const judgment = this.deps.satisficingJudge.isGoalComplete(goal);
      result.completionJudgment = judgment;

      if (judgment.is_complete) {
        // Generate report for completion
        this.tryGenerateReport(goalId, loopIndex, result, goal);
        result.elapsedMs = Date.now() - startTime;
        return result;
      }
    } catch (err) {
      result.error = `Completion check failed: ${err instanceof Error ? err.message : String(err)}`;
      result.elapsedMs = Date.now() - startTime;
      return result;
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

          const newStrategy = await this.deps.strategyManager.onStallDetected(goalId, 2);
          if (newStrategy) {
            result.pivotOccurred = true;
          }
        }
      }
    } catch (err) {
      // Stall detection errors are non-fatal — log and continue
      // (we still want to run the task cycle)
    }

    // ─── 7. Task Cycle ───
    try {
      const driveContext = buildDriveContext(goal);
      const adapter = this.deps.adapterRegistry.getAdapter(this.config.adapterType);

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

      const taskResult = await this.deps.taskLifecycle.runTaskCycle(
        goalId,
        gapVector,
        driveContext,
        adapter,
        knowledgeContext
      );
      result.taskResult = taskResult;

      // Re-check completion after task execution
      const updatedGoal = this.deps.stateManager.loadGoal(goalId);
      if (updatedGoal) {
        const postTaskJudgment = this.deps.satisficingJudge.isGoalComplete(updatedGoal);
        result.completionJudgment = postTaskJudgment;
      }
    } catch (err) {
      result.error = `Task cycle failed: ${err instanceof Error ? err.message : String(err)}`;
      result.elapsedMs = Date.now() - startTime;
      this.tryGenerateReport(goalId, loopIndex, result, goal);
      return result;
    }

    // ─── 8. Report ───
    this.tryGenerateReport(goalId, loopIndex, result, goal);

    result.elapsedMs = Date.now() - startTime;
    return result;
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
