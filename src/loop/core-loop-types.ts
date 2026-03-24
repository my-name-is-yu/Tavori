import { CuriosityEngine } from "../traits/curiosity-engine.js";
import type { Logger } from "../runtime/logger.js";
import type { TrustManager } from "../traits/trust-manager.js";
import type { KnowledgeTransfer } from "../knowledge/knowledge-transfer.js";
import type { TransferCandidate } from "../types/cross-portfolio.js";
import type { CrossGoalPortfolio } from "../strategy/cross-goal-portfolio.js";
import type { GoalTreeManager } from "../goal/goal-tree-manager.js";
import type { StateAggregator } from "../goal/state-aggregator.js";
import type { TreeLoopOrchestrator } from "../goal/tree-loop-orchestrator.js";
import type { StateManager } from "../state-manager.js";
import type { ObservationEngine } from "../observation/observation-engine.js";
import type { TaskLifecycle, TaskCycleResult } from "../execution/task-lifecycle.js";
import type { SatisficingJudge } from "../drive/satisficing-judge.js";
import type { StallDetector } from "../drive/stall-detector.js";
import type { StrategyManager } from "../strategy/strategy-manager.js";
import type { DriveSystem } from "../drive/drive-system.js";
import type { AdapterRegistry, IAdapter } from "../execution/adapter-layer.js";
import type { KnowledgeManager } from "../knowledge/knowledge-manager.js";
import type { CapabilityDetector } from "../observation/capability-detector.js";
import type { CapabilityAcquisitionTask } from "../types/capability.js";
import type { PortfolioManager } from "../portfolio-manager.js";
import type { GoalDependencyGraph } from "../goal/goal-dependency-graph.js";
import type { LearningPipeline } from "../knowledge/learning-pipeline.js";
import { DriveScoreAdapter } from "../knowledge/memory-lifecycle.js";
import type { MemoryLifecycleManager } from "../knowledge/memory-lifecycle.js";
import type { ParallelExecutor } from "../execution/parallel-executor.js";
import type { GoalRefiner } from "../goal/goal-refiner.js";
import type { Goal } from "../types/goal.js";
import type { GapVector } from "../types/gap.js";
import type { DriveContext, DriveScore } from "../types/drive.js";
import type { CompletionJudgment } from "../types/satisficing.js";
import type { StallReport, StallAnalysis } from "../types/stall.js";

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
  treeMode?: boolean;  // Enable tree mode (iterate across all tree nodes)
  multiGoalMode?: boolean;  // Enable multi-goal mode (iterate across multiple goals)
  goalIds?: string[];       // List of goal IDs to manage in multi-goal mode
  /**
   * Minimum number of iterations to run before the loop can exit on completion.
   * Default: 1 (at least one full task cycle always runs before declaring complete).
   * Setting to 2 forces two full iterations even if the goal is already satisfied after iteration 1.
   */
  minIterations?: number;
  /**
   * Whether to automatically archive a completed goal at the end of run().
   * Default: false — archiving is an irreversible action and should be triggered explicitly
   * (e.g. via `tavori goal archive <id>` CLI command or by setting this flag intentionally).
   */
  autoArchive?: boolean;
  /**
   * When true, suppress loop-level persistence side effects: checkpoint writes,
   * final goal status updates, and archive operations.
   */
  dryRun?: boolean;
}

// ─── Result types ───

export interface LoopIterationResult {
  loopIndex: number;
  goalId: string;
  gapAggregate: number;
  driveScores: DriveScore[];
  taskResult: TaskCycleResult | null;
  stallDetected: boolean;
  stallReport: StallReport | null;
  /** M14-S2: cause analysis result when a stall is detected */
  stallAnalysis?: StallAnalysis;
  pivotOccurred: boolean;
  completionJudgment: CompletionJudgment;
  elapsedMs: number;
  error: string | null;
  /** Alerts for milestones that are at_risk or behind (optional) */
  milestoneAlerts?: Array<{ goalId: string; status: string; pace_ratio: number }>;
  /** Transfer candidates detected from cross-goal knowledge (suggestion-only, Phase 1) */
  transfer_candidates?: TransferCandidate[];
}

export interface LoopResult {
  goalId: string;
  totalIterations: number;
  finalStatus: "completed" | "stalled" | "max_iterations" | "error" | "stopped";
  iterations: LoopIterationResult[];
  startedAt: string;
  completedAt: string;
  /** Human-readable explanation when finalStatus is "error" */
  errorMessage?: string;
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
  portfolioManager?: PortfolioManager;
  curiosityEngine?: CuriosityEngine;
  goalDependencyGraph?: GoalDependencyGraph;
  goalTreeManager?: GoalTreeManager;
  stateAggregator?: StateAggregator;
  treeLoopOrchestrator?: TreeLoopOrchestrator;
  crossGoalPortfolio?: CrossGoalPortfolio;
  learningPipeline?: LearningPipeline;
  knowledgeTransfer?: KnowledgeTransfer;
  memoryLifecycleManager?: MemoryLifecycleManager;
  /**
   * Optional adapter that bridges DriveScorer output to MemoryLifecycleManager.
   * When provided, CoreLoop calls adapter.update(driveScores) after each drive
   * scoring step so MemoryLifecycleManager can use live dissatisfaction values
   * for compression delay and relevance scoring.
   *
   * Typical setup (in CLIRunner):
   *   const adapter = new DriveScoreAdapter();
   *   const mlm = new MemoryLifecycleManager(baseDir, llm, config, emb, vec, adapter);
   *   const loop = new CoreLoop({ ..., memoryLifecycleManager: mlm, driveScoreAdapter: adapter });
   */
  driveScoreAdapter?: DriveScoreAdapter;
  /**
   * Optional TrustManager for including per-adapter trust balance in reward logs.
   * When provided, CoreLoop reads the balance for the configured adapterType and
   * includes it in logRewardComputation calls (TAVORI_REWARD_LOG=1).
   */
  trustManager?: TrustManager;
  /**
   * Optional ParallelExecutor for TaskGroup execution (M15 Phase 2).
   * When provided, tasks evaluated as "large" complexity will be decomposed
   * into a TaskGroup and executed in parallel waves.
   * If not provided, all tasks fall through to the normal single-task flow.
   */
  parallelExecutor?: ParallelExecutor;
  /**
   * Optional GoalRefiner. When present, tree-mode decomposition calls refine()
   * instead of raw decomposeGoal(), and observation-failure stalls call reRefineLeaf().
   */
  goalRefiner?: GoalRefiner;
  /**
   * Optional factory function to generate a TaskGroup for a large task.
   * Provided as a callback so the caller owns the llmClient dependency.
   * If not provided (or returns null), the normal single-task flow is used.
   */
  generateTaskGroupFn?: (context: {
    goalDescription: string;
    targetDimension: string;
    currentState: string;
    gap: number;
    availableAdapters: string[];
    contextBlock?: string;
  }) => Promise<import("../types/index.js").TaskGroup | null>;
  logger?: Logger;
  /** Optional context provider for workspace-aware task generation */
  contextProvider?: (goalId: string, dimensionName: string) => Promise<string>;
  /**
   * Optional progress callback. Called at key phases during each iteration so
   * callers (e.g. CLIRunner) can print user-friendly progress lines.
   */
  onProgress?: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
  /** 1-based iteration number */
  iteration: number;
  /** Maximum iterations configured */
  maxIterations: number;
  /** Current phase label */
  phase: string;
  /** Gap aggregate from latest gap calculation (undefined before first gap calc) */
  gap?: number;
  /** Short description of the task being executed (undefined outside execute phase) */
  taskDescription?: string;
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
