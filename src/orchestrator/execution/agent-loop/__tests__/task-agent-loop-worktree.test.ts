import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import type { Task } from "../../../../base/types/task.js";
import { prepareTaskAgentLoopWorkspace } from "../task-agent-loop-worktree.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

function makeTask(): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "test task",
    rationale: "why",
    approach: "how",
    success_criteria: [{ description: "done", verification_method: "npx vitest run", is_blocking: true }],
    scope_boundary: { in_scope: ["."], out_of_scope: [], blast_radius: "low" },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 1, unit: "hours" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
  };
}

describe("prepareTaskAgentLoopWorkspace", () => {
  it("creates and cleans up a clean isolated worktree", async () => {
    const repoDir = makeTempDir();
    tempDirs.push(repoDir);
    await fsp.writeFile(path.join(repoDir, "file.txt"), "base\n", "utf-8");
    await run("git", ["init"], repoDir);
    await run("git", ["config", "user.email", "test@example.com"], repoDir);
    await run("git", ["config", "user.name", "Test"], repoDir);
    await run("git", ["add", "file.txt"], repoDir);
    await run("git", ["commit", "-m", "init"], repoDir);

    const baseDir = path.join(path.dirname(repoDir), `${path.basename(repoDir)}.agentloop-worktrees`);
    tempDirs.push(baseDir);
    const workspace = await prepareTaskAgentLoopWorkspace({
      task: makeTask(),
      cwd: repoDir,
      policy: { enabled: true, baseDir },
    });

    expect(workspace.isolated).toBe(true);
    expect(workspace.executionCwd).not.toBe(repoDir);
    expect(fs.existsSync(path.join(workspace.executionCwd, "file.txt"))).toBe(true);

    const finalized = await workspace.finalize({ success: true, changedFiles: [] });
    expect(finalized.cleanupStatus).toBe("cleaned_up");
    expect(fs.existsSync(workspace.executionCwd)).toBe(false);
  });

  it("keeps the isolated worktree when changes exist", async () => {
    const repoDir = makeTempDir();
    tempDirs.push(repoDir);
    await fsp.writeFile(path.join(repoDir, "file.txt"), "base\n", "utf-8");
    await run("git", ["init"], repoDir);
    await run("git", ["config", "user.email", "test@example.com"], repoDir);
    await run("git", ["config", "user.name", "Test"], repoDir);
    await run("git", ["add", "file.txt"], repoDir);
    await run("git", ["commit", "-m", "init"], repoDir);
    const baseDir = path.join(path.dirname(repoDir), `${path.basename(repoDir)}.agentloop-worktrees`);
    tempDirs.push(baseDir);

    const workspace = await prepareTaskAgentLoopWorkspace({
      task: makeTask(),
      cwd: repoDir,
      policy: { enabled: true, baseDir },
    });
    await fsp.writeFile(path.join(workspace.executionCwd, "file.txt"), "changed\n", "utf-8");

    const finalized = await workspace.finalize({ success: true, changedFiles: ["file.txt"] });
    expect(finalized.cleanupStatus).toBe("kept");
    expect(finalized.cleanupReason).toBe("worktree has changes");
    expect(fs.existsSync(workspace.executionCwd)).toBe(true);
  });
});

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd });
    let stderr = "";
    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (chunk: string) => { stderr += chunk; });
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `${command} failed`)));
  });
}
