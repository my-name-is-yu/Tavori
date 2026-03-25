import type { Logger } from "../runtime/logger.js";
import { StateManager } from "../state-manager.js";
import { SessionManager } from "./session-manager.js";
import type { AgentTask, AgentResult, IAdapter } from "./adapter-layer.js";
import type { Task } from "../types/task.js";
import { TaskSchema } from "../types/task.js";
import type { Strategy } from "../types/strategy.js";
const DEBUG = process.env.TAVORI_DEBUG === "true";

// ─── Deps interface ───

export interface TaskExecutorDeps {
  stateManager: StateManager;
  sessionManager: SessionManager;
  logger?: Logger;
  execFileSyncFn: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
}

// ─── durationToMs ───

export function durationToMs(duration: { value: number; unit: string }): number {
  const multipliers: Record<string, number> = {
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
  };
  return duration.value * (multipliers[duration.unit] ?? 60 * 60 * 1000);
}

// ─── executeTask ───

/**
 * Execute a task via the given adapter.
 *
 * Creates a session, builds context, converts to AgentTask, executes
 * via adapter, ends session, and updates task status based on result.
 */
export async function executeTask(
  deps: TaskExecutorDeps,
  task: Task,
  adapter: IAdapter,
  workspaceContext?: string,
  activeStrategy?: Strategy
): Promise<AgentResult> {
  const { stateManager, sessionManager, logger, execFileSyncFn } = deps;

  // Create execution session
  const session = await sessionManager.createSession(
    "task_execution",
    task.goal_id,
    task.id
  );

  // Build context
  const contextSlots = sessionManager.buildTaskExecutionContext(
    task.goal_id,
    task.id
  );

  // Convert to AgentTask
  // If the adapter provides formatPrompt, delegate prompt construction to it.
  // Otherwise use the default builder.
  let prompt: string;
  if (adapter.formatPrompt) {
    prompt = adapter.formatPrompt(task, workspaceContext);
  } else {
    // Build prompt with task description as primary content
    const scopeConstraints =
      `\n\nSCOPE CONSTRAINTS (CRITICAL — violations will cause task failure):\n` +
      `- ONLY modify files directly related to the task\n` +
      `- Do NOT modify: config files (*.config.*, package.json, tsconfig.json), CI/CD files, build configuration, dependency files\n` +
      `- Do NOT change function visibility (private→export) or imports in unrelated files\n` +
      `- If a file contains the target pattern inside a string literal or template, leave it as-is`;
    const contextSection = workspaceContext
      ? `\n\nWORKSPACE CONTEXT (use these specific locations):\n${workspaceContext}`
      : "";
    const taskDescription = `You are an AI agent executing a task.\n\nTask: ${task.work_description}\n\nApproach: ${task.approach}\n\nSuccess Criteria:\n${task.success_criteria.map((c) => `- ${c.description}`).join("\n")}${scopeConstraints}${contextSection}`;

    const contextContent = contextSlots
      .filter((slot) => slot.content.trim().length > 0) // Skip empty slots
      .sort((a, b) => a.priority - b.priority)
      .map((slot) => `[${slot.label}]\n${slot.content}`)
      .join("\n\n");

    prompt = contextContent
      ? `${taskDescription}\n\n--- Context ---\n${contextContent}`
      : taskDescription;
  }

  const timeoutMs = task.estimated_duration
    ? durationToMs(task.estimated_duration)
    : 30 * 60 * 1000; // default 30 minutes

  // Resolve allowed_tools from the active strategy (if any).
  // If toolset_locked=true, the strategy must have allowed_tools defined — log a warning if not.
  if (activeStrategy?.toolset_locked && !activeStrategy.allowed_tools?.length) {
    logger?.warn(`[TaskExecutor] Strategy ${activeStrategy.id} has toolset_locked=true but no allowed_tools defined`, {
      taskId: task.id,
    });
  }
  const allowedTools = activeStrategy?.allowed_tools?.length ? activeStrategy.allowed_tools : undefined;

  const agentTask: AgentTask = {
    prompt,
    timeout_ms: timeoutMs,
    adapter_type: adapter.adapterType,
    ...(allowedTools !== undefined ? { allowed_tools: allowedTools } : {}),
  };

  // Update task status to running
  const runningTask = { ...task, status: "running" as const, started_at: new Date().toISOString() };
  await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, runningTask);

  // Execute
  let result: AgentResult;
  try {
    // Generic dedup check — any adapter may optionally implement checkDuplicate
    if (adapter.checkDuplicate) {
      try {
        const isDuplicate = await adapter.checkDuplicate(agentTask);
        if (isDuplicate) {
          // Return synthetic result — task already exists, skip execution
          result = {
            success: true,
            output: 'Skipped: duplicate task detected by adapter',
            error: null,
            exit_code: 0,
            elapsed_ms: 0,
            stopped_reason: 'completed',
          };
          // End session and update task status without calling adapter.execute
          const skipSummary = 'Task skipped: duplicate detected by adapter';
          await sessionManager.endSession(session.id, skipSummary);
          const skipNow = new Date().toISOString();
          const skippedTask = { ...runningTask, status: 'completed' as const, completed_at: skipNow };
          await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, skippedTask);
          return result;
        }
      } catch { /* non-fatal: proceed with execution if dedup check fails */ }
    }
    result = await adapter.execute(agentTask);
  } catch (err) {
    result = {
      success: false,
      output: "",
      error: err instanceof Error ? err.message : String(err),
      exit_code: null,
      elapsed_ms: 0,
      stopped_reason: "error",
    };
  }

  // Post-execution scope check: revert changes to protected files,
  // and annotate result.filesChanged from the same git diff --name-only call.
  if (result.success) {
    try {
      const diffOutput = execFileSyncFn("git", ["diff", "--name-only"], {
        cwd: process.cwd(),
        encoding: "utf-8",
      }).trim();

      const changedFiles = diffOutput ? diffOutput.split("\n") : [];
      result.filesChanged = changedFiles.length > 0;
      if (!result.filesChanged) {
        logger?.warn(
          "[TaskLifecycle] Adapter reported success but no files were modified",
          { taskId: task.id }
        );
      }

      if (changedFiles.length > 0) {
        const protectedPatterns = [
          /vitest\.config/,
          /jest\.config/,
          /tsconfig/,
          /package\.json$/,
          /package-lock\.json$/,
          /\.config\.(ts|js|mjs)$/,
        ];

        const protectedChanges = changedFiles.filter((f) =>
          protectedPatterns.some((p) => p.test(f))
        );

        if (protectedChanges.length > 0) {
          execFileSyncFn("git", ["checkout", "--", ...protectedChanges], {
            cwd: process.cwd(),
            encoding: "utf-8",
          });
          result.output = (result.output || "") +
            `\n[Scope Check] Reverted ${protectedChanges.length} protected file(s): ${protectedChanges.join(", ")}`;
        }
      }
    } catch {
      // Non-fatal: scope check failure should not break execution
    }
  }

  // End session
  const summary = result.success
    ? `Task completed successfully. Output length: ${result.output.length}`
    : `Task failed: ${result.stopped_reason}. Error: ${result.error ?? "unknown"}`;
  await sessionManager.endSession(session.id, summary);

  // Update task status based on result
  const now = new Date().toISOString();
  let newStatus: "completed" | "timed_out" | "error";
  if (result.stopped_reason === "timeout") {
    newStatus = "timed_out";
  } else if (result.stopped_reason === "error" || !result.success) {
    newStatus = "error";
  } else {
    newStatus = "completed";
  }

  const updatedTask = {
    ...runningTask,
    status: newStatus,
    completed_at: now,
    ...(newStatus === "timed_out" ? { timeout_at: now } : {}),
  };
  await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, updatedTask);

  return result;
}

// ─── reloadTaskFromDisk ───

/**
 * Reload a task from disk (falls back to in-memory task if unavailable).
 */
export async function reloadTaskFromDisk(stateManager: StateManager, task: Task): Promise<Task> {
  try {
    const raw = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`);
    if (raw) return TaskSchema.parse(raw);
  } catch { /* fall back to in-memory task */ }
  return task;
}
