import { execFileSync as _execFileSync } from "node:child_process";
import type { Logger } from "../../../runtime/logger.js";
import {
  runShellCommand as _runShellCommand,
  runPostExecutionHealthCheck as _runPostExecutionHealthCheck,
} from "./task-health-check.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import { SessionManager } from "../session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { StrategyManager } from "../../strategy/strategy-manager.js";
import { StallDetector } from "../../../platform/drive/stall-detector.js";
import {
  selectTargetDimension as _selectTargetDimension,
  type DimensionSelectionOptions,
} from "../context/dimension-selector.js";
import type { Task, VerificationResult } from "../../../base/types/task.js";
import type { GapVector } from "../../../base/types/gap.js";
import type { DriveContext } from "../../../base/types/drive.js";
import type { Dimension } from "../../../base/types/goal.js";
import type { EthicsGate } from "../../../platform/traits/ethics-gate.js";
import type { CapabilityDetector } from "../../../platform/observation/capability-detector.js";
import {
  verifyTask as _verifyTask,
  handleVerdict as _handleVerdict,
  handleFailure as _handleFailure,
  type VerdictResult,
  type FailureResult,
  type CompletionJudgerConfig,
} from "./task-verifier.js";
export type { CompletionJudgerConfig } from "./task-verifier.js";
export type {
  ExecutorReport,
  VerdictResult,
  FailureResult,
} from "./task-verifier.js";

import type { AgentTask, AgentResult, IAdapter } from "../adapter-layer.js";
import { AdapterRegistry } from "../adapter-layer.js";
export type { AgentTask, AgentResult, IAdapter };
export { AdapterRegistry };

import type { TaskPipeline } from "../../../base/types/pipeline.js";

export { LLMGeneratedTaskSchema } from "./task-generation.js";
import { generateTask as _generateTask } from "./task-generation.js";
import { reloadTaskFromDisk, durationToMs } from "./task-executor.js";
import { executeTaskWithGuards, verifyExecutionWithGitDiff } from "./task-execution-helpers.js";
import { runPreExecutionChecks } from "./task-approval.js";
import { checkIrreversibleApproval as _checkIrreversibleApproval } from "./task-approval-check.js";
import { runPipelineTaskCycle as runPipelineTaskCycleFn } from "./task-pipeline-cycle.js";
import type { PipelineCycleOptions } from "./task-pipeline-types.js";
import type { KnowledgeTransfer } from "../../../platform/knowledge/transfer/knowledge-transfer.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import type { MemoryLifecycleManager } from "../../../platform/knowledge/memory/memory-lifecycle.js";
import { buildEnrichedKnowledgeContext } from "./task-context-enricher.js";
import { persistTaskCycleSideEffects } from "./task-side-effects.js";
import { finalizeSuccessfulExecution } from "./task-post-execution.js";
import { GuardrailRunner } from "../../../platform/traits/guardrail-runner.js";
import type { HookManager } from "../../../runtime/hook-manager.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import {
  formatPatternHints,
  loadDreamActivationState,
  loadLearnedPatterns,
  selectPatternHints,
} from "../../../platform/dream/dream-activation.js";

export type { TaskCycleResult } from "./task-execution-types.js";
export type {
  PipelineCycleDeps,
  PipelineCycleOptions,
  SelectTargetDimensionFn,
  GenerateTaskFn,
} from "./task-pipeline-types.js";
import type { TaskCycleResult } from "./task-execution-types.js";
import { createSkippedTaskResult } from "./task-execution-types.js";
import { appendTaskOutcomeEvent } from "./task-outcome-ledger.js";

export interface TaskLifecycleCoreDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  sessionManager: SessionManager;
  trustManager: TrustManager;
  strategyManager: StrategyManager;
  stallDetector: StallDetector;
}

