import { execFileSync as _execFileSync } from "node:child_process";
import type { Logger } from "../runtime/logger.js";
import { runShellCommand as _runShellCommand } from "./task-health-check.js";
import { StateManager } from "../state-manager.js";
import type { ILLMClient } from "../llm/llm-client.js";
import { SessionManager } from "./session-manager.js";
import { TrustManager } from "../traits/trust-manager.js";
import { StrategyManager } from "../strategy/strategy-manager.js";
import { StallDetector } from "../drive/stall-detector.js";
import { scoreAllDimensions, rankDimensions } from "../drive/drive-scorer.js";
import type { Task, VerificationResult } from "../types/task.js";
import type { GapVector } from "../types/gap.js";
import type { DriveContext } from "../types/drive.js";
import type { Dimension } from "../types/goal.js";
import type { EthicsGate } from "../traits/ethics-gate.js";
import type { CapabilityDetector } from "../observation/capability-detector.js";
import type { CapabilityAcquisitionTask } from "../types/capability.js";
import {
  verifyTask as _verifyTask,
  handleVerdict as _handleVerdict,
  handleFailure as _handleFailure,
  type VerdictResult,
  type FailureResult,
} from "./task-verifier.js";
export type {
  ExecutorReport,
  VerdictResult,
  FailureResult,
} from "./task-verifier.js";

// ─── Adapter types (re-exported from adapter-layer) ───

import type { AgentTask, AgentResult, IAdapter } from "./adapter-layer.js";
import { AdapterRegistry } from "./adapter-layer.js";
export type { AgentTask, AgentResult, IAdapter };
export { AdapterRegistry };

// ─── Re-exports from extracted modules ───

export { LLMGeneratedTaskSchema } from "./task-generation.js";
import { generateTask as _generateTask } from "./task-generation.js";
import { executeTask as _executeTask, reloadTaskFromDisk, durationToMs } from "./task-executor.js";
import { runPreExecutionChecks } from "./task-approval.js";

// ─── Internal types ───

