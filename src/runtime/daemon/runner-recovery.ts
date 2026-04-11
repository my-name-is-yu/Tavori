import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { PipelineStateSchema } from "../../base/types/pipeline.js";
import { TaskSchema, type Task } from "../../base/types/task.js";
import { appendTaskOutcomeEvent } from "../../orchestrator/execution/task/task-outcome-ledger.js";
import { durationToMs } from "../../orchestrator/execution/task/task-executor.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { Logger } from "../logger.js";

export async function reconcileInterruptedExecutions(params: {
  baseDir: string;
  stateManager: StateManager;
  logger: Pick<Logger, "warn">;
}): Promise<string[]> {
  const recoveredGoalIds = new Set<string>();
  const now = new Date().toISOString();

  for (const task of await findRunningTasks(params.baseDir, params.stateManager)) {
    const recoveredTask: Task = TaskSchema.parse({
      ...task,
      status: "error",
      completed_at: task.completed_at ?? now,
      heartbeat_at: now,
      execution_output: [
        task.execution_output,
        "[RECOVERED] Task execution was interrupted by daemon crash or restart before completion.",
      ]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join("\n"),
    });

    await params.stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, recoveredTask);
    await appendRecoveredTaskHistory(params.stateManager, recoveredTask);
    await appendTaskOutcomeEvent(params.stateManager, {
      task: recoveredTask,
      type: "failed",
      attempt: Math.max(task.consecutive_failure_count + 1, 1),
      reason: "task execution interrupted by daemon recovery",
    });
    await appendTaskOutcomeEvent(params.stateManager, {
      task: recoveredTask,
      type: "retried",
      attempt: Math.max(task.consecutive_failure_count + 1, 1),
      action: "keep",
      reason: "daemon restarted; task preserved for retry",
    });
    recoveredGoalIds.add(task.goal_id);
  }

  await reconcileInterruptedPipelines(params.baseDir, params.stateManager, now);

  if (recoveredGoalIds.size > 0) {
    params.logger.warn("Recovered interrupted task executions on startup", {
      goals: [...recoveredGoalIds],
      count: recoveredGoalIds.size,
    });
  }

  return [...recoveredGoalIds];
}

export async function findRunningTasks(baseDir: string, stateManager: StateManager): Promise<Task[]> {
  const tasksDir = path.join(baseDir, "tasks");
  let goalDirs: Array<{ name: string; isDirectory(): boolean }>;
  try {
    goalDirs = await fsp.readdir(tasksDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const runningTasks: Task[] = [];
  for (const goalDir of goalDirs) {
    if (!goalDir.isDirectory()) {
      continue;
    }

    const goalTaskDir = path.join(tasksDir, goalDir.name);
    let taskEntries: Array<{ name: string; isFile(): boolean }>;
    try {
      taskEntries = await fsp.readdir(goalTaskDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of taskEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "task-history.json") {
        continue;
      }

      try {
        const raw = await stateManager.readRaw(`tasks/${goalDir.name}/${entry.name}`);
        if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).status !== "running") {
          continue;
        }
        runningTasks.push(TaskSchema.parse(raw));
      } catch {
        // Ignore malformed task files during startup reconciliation.
      }
    }
  }

  return runningTasks;
}

export async function appendRecoveredTaskHistory(
  stateManager: StateManager,
  task: Task
): Promise<void> {
  const historyPath = `tasks/${task.goal_id}/task-history.json`;
  const existing = await stateManager.readRaw(historyPath);
  const history = Array.isArray(existing) ? existing : [];
  const actualElapsedMs =
    task.started_at && task.completed_at
      ? new Date(task.completed_at).getTime() - new Date(task.started_at).getTime()
      : null;

  history.push({
    task_id: task.id,
    status: task.status,
    primary_dimension: task.primary_dimension,
    consecutive_failure_count: task.consecutive_failure_count,
    completed_at: task.completed_at ?? new Date().toISOString(),
    actual_elapsed_ms: actualElapsedMs,
    estimated_duration_ms: task.estimated_duration ? durationToMs(task.estimated_duration) : null,
  });
  await stateManager.writeRaw(historyPath, history);
}

export async function reconcileInterruptedPipelines(
  baseDir: string,
  stateManager: StateManager,
  now: string
): Promise<void> {
  const pipelinesDir = path.join(baseDir, "pipelines");
  let entries: string[];
  try {
    entries = await fsp.readdir(pipelinesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    try {
      const raw = await stateManager.readRaw(`pipelines/${entry}`);
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const pipelineState = PipelineStateSchema.parse(raw);
      if (pipelineState.status !== "running") {
        continue;
      }

      await stateManager.writeRaw(`pipelines/${entry}`, {
        ...pipelineState,
        status: "interrupted",
        updated_at: now,
      });
    } catch {
      // Ignore malformed pipeline state during startup reconciliation.
    }
  }
}
