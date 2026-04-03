// ─── pulseed task read commands (read-only) ───

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { StateManager } from "../../state/state-manager.js";
import { TaskSchema } from "../../types/task.js";
import type { Task } from "../../types/task.js";
import { getCliLogger } from "../cli-logger.js";
import { formatOperationError } from "../utils.js";

// ─── helpers ───

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function elapsedLabel(task: Task): string {
  if (!task.started_at) return "-";
  const start = new Date(task.started_at).getTime();
  const end = task.completed_at ? new Date(task.completed_at).getTime() : Date.now();
  const ms = end - start;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

async function readAllTasksForGoal(stateManager: StateManager, goalId: string): Promise<Task[]> {
  const baseDir = stateManager.getBaseDir();
  const tasksDir = path.join(baseDir, "tasks", goalId);

  let entries: string[] = [];
  try {
    entries = await fsp.readdir(tasksDir);
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === "task-history.json" || entry === "last-failure-context.json") continue;
    const raw = await stateManager.readRaw(`tasks/${goalId}/${entry}`);
    if (!raw) continue;
    const parsed = TaskSchema.safeParse(raw);
    if (parsed.success) {
      tasks.push(parsed.data);
    } else {
      getCliLogger().error(formatOperationError(`parse task file "${entry}"`, parsed.error));
    }
  }

  return tasks;
}

// ─── cmdTaskList ───

export async function cmdTaskList(stateManager: StateManager, args: string[]): Promise<number> {
  let values: { goal?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        goal: { type: "string" },
      },
      strict: false,
    }) as { values: { goal?: string } });
  } catch (err) {
    getCliLogger().error(formatOperationError("parse task list arguments", err));
    values = {};
  }

  const goalId = values.goal;
  if (!goalId) {
    getCliLogger().error("Error: --goal <goalId> is required for `pulseed task list`.");
    return 1;
  }

  const tasks = await readAllTasksForGoal(stateManager, goalId);

  if (tasks.length === 0) {
    console.log(`No tasks found for goal "${goalId}".`);
    return 0;
  }

  // Sort by created_at descending (most recent first)
  const sorted = [...tasks].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  console.log(`Tasks for goal: ${goalId}\n`);
  console.log(
    `${"ID".padEnd(10)} ${"STATUS".padEnd(12)} ${"VERDICT".padEnd(10)} ${"ELAPSED".padEnd(8)} DESCRIPTION`
  );
  console.log("-".repeat(90));

  for (const task of sorted) {
    const id = shortId(task.id);
    const status = (task.status ?? "pending").padEnd(12);
    const verdict = (task.verification_verdict ?? "-").padEnd(10);
    const elapsed = elapsedLabel(task).padEnd(8);
    const desc = truncate(task.work_description, 60);
    console.log(`${id.padEnd(10)} ${status} ${verdict} ${elapsed} ${desc}`);
  }

  console.log(`\nTotal: ${tasks.length} task(s)`);
  return 0;
}

// ─── cmdTaskShow ───

export async function cmdTaskShow(stateManager: StateManager, args: string[]): Promise<number> {
  let positionals: string[] = [];
  let values: { goal?: string };
  try {
    const parsed = parseArgs({
      args,
      options: {
        goal: { type: "string" },
      },
      allowPositionals: true,
      strict: false,
    }) as { values: { goal?: string }; positionals: string[] };
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    getCliLogger().error(formatOperationError("parse task show arguments", err));
    values = {};
  }

  const taskId = positionals[0];
  const goalId = values.goal;

  if (!taskId) {
    getCliLogger().error("Error: <taskId> is required. Usage: pulseed task show <taskId> --goal <goalId>");
    return 1;
  }
  if (!goalId) {
    getCliLogger().error("Error: --goal <goalId> is required for `pulseed task show`.");
    return 1;
  }

  const raw = await stateManager.readRaw(`tasks/${goalId}/${taskId}.json`);
  if (!raw) {
    getCliLogger().error(`Error: Task "${taskId}" not found for goal "${goalId}".`);
    return 1;
  }

  const parsed = TaskSchema.safeParse(raw);
  if (!parsed.success) {
    getCliLogger().error(formatOperationError(`parse task "${taskId}"`, parsed.error));
    return 1;
  }

  const task = parsed.data;

  console.log(`# Task: ${task.id}`);
  console.log();
  console.log(`Status:        ${task.status}`);
  console.log(`Category:      ${task.task_category}`);
  console.log(`Reversibility: ${task.reversibility}`);
  console.log(`Created at:    ${task.created_at}`);
  if (task.started_at) {
    console.log(`Started at:    ${task.started_at}`);
  }
  if (task.completed_at) {
    console.log(`Completed at:  ${task.completed_at}`);
  }
  if (task.started_at) {
    console.log(`Elapsed:       ${elapsedLabel(task)}`);
  }

  console.log();
  console.log(`## Work Description`);
  console.log(task.work_description);

  console.log();
  console.log(`## Approach`);
  console.log(task.approach);

  if (task.success_criteria.length > 0) {
    console.log();
    console.log(`## Success Criteria`);
    for (const criterion of task.success_criteria) {
      const blocking = criterion.is_blocking ? "[blocking]" : "[optional]";
      console.log(`  ${blocking} ${criterion.description}`);
      console.log(`    Verification: ${criterion.verification_method}`);
    }
  }

  if (task.execution_output) {
    console.log();
    console.log(`## Execution Output`);
    console.log(task.execution_output);
  }

  if (task.verification_verdict) {
    console.log();
    console.log(`## Verification`);
    console.log(`Verdict: ${task.verification_verdict}`);
    if (task.verification_evidence && task.verification_evidence.length > 0) {
      console.log(`Evidence:`);
      for (const evidence of task.verification_evidence) {
        console.log(`  - ${evidence}`);
      }
    }
  }

  if (task.rationale) {
    console.log();
    console.log(`## Rationale`);
    console.log(task.rationale);
  }

  return 0;
}
