import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../../../base/state/state-manager.js";
import type { Task } from "../../../base/types/task.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  findRunningTasks,
  reconcileInterruptedExecutions,
} from "../runner-recovery.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "test task",
    rationale: "test rationale",
    approach: "test approach",
    success_criteria: [
      {
        description: "Tests pass",
        verification_method: "npx vitest run",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["module A"],
      out_of_scope: ["module B"],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 2, unit: "hours" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("runner-recovery", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      cleanupTempDir(tmpDir);
      tmpDir = null;
    }
  });

  it("finds only valid running task files", async () => {
    tmpDir = makeTempDir();
    const stateManager = new StateManager(tmpDir);
    await stateManager.init();
    await stateManager.writeRaw("tasks/goal-1/running.json", makeTask({ id: "running", status: "running" }));
    await stateManager.writeRaw("tasks/goal-1/done.json", makeTask({ id: "done", status: "completed" }));
    await stateManager.writeRaw("tasks/goal-1/task-history.json", [{ task_id: "old" }]);
    fs.writeFileSync(`${tmpDir}/tasks/goal-1/malformed.json`, "{not-json");

    const tasks = await findRunningTasks(tmpDir, stateManager);

    expect(tasks.map((task) => task.id)).toEqual(["running"]);
  });

  it("reconciles running tasks and stale pipelines on startup", async () => {
    tmpDir = makeTempDir();
    const stateManager = new StateManager(tmpDir);
    await stateManager.init();
    const runningTask = makeTask({
      id: "task-recover",
      goal_id: "goal-recover",
      status: "running",
      started_at: new Date(Date.now() - 5_000).toISOString(),
      consecutive_failure_count: 1,
    });
    await stateManager.writeRaw(`tasks/${runningTask.goal_id}/${runningTask.id}.json`, runningTask);
    await stateManager.writeRaw("pipelines/task-pipeline.json", {
      pipeline_id: "pipe-1",
      task_id: "task-pipeline",
      current_stage_index: 1,
      completed_stages: [],
      status: "running",
      started_at: new Date(Date.now() - 10_000).toISOString(),
      updated_at: new Date(Date.now() - 5_000).toISOString(),
    });

    const recoveredGoalIds = await reconcileInterruptedExecutions({
      baseDir: tmpDir,
      stateManager,
      logger: { warn: vi.fn() },
    });

    expect(recoveredGoalIds).toEqual(["goal-recover"]);
    const task = await stateManager.readRaw(`tasks/${runningTask.goal_id}/${runningTask.id}.json`) as Record<string, unknown>;
    expect(task.status).toBe("error");
    expect(String(task.execution_output)).toContain("[RECOVERED]");

    const history = await stateManager.readRaw(`tasks/${runningTask.goal_id}/task-history.json`) as Array<Record<string, unknown>>;
    expect(history.at(-1)).toMatchObject({
      task_id: "task-recover",
      status: "error",
      primary_dimension: "dim",
      consecutive_failure_count: 1,
    });

    const ledger = await stateManager.readRaw(`tasks/${runningTask.goal_id}/ledger/${runningTask.id}.json`) as { events: Array<{ type: string; action?: string }> };
    expect(ledger.events.map((event) => event.type)).toEqual(["failed", "retried"]);
    expect(ledger.events[1]).toMatchObject({ action: "keep" });

    const pipeline = await stateManager.readRaw("pipelines/task-pipeline.json") as Record<string, unknown>;
    expect(pipeline.status).toBe("interrupted");
  });
});
