// ─── PipelineExecutor ───
//
// Executes a TaskPipeline sequentially with persistence and idempotency.
// Phase 2: Plan Approval Gate, 3-stage escalation, strategy feedback.

import { randomUUID } from "node:crypto";
import type { Logger } from "../runtime/logger.js";
import type { StateManager } from "../state/state-manager.js";
import type { AgentTask, AgentResult, IAdapter } from "./adapter-layer.js";
import { AdapterRegistry } from "./adapter-layer.js";
import type { TaskPipeline, PipelineStage, PipelineState, StageResult } from "../types/pipeline.js";
import { PipelineStateSchema } from "../types/pipeline.js";
import type { Verdict } from "../types/core.js";

// ─── Types ───

export interface PlanApprovalResult {
  approved: boolean;
  plan: string;
  modified_plan?: string;
}

export interface PipelineExecutorDeps {
  stateManager: StateManager;
  adapterRegistry: AdapterRegistry;
  logger?: Logger;
  /** Plan gate: called when plan_required=true and trust < HIGH_TRUST_THRESHOLD */
  approvalFn?: (plan: string) => Promise<boolean>;
  /** Strategy feedback: called at pipeline completion when strategy_id is set */
  strategyFeedbackFn?: (strategyId: string, verdict: string) => void;
  /** Escalation: find an alternative adapter for a domain, excluding a failed one */
  findAlternativeAdapter?: (domain: string, excludeAdapter: string) => string | null;
  /** Max retries per stage (default: 3) */
  maxRetries?: number;
}

export interface PipelineRunResult {
  pipeline_id: string;
  final_verdict: Verdict;
  stage_results: StageResult[];
  status: PipelineState["status"];
}

type TaskPipelineExt = TaskPipeline & { plan_required?: boolean };

const HIGH_TRUST_THRESHOLD = 20;
const PLAN_MODE_PREFIX = "Generate a plan for the following task. Do NOT execute — output the plan only.\n\n";

// ─── PipelineExecutor ───

export class PipelineExecutor {
  private readonly stateManager: StateManager;
  private readonly adapterRegistry: AdapterRegistry;
  private readonly logger?: Logger;
  private readonly approvalFn?: (plan: string) => Promise<boolean>;
  private readonly strategyFeedbackFn?: (strategyId: string, verdict: string) => void;
  private readonly findAlternativeAdapter?: (domain: string, excludeAdapter: string) => string | null;
  private readonly maxRetries: number;

  constructor(deps: PipelineExecutorDeps) {
    this.stateManager = deps.stateManager;
    this.adapterRegistry = deps.adapterRegistry;
    this.logger = deps.logger;
    this.approvalFn = deps.approvalFn;
    this.strategyFeedbackFn = deps.strategyFeedbackFn;
    this.findAlternativeAdapter = deps.findAlternativeAdapter;
    this.maxRetries = deps.maxRetries ?? 3;
  }

