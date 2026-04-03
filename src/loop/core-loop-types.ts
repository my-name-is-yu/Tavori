import { CuriosityEngine } from "../traits/curiosity-engine.js";
import type { IterationBudget } from "./iteration-budget.js";
import type { Logger } from "../runtime/logger.js";
import type { StrategyTemplateRegistry } from "../strategy/strategy-template-registry.js";
import type { TrustManager } from "../traits/trust-manager.js";
import type { KnowledgeTransfer } from "../knowledge/transfer/knowledge-transfer.js";
import type { TransferCandidate } from "../types/cross-portfolio.js";
import type { CrossGoalPortfolio } from "../strategy/cross-goal-portfolio.js";
import type { GoalTreeManager } from "../goal/goal-tree-manager.js";
import type { StateAggregator } from "../goal/state-aggregator.js";
import type { TreeLoopOrchestrator } from "../goal/tree-loop-orchestrator.js";
import type { StateManager } from "../state/state-manager.js";
import type { ObservationEngine } from "../observation/observation-engine.js";
import type { TaskLifecycle, TaskCycleResult } from "../execution/task/task-lifecycle.js";
import type { SatisficingJudge } from "../drive/satisficing-judge.js";
import type { StallDetector } from "../drive/stall-detector.js";
import type { StrategyManager } from "../strategy/strategy-manager.js";
import type { DriveSystem } from "../drive/drive-system.js";
import type { AdapterRegistry, IAdapter } from "../execution/adapter-layer.js";
import type { KnowledgeManager } from "../knowledge/knowledge-manager.js";
import type { CapabilityDetector } from "../observation/capability-detector.js";
import type { CapabilityAcquisitionTask } from "../types/capability.js";
import type { PortfolioManager } from "../strategy/portfolio-manager.js";
import type { GoalDependencyGraph } from "../goal/goal-dependency-graph.js";
import type { LearningPipeline } from "../knowledge/learning/learning-pipeline.js";
import { DriveScoreAdapter } from "../knowledge/memory/memory-lifecycle.js";
import type { MemoryLifecycleManager } from "../knowledge/memory/memory-lifecycle.js";
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

/**
 * LoopConfig with all required fields resolved (except iterationBudget which remains optional).
 * Used as the internal config type throughout CoreLoop and its sub-modules.
 */
export type ResolvedLoopConfig = Required<Omit<LoopConfig, "iterationBudget">> & Pick<LoopConfig, "iterationBudget">;

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
   * (e.g. via `pulseed goal archive <id>` CLI command or by setting this flag intentionally).
   */
  autoArchive?: boolean;
  /**
   * When true, suppress loop-level persistence side effects: checkpoint writes,
   * final goal status updates, and archive operations.
   */
  dryRun?: boolean;
  /**
   * Maximum number of consecutive iterations that can be skipped due to no state change
   * (Pillar 2: State Diff + Loop Skip). After this many consecutive skips, the full loop
   * runs regardless so stall detection can fire. Default: 5.
   */
  maxConsecutiveSkips?: number;
  /**
   * When true (default), automatically decompose an abstract goal into sub-goals
   * using TreeLoopOrchestrator.ensureGoalRefined() before the first iteration.
   * Set to false to disable auto-decomposition.
   */
  autoDecompose?: boolean;
  /**
   * Shared iteration budget for parent-child agent trees.
   * When set, all iterations (including child node iterations in tree mode) consume
   * from this budget. Prevents runaway recursion across hierarchical agent invocations.
   * If not set, maxIterations acts as the sole upper bound.
   */
  iterationBudget?: IterationBudget;
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
  /**
   * When true, this iteration was skipped because no meaningful state change was
   * detected (Pillar 2: State Diff + Loop Skip). Only observation ran; gap
   * calculation, task generation, execution, and verification were bypassed.
   */
  skipped?: boolean;
  /** Reason for the skip, when skipped=true. */
  skipReason?: string;
}

/**
 * Factory that returns a zeroed-out LoopIterationResult for the given goalId
 * and loopIndex. Accepts optional overrides for fields that vary per call-site.
 */
export function makeEmptyIterationResult(
  goalId: string,
  loopIndex: number,
  overrides?: Partial<LoopIterationResult>
): LoopIterationResult {
  return {
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
    ...overrides,
  };
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

/** Deps needed for observation phase */
export interface ObservationDeps {
  observationEngine: ObservationEngine;
  stateManager: StateManager;
}

/** Deps needed for tree iteration */
export interface TreeDeps {
  stateManager: StateManager;
  treeLoopOrchestrator?: TreeLoopOrchestrator;
  satisficingJudge: SatisficingJudge;
  goalRefiner?: GoalRefiner;
  goalTreeManager?: GoalTreeManager;
  stateAggregator?: StateAggregator;
}

/** Deps needed for stall detection and recovery */
export interface StallDeps {
  stallDetector: StallDetector;
  strategyManager: StrategyManager;
  knowledgeManager?: KnowledgeManager;
  learningPipeline?: LearningPipeline;
  goalRefiner?: GoalRefiner;
}

/** Deps needed for task execution cycle */
export interface TaskCycleDeps {
  taskLifecycle: TaskLifecycle;
  adapterRegistry: AdapterRegistry;
  portfolioManager?: PortfolioManager;
  knowledgeManager?: KnowledgeManager;
  contextProvider?: (goalId: string, dimensionName: string) => Promise<string>;
}

export interface CoreLoopDeps extends ObservationDeps, TreeDeps, StallDeps, TaskCycleDeps {
  gapCalculator: GapCalculatorModule;
  driveScorer: DriveScorerModule;
  reportingEngine: ReportingEngine;
  driveSystem: DriveSystem;
  capabilityDetector?: CapabilityDetector;
  curiosityEngine?: CuriosityEngine;
  goalDependencyGraph?: GoalDependencyGraph;
  crossGoalPortfolio?: CrossGoalPortfolio;
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
   * includes it in logRewardComputation calls (PULSEED_REWARD_LOG=1).
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
  /**
   * Optional progress callback. Called at key phases during each iteration so
   * callers (e.g. CLIRunner) can print user-friendly progress lines.
   */
  onProgress?: (event: ProgressEvent) => void;
  /**
   * Optional StrategyTemplateRegistry. When provided, CoreLoop wires it into
   * StrategyManager so that strategies completing with effectiveness_score >= 0.5
   * are automatically registered as reusable templates.
   */
  strategyTemplateRegistry?: StrategyTemplateRegistry;
  /** Optional HookManager for lifecycle hook events. */
  hookManager?: import("../runtime/hook-manager.js").HookManager;
}

export type ProgressPhase =
  | "Observing..."
  | "Generating task..."
  | "Executing task..."
  | "Verifying result..."
  | "Skipped"
  | "Skipped (no state change)";

export interface ProgressEvent {
  /** 1-based iteration number */
  iteration: number;
  /** Maximum iterations configured */
  maxIterations: number;
  /** Current phase label */
  phase: ProgressPhase;
  /** Gap aggregate from latest gap calculation (undefined before first gap calc) */
  gap?: number;
  /** Average confidence across gap dimensions (undefined before first gap calc) */
  confidence?: number;
  /** Short description of the task being executed (undefined outside execute phase) */
  taskDescription?: string;
  /** Reason this iteration was skipped (undefined when not skipped) */
  skipReason?: string;
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
  const deadlineTime = goal.deadline ? new Date(goal.deadline).getTime() : null;

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
    if (deadlineTime !== null) {
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
