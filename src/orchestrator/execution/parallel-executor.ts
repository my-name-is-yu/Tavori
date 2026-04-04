// ─── ParallelExecutor ───
//
// Executes a TaskGroup's subtasks in parallel waves, respecting dependency
// ordering and file ownership constraints. Each wave is a set of tasks
// whose dependencies have already completed; waves run via Promise.all.

import type { Logger } from "../../runtime/logger.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { TaskGroup } from "../../base/types/index.js";
import type { AgentTask } from "./adapter-layer.js";
import type { PipelineExecutor } from "./pipeline-executor.js";
import { reconcileResults } from "./result-reconciler.js";
import { durationToMs } from "./task/task-executor.js";

// ─── Result Types ───

export interface SubtaskResult {
  task_id: string;
  verdict: "pass" | "partial" | "fail";
  output: string;
  error?: string;
}

export interface ParallelExecutionResult {
  results: SubtaskResult[];
  overall_verdict: "pass" | "partial" | "fail";
  conflicts_detected: string[];
}

// ─── Deps ───

export interface ParallelExecutorDeps {
  pipelineExecutor: PipelineExecutor;
  logger?: Logger;
  concurrencyLimit?: number; // default 3
  llmClient?: ILLMClient; // optional: enables result reconciliation
}

// ─── ParallelExecutor ───

export class ParallelExecutor {
  private readonly pipelineExecutor: PipelineExecutor;
  private readonly logger?: Logger;
  private readonly concurrencyLimit: number;
  private readonly llmClient?: ILLMClient;

  constructor(deps: ParallelExecutorDeps) {
    this.pipelineExecutor = deps.pipelineExecutor;
    this.logger = deps.logger;
    this.concurrencyLimit = deps.concurrencyLimit ?? 3;
    this.llmClient = deps.llmClient;
  }

  async execute(
    group: TaskGroup,
    context: { goalId: string; strategy_id?: string }
  ): Promise<ParallelExecutionResult> {
    // 1. Validate file ownership — throws on conflict
    const conflicts = this.validateFileOwnership(group);
    if (conflicts.length > 0) {
      throw new Error(
        `[ParallelExecutor] File ownership conflicts detected:\n${conflicts.join("\n")}`
      );
    }

    // 2. Build execution order (topological waves)
    const waves = this.buildExecutionOrder(group);
    this.logger?.info("[ParallelExecutor] Execution waves", {
      goalId: context.goalId,
      waveCount: waves.length,
      waves,
    });

    // 3. Execute waves sequentially, tasks within each wave in parallel (with concurrency limit)
    const allResults: SubtaskResult[] = [];

    for (const wave of waves) {
      const tasks = wave.map((taskId) => () => this.runSubtask(taskId, group, context));
      const waveResults = await this.runWithSemaphore(tasks, this.concurrencyLimit);
      allResults.push(...waveResults);
    }

    // Reconcile results for contradictions (if llmClient is available)
    if (this.llmClient && allResults.length > 1) {
      try {
        const report = await reconcileResults(
          { llmClient: this.llmClient, logger: this.logger },
          allResults
        );
        if (report.has_contradictions) {
          this.logger?.warn("[ParallelExecutor] Result reconciliation found contradictions", {
            goalId: context.goalId,
            contradictions: report.contradictions,
          });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.logger?.warn("[ParallelExecutor] Result reconciliation failed (non-fatal)", { error });
      }
    }

    const overall_verdict = this.aggregateVerdict(allResults);

    this.logger?.info("[ParallelExecutor] Execution complete", {
      goalId: context.goalId,
      overall_verdict,
      resultCount: allResults.length,
    });

    return { results: allResults, overall_verdict, conflicts_detected: conflicts };
  }

  // ─── Public helpers (exposed for testing) ───

  validateFileOwnership(group: TaskGroup): string[] {
    const conflicts: string[] = [];
    // file_ownership maps file path → [task_id, ...]
    for (const [file, owners] of Object.entries(group.file_ownership)) {
      if (owners.length > 1) {
        conflicts.push(`File "${file}" is owned by multiple tasks: ${owners.join(", ")}`);
      }
    }
    return conflicts;
  }

  buildExecutionOrder(group: TaskGroup): string[][] {
    const taskIds = group.subtasks.map((t) => t.id);

    // Build adjacency: dependsOn[id] = set of ids that must complete first
    const dependsOn: Map<string, Set<string>> = new Map();
    for (const id of taskIds) {
      dependsOn.set(id, new Set());
    }
    for (const dep of group.dependencies) {
      // dep.from must complete before dep.to
      dependsOn.get(dep.to)?.add(dep.from);
    }

    // Kahn's algorithm — produce waves
    const waves: string[][] = [];
    const completed = new Set<string>();
    let remaining = new Set(taskIds);

    while (remaining.size > 0) {
      const wave = [...remaining].filter((id) => {
        const deps = dependsOn.get(id) ?? new Set();
        return [...deps].every((d) => completed.has(d));
      });

      if (wave.length === 0) {
        // Cycle detected — include remaining tasks in one wave to avoid infinite loop
        this.logger?.warn("[ParallelExecutor] Cycle detected in dependencies, forcing remaining tasks");
        waves.push([...remaining]);
        break;
      }

      waves.push(wave);
      for (const id of wave) {
        completed.add(id);
        remaining.delete(id);
      }
    }

    return waves;
  }

  // ─── Private helpers ───

  private async runWithSemaphore<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
    const results = new Array<T>(tasks.length);
    let nextIndex = 0;
    async function runNext() {
      while (nextIndex < tasks.length) {
        const i = nextIndex++;
        results[i] = await tasks[i]();
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => runNext()));
    return results;
  }


  private async runSubtask(
    taskId: string,
    group: TaskGroup,
    context: { goalId: string; strategy_id?: string }
  ): Promise<SubtaskResult> {
    const subtask = group.subtasks.find((t) => t.id === taskId);
    if (!subtask) {
      return { task_id: taskId, verdict: "fail", output: "", error: "Subtask not found" };
    }

    // Check if this task has a pipeline attached (via task_category or other mechanism)
    // For now, build a minimal AgentTask from the Task schema fields
    const agentTask: AgentTask = {
      prompt: subtask.work_description,
      timeout_ms: subtask.estimated_duration
        ? durationToMs(subtask.estimated_duration)
        : 60_000,
      adapter_type: "default",
    };

    // Build a simple single-stage pipeline for tasks without explicit pipeline config
    const pipeline = {
      stages: [{ role: "implementor" as const }],
      fail_fast: false,
      shared_context: group.shared_context,
      strategy_id: context.strategy_id,
    };

    try {
      const result = await this.pipelineExecutor.run(
        taskId,
        agentTask,
        pipeline,
        undefined
      );

      const verdict = result.final_verdict as "pass" | "partial" | "fail";
      const lastStage = result.stage_results[result.stage_results.length - 1];

      this.logger?.info("[ParallelExecutor] Subtask complete", { taskId, verdict });

      return {
        task_id: taskId,
        verdict,
        output: lastStage?.output ?? "",
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger?.error("[ParallelExecutor] Subtask threw", { taskId, error });
      return { task_id: taskId, verdict: "fail", output: "", error };
    }
  }

  private aggregateVerdict(results: SubtaskResult[]): "pass" | "partial" | "fail" {
    if (results.length === 0) return "fail";
    const hasFailure = results.some((r) => r.verdict === "fail");
    const hasPass = results.some((r) => r.verdict === "pass");
    if (!hasFailure) return "pass";
    if (hasPass) return "partial";
    return "fail";
  }
}