export interface TaskCycleResult {
  task: Task;
  verificationResult: VerificationResult;
  action: "completed" | "keep" | "discard" | "escalate" | "approval_denied" | "capability_acquiring";
  acquisition_task?: CapabilityAcquisitionTask;
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
  }

  // ─── setOnTaskComplete ───

  /**
   * Register a callback to be invoked when a task completes successfully.
   * Used by PortfolioManager to track task completion times per strategy.
   */
  setOnTaskComplete(callback: (strategyId: string) => void): void {
    this.onTaskComplete = callback;
  }

  // ─── selectTargetDimension ───

  /**
   * Confidence-tier weights for dimension selection.
   * Mechanically-observable dimensions are prioritized over LLM-only ones.
   */
  private static readonly CONFIDENCE_WEIGHTS: Record<string, number> = {
    mechanical: 1.0,
    verified: 0.9,
    independent_review: 0.7,
    self_report: 0.3,
  };

  private static getConfidenceWeight(dim: Dimension): number {
    const tier = dim.observation_method.confidence_tier;
    return TaskLifecycle.CONFIDENCE_WEIGHTS[tier] ?? 0.3;
  }

  /**
   * Select the highest-priority dimension to work on based on drive scoring,
   * weighted by observation confidence tier so that mechanically-observable
   * dimensions are preferred over LLM-only ones at equal gap severity.
   *
   * @param gapVector - current gap state for the goal
   * @param driveContext - per-dimension timing/deadline/opportunity context
   * @param dimensions - optional goal dimensions used to apply confidence-tier weighting
   * @returns the name of the top-ranked dimension
   * @throws if gapVector has no gaps (empty)
   */
  selectTargetDimension(gapVector: GapVector, driveContext: DriveContext, dimensions?: Dimension[]): string {
    if (gapVector.gaps.length === 0) {
      throw new Error("selectTargetDimension: gapVector has no gaps (empty gap vector)");
    }

    const scores = scoreAllDimensions(gapVector, driveContext);
    const ranked = rankDimensions(scores);

    if (!dimensions || dimensions.length === 0) {
      // No dimension metadata available — fall back to drive-score ranking only
      // ranked is non-empty: gapVector.gaps.length === 0 guard above ensures at least one gap
      return ranked[0]?.dimension_name ?? gapVector.gaps[0]?.dimension_name ?? "";
    }

    // Build a lookup from dimension name → confidence weight
    const weightByName = new Map<string, number>();
    for (const dim of dimensions) {
      weightByName.set(dim.name, TaskLifecycle.getConfidenceWeight(dim));
    }

    // Apply confidence-tier weighting to final_score for selection only
    const weighted = ranked.map((score) => ({
      dimension_name: score.dimension_name,
      weighted_score: score.final_score * (weightByName.get(score.dimension_name) ?? 0.3),
    }));

    weighted.sort((a, b) => {
      const scoreDiff = b.weighted_score - a.weighted_score;
      if (scoreDiff !== 0) return scoreDiff;
      return a.dimension_name < b.dimension_name ? -1 : a.dimension_name > b.dimension_name ? 1 : 0;
    });

    // weighted is non-empty: ranked is non-empty (gapVector guard above), weighted maps ranked 1:1
    return weighted[0]?.dimension_name ?? gapVector.gaps[0]?.dimension_name ?? "";
  }

  // ─── generateTask ───

  /**
   * Generate a task for the given goal and target dimension via LLM.
   *
   * Delegates to task-generation.ts#generateTask.
   */
  async generateTask(
    goalId: string,
    targetDimension: string,
    strategyId?: string,
    knowledgeContext?: string,
    adapterType?: string,
    existingTasks?: string[],
    workspaceContext?: string
  ): Promise<Task> {
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

  // ─── checkIrreversibleApproval ───

  /**
   * Check whether the task requires human approval and, if so, request it.
   *
   * @param task - the task to check
   * @param confidence - observation confidence for the approval check (default 0.5)
   * @returns true if approved or approval not needed; false if approval was denied
   */
  async checkIrreversibleApproval(task: Task, confidence: number = 0.5): Promise<boolean> {
    const domain = task.task_category;
    const needsApproval = await this.trustManager.requiresApproval(
      task.reversibility,
      domain,
      confidence,
      task.task_category
    );

    if (!needsApproval) {
      return true;
    }

    const approved = await this.approvalFn(task);
    return approved;
  }

  // ─── executeTask ───

  /**
   * Execute a task via the given adapter.
   *
   * Delegates to task-executor.ts#executeTask.
   */
  async executeTask(task: Task, adapter: IAdapter, workspaceContext?: string): Promise<AgentResult> {
    return _executeTask(
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
  }

  // ─── verifyTask ───

  /**
   * Verify task execution results using 3-layer verification.
   *
   * Delegation: logic lives in task-verifier.ts#verifyTask.
   */
  async verifyTask(
    task: Task,
    executionResult: AgentResult
  ): Promise<VerificationResult> {
    return _verifyTask(this.verifierDeps(), task, executionResult);
  }

  // ─── handleVerdict ───

  /**
   * Handle a verification verdict (pass/partial/fail).
   *
   * Delegation: logic lives in task-verifier.ts#handleVerdict.
   */
  async handleVerdict(
    task: Task,
    verificationResult: VerificationResult
  ): Promise<VerdictResult> {
    return _handleVerdict(this.verifierDeps(), task, verificationResult);
  }

  // ─── handleFailure ───

  /**
   * Handle a task failure: increment failure count, record failure,
   * decide keep/discard/escalate.
   *
   * Delegation: logic lives in task-verifier.ts#handleFailure.
   */
  async handleFailure(
    task: Task,
    verificationResult: VerificationResult
  ): Promise<FailureResult> {
    return _handleFailure(this.verifierDeps(), task, verificationResult);
  }

  // ─── runTaskCycle ───

  /**
   * Run a full task cycle: select → generate → approve → execute → verify → verdict.
   */
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
    } catch {
      // If goal load fails, fall back to unweighted selection
    }
    const targetDimension = this.selectTargetDimension(gapVector, driveContext, goalDimensions);

    // 2. Generate task (optionally with injected knowledge context)
    const task = await this.generateTask(goalId, targetDimension, undefined, knowledgeContext, adapter.adapterType, existingTasks, workspaceContext);

    // 3. Pre-execution checks: ethics, capability, irreversible approval
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
      const healthCheck = await this.runPostExecutionHealthCheck(adapter, task);
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

    return {
      task: verdictResult.task,
      verificationResult,
      action: verdictResult.action,
    };
  }

  // ─── Private Helpers ───

  /**
   * Build the VerifierDeps object passed to task-verifier.ts functions.
   */
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
    };
  }

  // ─── Post-Execution Health Check ───

  /**
   * Run build and test checks after successful task execution to verify
   * the codebase remains healthy. Opt-in via healthCheckEnabled constructor option.
   */
  async runPostExecutionHealthCheck(
    _adapter: IAdapter,
    _task: Task,
  ): Promise<{ healthy: boolean; output: string }> {
    // Run build check
    try {
      const buildResult = await this.runShellCommand(["npm", "run", "build"], {
        timeout: 60000,
        cwd: process.cwd(),
      });
      if (!buildResult.success) {
        return {
          healthy: false,
          output: `Build failed: ${buildResult.stderr || buildResult.stdout}`,
        };
      }
    } catch (err) {
      return { healthy: false, output: `Build check error: ${err}` };
    }

    // Run quick test check (just verify tests still pass)
    try {
      const testResult = await this.runShellCommand(
        ["npx", "vitest", "run", "--reporter=dot"],
        { timeout: 120000, cwd: process.cwd() }
      );
      if (!testResult.success) {
        return {
          healthy: false,
          output: `Tests failed: ${testResult.stderr || testResult.stdout}`,
        };
      }
    } catch (err) {
      return { healthy: false, output: `Test check error: ${err}` };
    }

    return { healthy: true, output: "Build and tests passed" };
  }

  /**
   * Run a shell command safely using execFile (not exec) to avoid shell injection.
   *
   * Delegates to task-health-check.ts.
   */
  async runShellCommand(
    argv: string[],
    options: { timeout: number; cwd: string }
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    return _runShellCommand(argv, options);
  }
}