export interface TaskLifecycleOptions {
  approvalFn?: (task: Task) => Promise<boolean>;
  ethicsGate?: EthicsGate;
  capabilityDetector?: CapabilityDetector;
  logger?: Logger;
  /** Optional adapter registry for L1 mechanical verification command execution */
  adapterRegistry?: AdapterRegistry;
  /** Enable post-execution build/test health check (disabled by default) */
  healthCheckEnabled?: boolean;
  /** Injectable execFileSync for testing (defaults to node:child_process execFileSync) */
  execFileSyncFn?: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
  /** Timeout + retry config for the completion judgment LLM call */
  completionJudgerConfig?: CompletionJudgerConfig;
  /** Optional KnowledgeTransfer for realtime candidate detection before task generation */
  knowledgeTransfer?: KnowledgeTransfer;
  /** Optional KnowledgeManager for reflection generation and retrieval */
  knowledgeManager?: KnowledgeManager;
  /** Optional MemoryLifecycleManager for lessons learned during task generation */
  memoryLifecycle?: MemoryLifecycleManager;
  /** Optional guardrail runner for before_tool/after_tool hooks */
  guardrailRunner?: GuardrailRunner;
  /** Optional HookManager for lifecycle hook events */
  hookManager?: HookManager;
  /** Optional ToolExecutor for post-execution git diff verification (read-only) */
  toolExecutor?: ToolExecutor;
  /** Optional explicit workspace root for git-based revert operations. */
  revertCwd?: string;
}

export interface TaskLifecycleDeps extends TaskLifecycleCoreDeps {
  options?: TaskLifecycleOptions;
}

// ─── TaskLifecycle ───

/**
 * TaskLifecycle manages the full lifecycle of tasks:
 * select target dimension -> generate task -> approval check -> execute -> verify -> handle verdict.
 */
export class TaskLifecycle {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;
  private readonly sessionManager: SessionManager;
  private readonly trustManager: TrustManager;
  private readonly strategyManager: StrategyManager;
  private readonly stallDetector: StallDetector;
  private readonly approvalFn: (task: Task) => Promise<boolean>;
  private readonly ethicsGate?: EthicsGate;
  private readonly capabilityDetector?: CapabilityDetector;
  private readonly logger?: Logger;
  private readonly adapterRegistry?: AdapterRegistry;
  private readonly healthCheckEnabled: boolean;
  private readonly execFileSyncFn: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
  private readonly completionJudgerConfig?: CompletionJudgerConfig;
  private readonly knowledgeTransfer?: KnowledgeTransfer;
  private readonly knowledgeManager?: KnowledgeManager;
  private readonly memoryLifecycle?: MemoryLifecycleManager;
  private readonly guardrailRunner?: GuardrailRunner;
  private readonly hookManager?: HookManager;
  private readonly toolExecutor?: ToolExecutor;
  private readonly revertCwd?: string;
  private onTaskComplete?: (strategyId: string) => void;

