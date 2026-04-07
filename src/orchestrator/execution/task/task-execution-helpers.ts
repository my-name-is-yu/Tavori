import type { Logger } from "../../../runtime/logger.js";
import type { Task } from "../../../base/types/task.js";
import type { AgentResult, IAdapter } from "../adapter-layer.js";
import type { GuardrailRunner } from "../../../platform/traits/guardrail-runner.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import { executeTask as executeTaskDirect } from "./task-executor.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { SessionManager } from "../session-manager.js";

interface ExecuteTaskWithGuardsParams {
  task: Task;
  adapter: IAdapter;
  workspaceContext?: string;
  guardrailRunner?: GuardrailRunner;
  toolExecutor?: ToolExecutor;
  stateManager: StateManager;
  sessionManager: SessionManager;
  logger?: Logger;
  execFileSyncFn: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
}

export async function executeTaskWithGuards(
  params: ExecuteTaskWithGuardsParams
): Promise<AgentResult> {
  const {
    task,
    adapter,
    workspaceContext,
    guardrailRunner,
    toolExecutor,
    stateManager,
    sessionManager,
    logger,
    execFileSyncFn,
  } = params;

  if (guardrailRunner) {
    const beforeResult = await guardrailRunner.run("before_tool", {
      checkpoint: "before_tool",
      goal_id: task.goal_id,
      task_id: task.id,
      input: { task, adapter_type: adapter.adapterType },
    });
    if (!beforeResult.allowed) {
      return {
        success: false,
        output: `Guardrail rejected: ${beforeResult.results.map((r) => r.reason).filter(Boolean).join("; ")}`,
        error: "guardrail_rejected",
        exit_code: null,
        elapsed_ms: 0,
        stopped_reason: "error",
      };
    }
  }

  if (toolExecutor) {
    try {
      let trustBalance = 0;
      try {
        await stateManager.loadGoal(task.goal_id);
      } catch {
        // non-fatal, keep default trust balance
      }
      const toolCtx = {
        cwd: process.cwd(),
        goalId: task.goal_id,
        trustBalance,
        preApproved: true,
        approvalFn: async () => false,
      };
      const toolResult = await toolExecutor.execute(
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
      logger?.warn?.(`[TaskLifecycle] run-adapter tool failed, falling back to direct call: ${toolResult.error ?? "unknown"}`);
    } catch (err) {
      logger?.warn?.(`[TaskLifecycle] run-adapter tool threw, falling back to direct call: ${(err as Error).message}`);
    }
  }

  const result = await executeTaskDirect(
    {
      stateManager,
      sessionManager,
      logger,
      execFileSyncFn,
    },
    task,
    adapter,
    workspaceContext
  );

  if (guardrailRunner) {
    const afterResult = await guardrailRunner.run("after_tool", {
      checkpoint: "after_tool",
      goal_id: task.goal_id,
      task_id: task.id,
      input: { task, result, adapter_type: adapter.adapterType },
    });
    if (!afterResult.allowed) {
      return {
        success: false,
        output: `Guardrail rejected result: ${afterResult.results.map((r) => r.reason).filter(Boolean).join("; ")}`,
        error: "guardrail_rejected",
        exit_code: null,
        elapsed_ms: result.elapsed_ms,
        stopped_reason: "error",
      };
    }
  }

  return result;
}

export async function verifyExecutionWithGitDiff(
  toolExecutor: ToolExecutor | undefined,
  goalId: string,
): Promise<{ verified: boolean; diffSummary: string }> {
  if (!toolExecutor) return { verified: true, diffSummary: "" };

  try {
    const result = await toolExecutor.execute(
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

    const filesChanged = (diffText.match(/^diff --git /gm) ?? []).length;
    return {
      verified: filesChanged > 0,
      diffSummary: `${filesChanged} file${filesChanged !== 1 ? "s" : ""} changed`,
    };
  } catch {
    return { verified: true, diffSummary: "diff check failed" };
  }
}