  async run(
    taskId: string,
    task: AgentTask,
    pipeline: TaskPipelineExt,
    observationContext?: string,
    trustScore?: number
  ): Promise<PipelineRunResult> {
    let state = await this.restoreState(taskId);
    const isResume = state !== null && state.status === "interrupted";

    if (!isResume) {
      const now = new Date().toISOString();
      state = {
        pipeline_id: randomUUID(),
        task_id: taskId,
        current_stage_index: 0,
        completed_stages: [],
        status: "running",
        started_at: now,
        updated_at: now,
      };
    } else {
      this.logger?.info("[PipelineExecutor] Resuming interrupted pipeline", {
        taskId, fromStage: state!.current_stage_index,
      });
      state = { ...state!, status: "running", updated_at: new Date().toISOString() };
    }

    await this.persistState(taskId, state!);

    for (let i = state!.current_stage_index; i < pipeline.stages.length; i++) {
      const stage = pipeline.stages[i];
      const idempotencyKey = `${taskId}:${i}:0`;

      if (state!.completed_stages.some((r) => r.idempotency_key === idempotencyKey)) {
        this.logger?.info("[PipelineExecutor] Skipping completed stage", { stage: i });
        continue;
      }

      // Plan Approval Gate
      if (stage.role === "implementor" && pipeline.plan_required) {
        const gate = await this.runPlanApprovalGate(stage, task, pipeline, observationContext, trustScore);
        if (!gate.approved) {
          this.logger?.info("[PipelineExecutor] Plan not approved — aborting", { stage: i });
          state = { ...state!, status: "failed", updated_at: new Date().toISOString() };
          await this.persistState(taskId, state);
          break;
        }
        if (gate.modified_plan) {
          pipeline = { ...pipeline, shared_context: gate.modified_plan };
        }
      }

      const stageResult = await this.executeWithEscalation(i, stage, task, pipeline, observationContext, idempotencyKey);

      state = {
        ...state!,
        current_stage_index: i + 1,
        completed_stages: [...state!.completed_stages, stageResult],
        updated_at: new Date().toISOString(),
      };
      await this.persistState(taskId, state);

      this.logger?.info("[PipelineExecutor] Stage complete", { stage: i, role: stage.role, verdict: stageResult.verdict });

      if (pipeline.fail_fast && stageResult.verdict === "fail") {
        state = { ...state, status: "failed", updated_at: new Date().toISOString() };
        await this.persistState(taskId, state);
        break;
      }
    }

    if (state!.status === "running") {
      state = { ...state!, status: "completed", updated_at: new Date().toISOString() };
      await this.persistState(taskId, state);
    }

    const lastStage = state!.completed_stages[state!.completed_stages.length - 1];
    const finalVerdict: Verdict = lastStage?.verdict ?? "fail";

    if (pipeline.strategy_id && this.strategyFeedbackFn) {
      this.strategyFeedbackFn(pipeline.strategy_id, finalVerdict);
    }

    return {
      pipeline_id: state!.pipeline_id,
      final_verdict: finalVerdict,
      stage_results: state!.completed_stages,
      status: state!.status,
    };
  }

  // ─── Plan Approval Gate ───

  private async runPlanApprovalGate(
    stage: PipelineStage,
    task: AgentTask,
    pipeline: TaskPipeline,
    observationContext: string | undefined,
    trustScore: number | undefined
  ): Promise<PlanApprovalResult> {
    const planTask = this.buildStagePrompt(
      { ...stage, prompt_override: PLAN_MODE_PREFIX },
      task, observationContext, pipeline.shared_context
    );

    let plan = "";
    try {
      const adapter = this.selectAdapter(stage);
      const result = await adapter.execute(planTask);
      plan = result.output;
    } catch (err) {
      this.logger?.warn("[PipelineExecutor] Plan generation failed", { error: err instanceof Error ? err.message : String(err) });
      return { approved: false, plan: "" };
    }

    if (trustScore !== undefined && trustScore >= HIGH_TRUST_THRESHOLD) {
      this.logger?.info("[PipelineExecutor] Plan auto-approved (high trust)", { trustScore });
      return { approved: true, plan };
    }

    if (this.approvalFn) {
      return { approved: await this.approvalFn(plan), plan };
    }

    this.logger?.warn("[PipelineExecutor] No approvalFn configured — plan denied");
    return { approved: false, plan };
  }

  // ─── 3-Stage Escalation ───