  constructor(deps: TaskLifecycleDeps);
  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    sessionManager: SessionManager,
    trustManager: TrustManager,
    strategyManager: StrategyManager,
    stallDetector: StallDetector,
    options?: TaskLifecycleOptions
  );
  constructor(
    stateManagerOrDeps: StateManager | TaskLifecycleDeps,
    llmClient?: ILLMClient,
    sessionManager?: SessionManager,
    trustManager?: TrustManager,
    strategyManager?: StrategyManager,
    stallDetector?: StallDetector,
    options?: TaskLifecycleOptions
  ) {
    const resolved = TaskLifecycle.isDepsObject(stateManagerOrDeps)
      ? stateManagerOrDeps
      : {
          stateManager: stateManagerOrDeps,
          llmClient: llmClient!,
          sessionManager: sessionManager!,
          trustManager: trustManager!,
          strategyManager: strategyManager!,
          stallDetector: stallDetector!,
          options,
        };
    const resolvedOptions = resolved.options;

    this.stateManager = resolved.stateManager;
    this.llmClient = resolved.llmClient;
    this.sessionManager = resolved.sessionManager;
    this.trustManager = resolved.trustManager;
    this.strategyManager = resolved.strategyManager;
    this.stallDetector = resolved.stallDetector;
    this.approvalFn = resolvedOptions?.approvalFn ?? ((_task: Task) => Promise.resolve(false));
    this.ethicsGate = resolvedOptions?.ethicsGate;
    this.capabilityDetector = resolvedOptions?.capabilityDetector;
    this.logger = resolvedOptions?.logger;
    this.adapterRegistry = resolvedOptions?.adapterRegistry;
    this.healthCheckEnabled = resolvedOptions?.healthCheckEnabled ?? false;
    this.execFileSyncFn = resolvedOptions?.execFileSyncFn ?? _execFileSync;
    this.completionJudgerConfig = resolvedOptions?.completionJudgerConfig;
    this.knowledgeTransfer = resolvedOptions?.knowledgeTransfer;
    this.knowledgeManager = resolvedOptions?.knowledgeManager;
    this.memoryLifecycle = resolvedOptions?.memoryLifecycle;
    this.guardrailRunner = resolvedOptions?.guardrailRunner;
    this.hookManager = resolvedOptions?.hookManager;
    this.toolExecutor = resolvedOptions?.toolExecutor;
    this.revertCwd = resolvedOptions?.revertCwd;
  }

  /** Register a callback invoked when a task completes successfully (used by PortfolioManager). */
  setOnTaskComplete(callback: (strategyId: string) => void): void {
    this.onTaskComplete = callback;
  }

  /** Select highest-priority dimension to work on, weighted by confidence tier. */
  selectTargetDimension(
    gapVector: GapVector,
    driveContext: DriveContext,
    dimensions?: Dimension[],
    options?: DimensionSelectionOptions
  ): string {
    return _selectTargetDimension(gapVector, driveContext, dimensions, options);
  }

  /** Generate a task for the given goal and target dimension via LLM. */
  async generateTask(
    goalId: string,
    targetDimension: string,
    strategyId?: string,
    knowledgeContext?: string,
    adapterType?: string,
    existingTasks?: string[],
    workspaceContext?: string
  ): Promise<Task | null> {
    const result = await this._generateTaskWithTokens(goalId, targetDimension, strategyId, knowledgeContext, adapterType, existingTasks, workspaceContext);
    return result.task;
  }

  /** Internal: generate task and return token count alongside the task. */
  private async _generateTaskWithTokens(
    goalId: string,
    targetDimension: string,
    strategyId?: string,
    knowledgeContext?: string,
    adapterType?: string,
    existingTasks?: string[],
    workspaceContext?: string
  ): Promise<{ task: Task | null; tokensUsed: number }> {
    let resolvedKnowledgeContext = knowledgeContext;
    try {
      const dreamActivation = await loadDreamActivationState(this.stateManager.getBaseDir());
      if (dreamActivation.flags.learnedPatternHints) {
        const goal = await this.stateManager.loadGoal(goalId);
        const patterns = await loadLearnedPatterns(this.stateManager.getBaseDir(), goalId);
        const hints = selectPatternHints(
          patterns,
          [
            goal?.title ?? "",
            goal?.description ?? "",
            targetDimension,
            knowledgeContext ?? "",
          ].join(" ")
        );
        const formattedHints = formatPatternHints(hints);
        if (formattedHints) {
          resolvedKnowledgeContext = resolvedKnowledgeContext
            ? `${resolvedKnowledgeContext}\n\n${formattedHints}`
            : formattedHints;
        }
      }
    } catch {
      // Non-fatal: proceed without learned pattern hints.
    }

    return _generateTask(
      {
        stateManager: this.stateManager,
        llmClient: this.llmClient,
        strategyManager: this.strategyManager,
        logger: this.logger,
        knowledgeManager: this.knowledgeManager,
        memoryLifecycle: this.memoryLifecycle,
      },
      goalId,
      targetDimension,
      strategyId,
      resolvedKnowledgeContext,
      adapterType,
      existingTasks,
      workspaceContext
    );
  }

  /** Check whether the task requires human approval and request it if so. */
  async checkIrreversibleApproval(task: Task, confidence: number = 0.5): Promise<boolean> {
    return _checkIrreversibleApproval(this.trustManager, this.approvalFn, task, confidence);
  }

  private async buildDimensionSelectionBackoff(goalId: string): Promise<DimensionSelectionOptions> {
    const failureStatuses = new Set(["failed", "error", "timed_out", "abandoned", "discarded"]);
    const backoffCounts = new Map<string, number>();

    try {
      const rawHistory = await this.stateManager.readRaw(`tasks/${goalId}/task-history.json`);
      if (!Array.isArray(rawHistory)) {
        return {};
      }

      for (const entry of rawHistory.slice(-20) as Array<Record<string, unknown>>) {
        const dimension = typeof entry.primary_dimension === "string" ? entry.primary_dimension : null;
        if (!dimension) {
          continue;
        }

        const status = typeof entry.status === "string" ? entry.status : "";
        const verdict = typeof entry.verification_verdict === "string" ? entry.verification_verdict : "";
        const failureCount = typeof entry.consecutive_failure_count === "number"
          ? entry.consecutive_failure_count
          : 0;
        const failed =
          failureStatuses.has(status)
          || verdict === "fail"
          || verdict === "partial"
          || failureCount > 0;
        const passed = status === "completed" && verdict === "pass" && failureCount === 0;

        if (failed && !passed) {
          backoffCounts.set(dimension, (backoffCounts.get(dimension) ?? 0) + 1);
        }
      }
    } catch {
      return {};
    }

    if (backoffCounts.size === 0) {
      return {};
    }

    const backoffByDimension: Record<string, number> = {};
    for (const [dimension, count] of backoffCounts) {
      backoffByDimension[dimension] = Math.max(0.1, 1 / (count + 1));
    }
    return { backoffByDimension };
  }

  /** Execute a task via the given adapter. */
  async executeTask(task: Task, adapter: IAdapter, workspaceContext?: string): Promise<AgentResult> {
    return executeTaskWithGuards({
      task,
      adapter,
      workspaceContext,
      ...this.executionDeps(),
    });
  }

  /** Verify task execution results using 3-layer verification. */
  async verifyTask(
    task: Task,
    executionResult: AgentResult,
    preferredAdapterType?: string
  ): Promise<VerificationResult> {
    return _verifyTask(this.verifierDeps(preferredAdapterType), task, executionResult);
  }

  /** Handle a verification verdict (pass/partial/fail). */
  async handleVerdict(
    task: Task,
    verificationResult: VerificationResult
  ): Promise<VerdictResult> {
    return _handleVerdict(this.verifierDeps(), task, verificationResult);
  }

  /** Handle a task failure: increment failure count, record failure, decide keep/discard/escalate. */
  async handleFailure(
    task: Task,
    verificationResult: VerificationResult
  ): Promise<FailureResult> {
    return _handleFailure(this.verifierDeps(), task, verificationResult);
  }

  /** Run a full task cycle: select → generate → approve → execute → verify → verdict. */
  async runTaskCycle(
    goalId: string,
    gapVector: GapVector,
    driveContext: DriveContext,
    adapter: IAdapter,
    knowledgeContext?: string,
    existingTasks?: string[],
    workspaceContext?: string
  ): Promise<TaskCycleResult> {
    const runPhase = async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
      const phaseStart = Date.now();
      this.logger?.info("TaskLifecycle: phase started", { goalId, phase });
      try {
        const value = await fn();
        this.logger?.info("TaskLifecycle: phase completed", {
          goalId,
          phase,
          duration_ms: Date.now() - phaseStart,
        });
        return value;
      } catch (err) {
        this.logger?.warn("TaskLifecycle: phase failed", {
          goalId,
          phase,
          duration_ms: Date.now() - phaseStart,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };
    // 1. Select target dimension (with confidence-tier weighting when available)
    let goalDimensions: Dimension[] | undefined;
    try {
      const goal = await this.stateManager.loadGoal(goalId);
      goalDimensions = goal?.dimensions ?? undefined;
    } catch (err) {
      // If goal load fails, fall back to unweighted selection
      this.logger?.warn(`[TaskLifecycle] Failed to load goal "${goalId}" for dimension selection, using unweighted fallback: ${err instanceof Error ? err.message : String(err)}`);
    }
    const dimensionSelectionOptions = await this.buildDimensionSelectionBackoff(goalId);
    const targetDimension = await runPhase("select-target-dimension", async () =>
      this.selectTargetDimension(gapVector, driveContext, goalDimensions, dimensionSelectionOptions)
    );

    const enrichedKnowledgeContext = await runPhase("enrich-knowledge-context", () =>
      buildEnrichedKnowledgeContext({
        goalId,
        knowledgeContext,
        ...this.enrichmentDeps(),
      })
    );

    // 3. Generate task (optionally with injected knowledge context)
    void this.hookManager?.emit("PreTaskCreate", { goal_id: goalId, data: { task_type: targetDimension } });
    const genResult = await runPhase("generate-task", () =>
      this._generateTaskWithTokens(
        goalId,
        targetDimension,
        undefined,
        enrichedKnowledgeContext,
        adapter.adapterType,
        existingTasks,
        workspaceContext
      )
    );
    let taskCycleTokens = genResult.tokensUsed;
    const task = genResult.task;
    if (task === null) {
      this.logger?.warn("TaskLifecycle: task generation returned null (duplicate detected), skipping cycle");
      return createSkippedTaskResult(goalId, targetDimension);
    }
    void this.hookManager?.emit("PostTaskCreate", { goal_id: goalId, data: { task_id: task.id } });
    this.logger?.info(`[task] created: ${task.work_description?.substring(0, 120)}`, { taskId: task.id });

    // 4. Pre-execution checks: ethics, capability, irreversible approval
    const preCheckResult = await runPhase("pre-execution-checks", () =>
      runPreExecutionChecks(
        {
          ethicsGate: this.ethicsGate,
          capabilityDetector: this.capabilityDetector,
          approvalFn: this.approvalFn,
          checkIrreversibleApproval: (t) => this.checkIrreversibleApproval(t),
        },
        task
      )
    );
    if (preCheckResult !== null) {
      await appendTaskOutcomeEvent(this.stateManager, {
        task,
        type: "abandoned",
        attempt: task.consecutive_failure_count + 1,
        action: preCheckResult.action,
        verificationResult: preCheckResult.verificationResult,
        reason: preCheckResult.verificationResult.evidence[0]?.description,
      });
      return preCheckResult;
    }

    await appendTaskOutcomeEvent(this.stateManager, {
      task,
      type: "acked",
      attempt: task.consecutive_failure_count + 1,
    });

    // 4. Execute task
    this.logger?.debug(`[DEBUG-TL] Executing task ${task.id} via adapter ${adapter.adapterType}`);
    void this.hookManager?.emit("PreExecute", { goal_id: goalId, data: { task_id: task.id } });
    const executionResult = await runPhase("execute-task", () =>
      this.executeTask(task, adapter, workspaceContext)
    );
    void this.hookManager?.emit("PostExecute", { goal_id: goalId, data: { task_id: task.id, success: executionResult.success } });
    this.logger?.info(`[task] executed: ${executionResult.success ? 'success' : 'failed'}`, { taskId: task.id });
    this.logger?.debug(`[DEBUG-TL] Execution result: success=${executionResult.success}, stopped=${executionResult.stopped_reason}, error=${executionResult.error}, output=${executionResult.output?.substring(0, 200)}`);

    await finalizeSuccessfulExecution({
      executionResult,
      goalId,
      ...this.postExecutionDeps(),
      logger: this.logger,
    });

    // Reload task from disk to get accurate status/started_at/completed_at set by executeTask
    const taskForVerification = await reloadTaskFromDisk(this.stateManager, task);

    // 5. Verify task — use token accumulator to capture LLM tokens consumed during verification
    const verifierTokenAccumulator = { tokensUsed: 0 };
    const verifierDepsWithAccumulator = {
      ...this.verifierDeps(adapter.adapterType),
      _tokenAccumulator: verifierTokenAccumulator,
    };
    const verificationResult = await runPhase("verify-task", () =>
      _verifyTask(verifierDepsWithAccumulator, taskForVerification, executionResult)
    );
    taskCycleTokens += verifierTokenAccumulator.tokensUsed;
    this.logger?.debug(`[DEBUG-TL] Verification: verdict=${verificationResult.verdict}, evidence=${verificationResult.evidence.map(e => e.description).join('; ').substring(0, 300)}`);

    // 6. Handle verdict
    const verdictResult = await runPhase("handle-verdict", () =>
      this.handleVerdict(taskForVerification, verificationResult)
    );
    this.logger?.info(`[task] verdict: ${verdictResult.action}`, { taskId: task.id });

    await runPhase("persist-task-side-effects", () =>
      persistTaskCycleSideEffects({
        goalId,
        targetDimension,
        task: verdictResult.task,
        action: verdictResult.action,
        verificationResult,
        executionResult,
        adapter,
        ...this.sideEffectDeps(),
        gapValue: gapVector?.gaps?.[0]?.normalized_gap,
      })
    );

    return {
      task: verdictResult.task,
      verificationResult,
      action: verdictResult.action,
      tokensUsed: taskCycleTokens,
    };
  }

  /**
   * Run a pipeline-based task cycle: select → generate → observe → approve → pipeline execute → map verdict.
   * Uses PipelineExecutor to orchestrate multi-role sequential execution.
   */
  async runPipelineTaskCycle(
    goalId: string,
    gapVector: GapVector,
    driveContext: DriveContext,
    adapter: IAdapter,
    pipeline: TaskPipeline,
    options?: PipelineCycleOptions
  ): Promise<TaskCycleResult> {
    return runPipelineTaskCycleFn(
      {
        stateManager: this.stateManager,
        sessionManager: this.sessionManager,
        llmClient: this.llmClient,
        ethicsGate: this.ethicsGate,
        capabilityDetector: this.capabilityDetector,
        approvalFn: this.approvalFn,
        adapterRegistry: this.adapterRegistry,
        logger: this.logger,
        knowledgeManager: this.knowledgeManager,
        checkIrreversibleApproval: (t) => this.checkIrreversibleApproval(t),
        selectTargetDimension: (gv, dc, dims) => this.selectTargetDimension(gv, dc, dims),
        generateTask: (gid, dim, sid, kc, at, et, wc) => this.generateTask(gid, dim, sid, kc, at, et, wc),
      },
      goalId,
      gapVector,
      driveContext,
      adapter,
      pipeline,
      options
    );
  }

  /** Build the VerifierDeps object passed to task-verifier.ts functions. */
  private verifierDeps(preferredAdapterType?: string) {
    return {
      stateManager: this.stateManager,
      llmClient: this.llmClient,
      sessionManager: this.sessionManager,
      trustManager: this.trustManager,
      stallDetector: this.stallDetector,
      adapterRegistry: this.adapterRegistry,
      preferredAdapterType,
      logger: this.logger,
      onTaskComplete: this.onTaskComplete,
      durationToMs: durationToMs,
      completionJudgerConfig: this.completionJudgerConfig,
      toolExecutor: this.toolExecutor,
      revertCwd: this.revertCwd,
    };
  }

  private executionDeps() {
    return {
      guardrailRunner: this.guardrailRunner,
      toolExecutor: this.toolExecutor,
      stateManager: this.stateManager,
      sessionManager: this.sessionManager,
      logger: this.logger,
      execFileSyncFn: this.execFileSyncFn,
    };
  }

  private enrichmentDeps() {
    return {
      knowledgeTransfer: this.knowledgeTransfer,
      knowledgeManager: this.knowledgeManager,
      logger: this.logger,
    };
  }

  private postExecutionDeps() {
    return {
      healthCheck: {
        enabled: this.healthCheckEnabled,
        run: () => this.runPostExecutionHealthCheck(),
      },
      successVerification: {
        toolExecutor: this.toolExecutor,
        verifyWithGitDiff: verifyExecutionWithGitDiff,
      },
    };
  }

  private sideEffectDeps() {
    return {
      sessionManager: this.sessionManager,
      llmClient: this.llmClient,
      knowledgeManager: this.knowledgeManager,
      logger: this.logger,
    };
  }

  /** Run build and test checks after successful task execution. Opt-in via healthCheckEnabled. */
  async runPostExecutionHealthCheck(): Promise<{ healthy: boolean; output: string }> {
    return _runPostExecutionHealthCheck(
      this.runShellCommand.bind(this),
      this.toolExecutor,
    );
  }

  /** Run a shell command safely using execFile (not exec) to avoid shell injection. */
  async runShellCommand(
    argv: string[],
    options: { timeout: number; cwd: string }
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    return _runShellCommand(argv, options);
  }

  private static isDepsObject(value: StateManager | TaskLifecycleDeps): value is TaskLifecycleDeps {
    return "stateManager" in value;
  }
}
