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
import { selectTargetDimension as _selectTargetDimension } from "../context/dimension-selector.js";
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

import type { TaskPipeline, TaskDomain } from "../../../base/types/pipeline.js";
import type { ObservationEngine } from "../../../platform/observation/observation-engine.js";

export { LLMGeneratedTaskSchema } from "./task-generation.js";
import { generateTask as _generateTask } from "./task-generation.js";
import { executeTask as _executeTask, reloadTaskFromDisk, durationToMs } from "./task-executor.js";
import { runPreExecutionChecks } from "./task-approval.js";
import { checkIrreversibleApproval as _checkIrreversibleApproval } from "./task-approval-check.js";
import { runPipelineTaskCycle as runPipelineTaskCycleFn } from "./task-pipeline-cycle.js";
import type { KnowledgeTransfer } from "../../../platform/knowledge/transfer/knowledge-transfer.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import { getReflectionsForGoal, formatReflectionsForPrompt } from "../reflection-generator.js";
import { persistTaskCycleSideEffects } from "./task-side-effects.js";
import { GuardrailRunner } from "../../../platform/traits/guardrail-runner.js";
import type { HookManager } from "../../../runtime/hook-manager.js";
import type { ToolExecutor } from "../../../tools/executor.js";

export type { TaskCycleResult } from "./task-execution-types.js";
import type { TaskCycleResult } from "./task-execution-types.js";
import { createSkippedTaskResult } from "./task-execution-types.js";

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
  private readonly guardrailRunner?: GuardrailRunner;
  private readonly hookManager?: HookManager;
  private readonly toolExecutor?: ToolExecutor;
  private onTaskComplete?: (strategyId: string) => void;

  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    sessionManager: SessionManager,
    trustManager: TrustManager,
    strategyManager: StrategyManager,
    stallDetector: StallDetector,
    options?: {
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
      /** Optional guardrail runner for before_tool/after_tool hooks */
      guardrailRunner?: GuardrailRunner;
      /** Optional HookManager for lifecycle hook events */
      hookManager?: HookManager;
      /** Optional ToolExecutor for post-execution git diff verification (read-only) */
      toolExecutor?: ToolExecutor;
    }
  ) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
    this.sessionManager = sessionManager;
    this.trustManager = trustManager;
    this.strategyManager = strategyManager;
    this.stallDetector = stallDetector;
    this.approvalFn = options?.approvalFn ?? ((_task: Task) => Promise.resolve(false));
    this.ethicsGate = options?.ethicsGate;
    this.capabilityDetector = options?.capabilityDetector;
    this.logger = options?.logger;
    this.adapterRegistry = options?.adapterRegistry;
    this.healthCheckEnabled = options?.healthCheckEnabled ?? true;
    this.execFileSyncFn = options?.execFileSyncFn ?? _execFileSync;
    this.completionJudgerConfig = options?.completionJudgerConfig;
    this.knowledgeTransfer = options?.knowledgeTransfer;
    this.knowledgeManager = options?.knowledgeManager;
    this.guardrailRunner = options?.guardrailRunner;
    this.hookManager = options?.hookManager;
    this.toolExecutor = options?.toolExecutor;
  }

  /** Register a callback invoked when a task completes successfully (used by PortfolioManager). */
  setOnTaskComplete(callback: (strategyId: string) => void): void {
    this.onTaskComplete = callback;
  }

  /** Select highest-priority dimension to work on, weighted by confidence tier. */
  selectTargetDimension(gapVector: GapVector, driveContext: DriveContext, dimensions?: Dimension[]): string {
    return _selectTargetDimension(gapVector, driveContext, dimensions);
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
    return _generateTask(
      {
        stateManager: this.stateManager,
        llmClient: this.llmClient,
        strategyManager: this.strategyManager,
        logger: this.logger,
      },
      goalId,
      targetDimension,
      strategyId,
      knowledgeContext,
      adapterType,
      existingTasks,
      workspaceContext
    );
  }

  /** Check whether the task requires human approval and request it if so. */
  async checkIrreversibleApproval(task: Task, confidence: number = 0.5): Promise<boolean> {
    return _checkIrreversibleApproval(this.trustManager, this.approvalFn, task, confidence);
  }

  /** Execute a task via the given adapter. */
  async executeTask(task: Task, adapter: IAdapter, workspaceContext?: string): Promise<AgentResult> {
    if (this.guardrailRunner) {
      const beforeResult = await this.guardrailRunner.run("before_tool", {
        checkpoint: "before_tool",
        goal_id: task.goal_id,
        task_id: task.id,
        input: { task, adapter_type: adapter.adapterType },
      });
      if (!beforeResult.allowed) {
        return {
          success: false,
          output: `Guardrail rejected: ${beforeResult.results.map(r => r.reason).filter(Boolean).join("; ")}`,
          error: "guardrail_rejected",
          exit_code: null,
          elapsed_ms: 0,
          stopped_reason: "error",
        };
      }
    }

    // Route through run-adapter tool when ToolExecutor is available
    if (this.toolExecutor) {
      try {
        let trustBalance = 0;
        try {
          const balance = await this.stateManager.loadGoal(task.goal_id);
          void balance; // goal_id is enough; trust fetched below if needed
        } catch { /* non-fatal */ }
        const toolCtx = {
          cwd: process.cwd(),
          goalId: task.goal_id,
          trustBalance,
          preApproved: true,
          approvalFn: async () => false,
        };
        const toolResult = await this.toolExecutor.execute(
          "run-adapter",
          {
            adapter_id: adapter.adapterType,
            task_description: task.work_description ?? "",
            goal_id: task.goal_id,
          },
          toolCtx
        );
        if (toolResult.success && toolResult.data != null) {
          return toolResult.data as AgentResult;
        }
        this.logger?.warn?.(`[TaskLifecycle] run-adapter tool failed, falling back to direct call: ${toolResult.error ?? "unknown"}`);
      } catch (err) {
        this.logger?.warn?.(`[TaskLifecycle] run-adapter tool threw, falling back to direct call: ${(err as Error).message}`);
      }
    }

    const result = await _executeTask(
      {
        stateManager: this.stateManager,
        sessionManager: this.sessionManager,
        logger: this.logger,
        execFileSyncFn: this.execFileSyncFn,
      },
      task,
      adapter,
      workspaceContext
    );

    if (this.guardrailRunner) {
      const afterResult = await this.guardrailRunner.run("after_tool", {
        checkpoint: "after_tool",
        goal_id: task.goal_id,
        task_id: task.id,
        input: { task, result, adapter_type: adapter.adapterType },
      });
      if (!afterResult.allowed) {
        return {
          success: false,
          output: `Guardrail rejected result: ${afterResult.results.map(r => r.reason).filter(Boolean).join("; ")}`,
          error: "guardrail_rejected",
          exit_code: null,
          elapsed_ms: result.elapsed_ms,
          stopped_reason: "error",
        };
      }
    }

    return result;
  }

  /** Verify task execution results using 3-layer verification. */
  async verifyTask(
    task: Task,
    executionResult: AgentResult
  ): Promise<VerificationResult> {
    return _verifyTask(this.verifierDeps(), task, executionResult);
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
    // 1. Select target dimension (with confidence-tier weighting when available)
    let goalDimensions: Dimension[] | undefined;
    try {
      const goal = await this.stateManager.loadGoal(goalId);
      goalDimensions = goal?.dimensions ?? undefined;
    } catch (err) {
      // If goal load fails, fall back to unweighted selection
      this.logger?.warn(`[TaskLifecycle] Failed to load goal "${goalId}" for dimension selection, using unweighted fallback: ${err instanceof Error ? err.message : String(err)}`);
    }
    const targetDimension = this.selectTargetDimension(gapVector, driveContext, goalDimensions);

    // 2. Realtime transfer candidate detection (optional enrichment)
    let enrichedKnowledgeContext = knowledgeContext;
    if (this.knowledgeTransfer) {
      try {
        const { contextSnippets } = await this.knowledgeTransfer.detectCandidatesRealtime(goalId);
        if (contextSnippets.length > 0) {
          const snippetText = contextSnippets.join("\n");
          enrichedKnowledgeContext = knowledgeContext ? `${knowledgeContext}\n${snippetText}` : snippetText;
        }
      } catch (err) {
        // non-fatal: proceed without enrichment
        this.logger?.warn(`[TaskLifecycle] Knowledge transfer candidate detection failed (proceeding without enrichment): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Inject past reflections
    if (this.knowledgeManager) {
      try {
        const pastReflections = await getReflectionsForGoal(this.knowledgeManager, goalId, 5, this.logger);
        if (pastReflections.length > 0) {
          const reflectionText = formatReflectionsForPrompt(pastReflections);
          enrichedKnowledgeContext = enrichedKnowledgeContext
            ? `${enrichedKnowledgeContext}\n${reflectionText}`
            : reflectionText;
        }
      } catch (err) {
        // non-fatal: proceed without reflections
        this.logger?.warn(`[TaskLifecycle] Failed to load past reflections (proceeding without): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3. Generate task (optionally with injected knowledge context)
    void this.hookManager?.emit("PreTaskCreate", { goal_id: goalId, data: { task_type: targetDimension } });
    const genResult = await this._generateTaskWithTokens(goalId, targetDimension, undefined, enrichedKnowledgeContext, adapter.adapterType, existingTasks, workspaceContext);
    let taskCycleTokens = genResult.tokensUsed;
    const task = genResult.task;
    if (task === null) {
      this.logger?.warn("TaskLifecycle: task generation returned null (duplicate detected), skipping cycle");
      return createSkippedTaskResult(goalId, targetDimension);
    }
    void this.hookManager?.emit("PostTaskCreate", { goal_id: goalId, data: { task_id: task.id } });
    this.logger?.info(`[task] created: ${task.work_description?.substring(0, 120)}`, { taskId: task.id });

    // 4. Pre-execution checks: ethics, capability, irreversible approval
    const preCheckResult = await runPreExecutionChecks(
      {
        ethicsGate: this.ethicsGate,
        capabilityDetector: this.capabilityDetector,
        approvalFn: this.approvalFn,
        checkIrreversibleApproval: (t) => this.checkIrreversibleApproval(t),
      },
      task
    );
    if (preCheckResult !== null) return preCheckResult;

    // 4. Execute task
    this.logger?.debug(`[DEBUG-TL] Executing task ${task.id} via adapter ${adapter.adapterType}`);
    void this.hookManager?.emit("PreExecute", { goal_id: goalId, data: { task_id: task.id } });
    const executionResult = await this.executeTask(task, adapter, workspaceContext);
    void this.hookManager?.emit("PostExecute", { goal_id: goalId, data: { task_id: task.id, success: executionResult.success } });
    this.logger?.info(`[task] executed: ${executionResult.success ? 'success' : 'failed'}`, { taskId: task.id });
    this.logger?.debug(`[DEBUG-TL] Execution result: success=${executionResult.success}, stopped=${executionResult.stopped_reason}, error=${executionResult.error}, output=${executionResult.output?.substring(0, 200)}`);

    // 4b. Post-execution health check (opt-in)
    if (executionResult.success && this.healthCheckEnabled) {
      const healthCheck = await this.runPostExecutionHealthCheck();
      if (!healthCheck.healthy) {
        this.logger?.warn(`[TaskLifecycle] Post-execution health check FAILED: ${healthCheck.output}`);
        executionResult.success = false;
        executionResult.output = (executionResult.output || "") +
          `\n\n[Health Check Failed]\n${healthCheck.output}`;
      }
    }

    // 4c. Post-execution git diff verification (optional, non-blocking)
    if (executionResult.success && this.toolExecutor) {
      const diffCheck = await this.verifyWithGitDiff(goalId);
      this.logger?.info(
        `[TaskLifecycle] Git diff verification: ${diffCheck.diffSummary || "no changes"}`,
        { verified: diffCheck.verified }
      );
      if (!diffCheck.verified) {
        this.logger?.warn(
          "[TaskLifecycle] Git diff found no file changes after successful task execution",
          { diffSummary: diffCheck.diffSummary }
        );
      }
    }

    // Reload task from disk to get accurate status/started_at/completed_at set by executeTask
    const taskForVerification = await reloadTaskFromDisk(this.stateManager, task);

    // 5. Verify task — use token accumulator to capture LLM tokens consumed during verification
    const verifierTokenAccumulator = { tokensUsed: 0 };
    const verifierDepsWithAccumulator = { ...this.verifierDeps(), _tokenAccumulator: verifierTokenAccumulator };
    const verificationResult = await _verifyTask(verifierDepsWithAccumulator, taskForVerification, executionResult);
    taskCycleTokens += verifierTokenAccumulator.tokensUsed;
    this.logger?.debug(`[DEBUG-TL] Verification: verdict=${verificationResult.verdict}, evidence=${verificationResult.evidence.map(e => e.description).join('; ').substring(0, 300)}`);

    // 6. Handle verdict
    const verdictResult = await this.handleVerdict(taskForVerification, verificationResult);
    this.logger?.info(`[task] verdict: ${verdictResult.action}`, { taskId: task.id });

    await persistTaskCycleSideEffects({
      goalId,
      targetDimension,
      task: verdictResult.task,
      verificationResult,
      executionResult,
      adapter,
      sessionManager: this.sessionManager,
      llmClient: this.llmClient,
      knowledgeManager: this.knowledgeManager,
      logger: this.logger,
      gapValue: gapVector?.gaps?.[0]?.normalized_gap,
    });

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
    options?: {
      knowledgeContext?: string;
      existingTasks?: string[];
      workspaceContext?: string;
      observationEngine?: ObservationEngine;
      domain?: TaskDomain;
      adapterRegistry?: AdapterRegistry;
    }
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
  private verifierDeps() {
    return {
      stateManager: this.stateManager,
      llmClient: this.llmClient,
      sessionManager: this.sessionManager,
      trustManager: this.trustManager,
      stallDetector: this.stallDetector,
      adapterRegistry: this.adapterRegistry,
      logger: this.logger,
      onTaskComplete: this.onTaskComplete,
      durationToMs: durationToMs,
      completionJudgerConfig: this.completionJudgerConfig,
      toolExecutor: this.toolExecutor,
    };
  }

  /**
   * Run a git diff to verify that file changes occurred after task execution.
   * Returns verified=true (non-blocking) if toolExecutor is unavailable or diff fails.
   */
  private async verifyWithGitDiff(goalId: string): Promise<{ verified: boolean; diffSummary: string }> {
    if (!this.toolExecutor) return { verified: true, diffSummary: "" };

    try {
      const result = await this.toolExecutor.execute(
        "git_diff",
        { target: "unstaged", maxLines: 200 },
        {
          cwd: process.cwd(),
          goalId,
          trustBalance: 0,
          preApproved: true,
          approvalFn: async () => true,
        }
      );

      if (!result.success) return { verified: true, diffSummary: "diff unavailable" };

      const diffText = typeof result.data === "string" ? result.data : "";
      if (!diffText.trim()) {
        return { verified: false, diffSummary: "no changes detected" };
      }

      // Count changed files from diff output (lines starting with "diff --git")
      const filesChanged = (diffText.match(/^diff --git /gm) ?? []).length;
      return {
        verified: filesChanged > 0,
        diffSummary: `${filesChanged} file${filesChanged !== 1 ? "s" : ""} changed`,
      };
    } catch {
      return { verified: true, diffSummary: "diff check failed" };
    }
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
}