  private async executeWithEscalation(
    stageIndex: number,
    stage: PipelineStage,
    task: AgentTask,
    pipeline: TaskPipeline,
    observationContext: string | undefined,
    idempotencyKey: string
  ): Promise<StageResult> {
    // Without escalation deps, run a single attempt (backward-compatible).
    const maxAttempts = (this.approvalFn ?? this.findAlternativeAdapter) ? this.maxRetries : 1;
    let lastError = "";
    let currentAdapter = this.selectAdapter(stage);
    const baseTask = this.buildStagePrompt(stage, task, observationContext, pipeline.shared_context);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Strike 2: try alternative adapter
      if (attempt === 1 && stage.capability_requirement?.domain && this.findAlternativeAdapter) {
        const alt = this.findAlternativeAdapter(
          stage.capability_requirement.domain,
          stage.capability_requirement.preferred_adapter ?? ""
        );
        if (alt) {
          try {
            currentAdapter = this.adapterRegistry.getAdapter(alt);
            this.logger?.info("[PipelineExecutor] Escalation: switching adapter", { stage: stageIndex, adapter: alt });
          } catch { /* keep existing */ }
        }
      }

      // Strike 3: human escalation
      if (attempt === this.maxRetries - 1 && this.approvalFn) {
        this.logger?.warn("[PipelineExecutor] Escalation: requesting human approval", { stage: stageIndex });
        const ok = await this.approvalFn(
          `Stage ${stageIndex} (${stage.role}) failed ${attempt} time(s).\nLast error: ${lastError}\n\nApprove to attempt final retry?`
        );
        if (!ok) {
          return this.makeStageResult(stageIndex, stage, idempotencyKey, false, "", "Human escalation rejected");
        }
      }

      const retryTask = attempt === 0
        ? baseTask
        : { ...baseTask, prompt: `${baseTask.prompt}\n\nPREVIOUS ATTEMPT FAILED: ${lastError}\nPlease try again.` };

      let result: AgentResult;
      try {
        result = await currentAdapter.execute(retryTask);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        result = { success: false, output: "", error: lastError, exit_code: null, elapsed_ms: 0, stopped_reason: "error" };
      }

      if (this.mapResultToVerdict(result) !== "fail") {
        return this.makeStageResult(stageIndex, stage, idempotencyKey, result.success, result.output);
      }

      lastError = result.error ?? "unknown failure";
      this.logger?.warn("[PipelineExecutor] Stage attempt failed", { stage: stageIndex, attempt: attempt + 1, error: lastError });
    }

    return this.makeStageResult(stageIndex, stage, idempotencyKey, false, "");
  }

  // ─── Private helpers ───

  private makeStageResult(
    stageIndex: number,
    stage: PipelineStage,
    idempotencyKey: string,
    success: boolean,
    output: string,
    error?: string
  ): StageResult {
    const fakeResult: AgentResult = {
      success,
      output,
      error: error ?? null,
      exit_code: null,
      elapsed_ms: 0,
      stopped_reason: success ? "completed" : "error",
    };
    return {
      stage_index: stageIndex,
      role: stage.role,
      verdict: this.mapResultToVerdict(fakeResult),
      output,
      confidence: success ? 0.8 : 0.2,
      idempotency_key: idempotencyKey,
    };
  }

  private selectAdapter(stage: PipelineStage): IAdapter {
    const preferred = stage.capability_requirement?.preferred_adapter;
    if (preferred) {
      try { return this.adapterRegistry.getAdapter(preferred); } catch { /* fall through */ }
    }
    const types = this.adapterRegistry.listAdapters();
    if (types.length === 0) throw new Error("[PipelineExecutor] No adapters registered");
    return this.adapterRegistry.getAdapter(types[0]);
  }

  private buildStagePrompt(
    stage: PipelineStage,
    task: AgentTask,
    observationContext: string | undefined,
    sharedContext: string | undefined
  ): AgentTask {
    let prompt: string;

    switch (stage.role) {
      case "implementor":
      case "researcher": {
        const parts = [task.prompt];
        if (observationContext) parts.push(`\n\nOBSERVATION CONTEXT:\n${observationContext}`);
        if (sharedContext) parts.push(`\n\nSHARED CONTEXT:\n${sharedContext}`);
        prompt = parts.join("");
        break;
      }
      case "verifier": {
        prompt = task.prompt;
        if (sharedContext) prompt += `\n\nSHARED CONTEXT:\n${sharedContext}`;
        break;
      }
      default: {
        prompt = task.prompt;
      }
    }

    if (stage.prompt_override) prompt = `${stage.prompt_override}\n\n${prompt}`;
    return { ...task, prompt };
  }

  private async persistState(taskId: string, state: PipelineState): Promise<void> {
    await this.stateManager.writeRaw(`pipelines/${taskId}.json`, state);
  }

  private async restoreState(taskId: string): Promise<PipelineState | null> {
    try {
      const raw = await this.stateManager.readRaw(`pipelines/${taskId}.json`);
      if (!raw) return null;
      return PipelineStateSchema.parse(raw);
    } catch {
      return null;
    }
  }

  private mapResultToVerdict(result: AgentResult): Verdict {
    if (result.stopped_reason === "error" || result.stopped_reason === "timeout") return "fail";
    if (result.success) return "pass";
    return "partial";
  }
}
