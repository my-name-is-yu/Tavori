import { execFileSync as _execFileSync } from "node:child_process";
import type { Logger } from "../runtime/logger.js";
import {
  runShellCommand as _runShellCommand,
  runPostExecutionHealthCheck as _runPostExecutionHealthCheck,
} from "./task-health-check.js";
import { StateManager } from "../state-manager.js";
import type { ILLMClient } from "../llm/llm-client.js";
import { SessionManager } from "./session-manager.js";
import { TrustManager } from "../traits/trust-manager.js";
import { StrategyManager } from "../strategy/strategy-manager.js";
import { StallDetector } from "../drive/stall-detector.js";
import { selectTargetDimension as _selectTargetDimension } from "./dimension-selector.js";
import type { Task, VerificationResult } from "../types/task.js";
import type { GapVector } from "../types/gap.js";
import type { DriveContext } from "../types/drive.js";
import type { Dimension } from "../types/goal.js";
import type { EthicsGate } from "../traits/ethics-gate.js";
import type { CapabilityDetector } from "../observation/capability-detector.js";
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

import type { AgentTask, AgentResult, IAdapter } from "./adapter-layer.js";
import { AdapterRegistry } from "./adapter-layer.js";
export type { AgentTask, AgentResult, IAdapter };
export { AdapterRegistry };

import type { TaskPipeline, TaskDomain } from "../types/pipeline.js";
import type { ObservationEngine } from "../observation/observation-engine.js";

export { LLMGeneratedTaskSchema } from "./task-generation.js";
import { generateTask as _generateTask } from "./task-generation.js";
import { executeTask as _executeTask, reloadTaskFromDisk, durationToMs } from "./task-executor.js";
import { runPreExecutionChecks } from "./task-approval.js";
import { checkIrreversibleApproval as _checkIrreversibleApproval } from "./task-approval-check.js";
import { runPipelineTaskCycle as runPipelineTaskCycleFn } from "./task-pipeline-cycle.js";
import type { KnowledgeTransfer } from "../knowledge/knowledge-transfer.js";
import type { KnowledgeManager } from "../knowledge/knowledge-manager.js";
import { generateReflection, saveReflectionAsKnowledge, getReflectionsForGoal, formatReflectionsForPrompt } from "./reflection-generator.js";
import { GuardrailRunner } from "../guardrail-runner.js";

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
    this.healthCheckEnabled = options?.healthCheckEnabled ?? false;
    this.execFileSyncFn = options?.execFileSyncFn ?? _execFileSync;
    this.completionJudgerConfig = options?.completionJudgerConfig;
    this.knowledgeTransfer = options?.knowledgeTransfer;
    this.knowledgeManager = options?.knowledgeManager;
    this.guardrailRunner = options?.guardrailRunner;
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
    const task = await this.generateTask(goalId, targetDimension, undefined, enrichedKnowledgeContext, adapter.adapterType, existingTasks, workspaceContext);
    if (task === null) {
      this.logger?.warn("TaskLifecycle: task generation returned null (duplicate detected), skipping cycle");
      return createSkippedTaskResult(goalId, targetDimension);
    }

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
    const executionResult = await this.executeTask(task, adapter, workspaceContext);
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

    // Reload task from disk to get accurate status/started_at/completed_at set by executeTask
    const taskForVerification = await reloadTaskFromDisk(this.stateManager, task);

    // 5. Verify task
    const verificationResult = await this.verifyTask(taskForVerification, executionResult);
    this.logger?.debug(`[DEBUG-TL] Verification: verdict=${verificationResult.verdict}, evidence=${verificationResult.evidence.map(e => e.description).join('; ').substring(0, 300)}`);

    // 6. Handle verdict
    const verdictResult = await this.handleVerdict(taskForVerification, verificationResult);

    // Save checkpoint on task completion/interruption
    const adapterType = adapter?.adapterType ?? 'unknown';
    const contextSnapshot = [
      `goal: ${goalId}`,
      `dimension: ${targetDimension}`,
      `strategy: ${task.strategy_id ?? 'none'}`,
      `action: ${verdictResult.action}`,
    ].join('\n');
    const intermediateResults: string[] = [];
    if (executionResult?.output) intermediateResults.push(typeof executionResult.output === 'string' ? executionResult.output.slice(0, 2000) : JSON.stringify(executionResult.output).slice(0, 2000));
    const gapValue = gapVector?.gaps?.[0]?.normalized_gap;

    await this.sessionManager.saveCheckpoint({
      goalId,
      taskId: task.id,
      agentId: typeof adapterType === 'string' ? adapterType : 'unknown',
      sessionContextSnapshot: contextSnapshot,
      intermediateResults,
      metadata: { strategy_id: task.strategy_id, gap_value: gapValue },
    }).catch(e => this.logger?.warn?.('checkpoint save failed', { error: String(e) }));

    // Generate and save reflection (non-fatal, only when knowledgeManager is available)
    if (this.knowledgeManager) {
      try {
        const reflection = await generateReflection({
          task: verdictResult.task,
          verificationResult,
          goalId,
          strategyId: verdictResult.task.strategy_id ?? undefined,
          llmClient: this.llmClient,
          logger: this.logger,
        });
        await saveReflectionAsKnowledge(
          this.knowledgeManager, goalId, reflection,
          verdictResult.task.work_description,
        );
      } catch (e) {
        this.logger?.warn?.("Reflection generation failed (non-fatal)", { error: String(e) });
      }
    }

    return {
      task: verdictResult.task,
      verificationResult,
      action: verdictResult.action,
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
    };
  }

  /** Run build and test checks after successful task execution. Opt-in via healthCheckEnabled. */
  async runPostExecutionHealthCheck(): Promise<{ healthy: boolean; output: string }> {
    return _runPostExecutionHealthCheck(
      this.runShellCommand.bind(this),
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
