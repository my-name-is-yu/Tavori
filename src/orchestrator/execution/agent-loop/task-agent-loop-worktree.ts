import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, realpath, rm } from "node:fs/promises";
import type { Task } from "../../../base/types/task.js";
import { execFileNoThrow } from "../../../base/utils/execFileNoThrow.js";
import type { AgentLoopWorkspaceInfo } from "./agent-loop-result.js";

export interface AgentLoopWorktreePolicy {
  enabled?: boolean;
  baseDir?: string;
  keepForDebug?: boolean;
  cleanupPolicy?: "on_success" | "always" | "never";
}

export interface PreparedTaskAgentLoopWorkspace {
  requestedCwd: string;
  executionCwd: string;
  isolated: boolean;
  finalize(input: { success: boolean; changedFiles: string[] }): Promise<AgentLoopWorkspaceInfo>;
}

export async function prepareTaskAgentLoopWorkspace(input: {
  task: Task;
  cwd?: string;
  policy?: AgentLoopWorktreePolicy;
}): Promise<PreparedTaskAgentLoopWorkspace> {
  const requestedCwd = await realpath(input.cwd ?? process.cwd());
  const policy = input.policy ?? {};
  if (!policy.enabled) {
    return {
      requestedCwd,
      executionCwd: requestedCwd,
      isolated: false,
      finalize: async () => ({
        requestedCwd,
        executionCwd: requestedCwd,
        isolated: false,
        cleanupStatus: "not_requested",
      }),
    };
  }

  const repoRoot = await resolveGitRepoRoot(requestedCwd);
  if (!repoRoot) {
    return {
      requestedCwd,
      executionCwd: requestedCwd,
      isolated: false,
      finalize: async () => ({
        requestedCwd,
        executionCwd: requestedCwd,
        isolated: false,
        cleanupStatus: "not_requested",
        cleanupReason: "cwd is not inside a git repository",
      }),
    };
  }

  const headRef = await resolveHeadRef(repoRoot);
  if (!headRef) {
    return {
      requestedCwd,
      executionCwd: requestedCwd,
      isolated: false,
      finalize: async () => ({
        requestedCwd,
        executionCwd: requestedCwd,
        isolated: false,
        cleanupStatus: "not_requested",
        cleanupReason: "git HEAD could not be resolved",
      }),
    };
  }

  const relativeCwd = path.relative(repoRoot, requestedCwd);
  const baseDir = policy.baseDir ?? path.join(
    path.dirname(repoRoot),
    `${path.basename(repoRoot)}.pulseed-agentloop-worktrees`,
  );
  const worktreePath = path.join(
    baseDir,
    sanitizePathSegment(input.task.id),
    randomUUID().slice(0, 8),
  );
  await mkdir(path.dirname(worktreePath), { recursive: true });

  const addResult = await execFileNoThrow("git", ["worktree", "add", "--detach", worktreePath, headRef], {
    cwd: repoRoot,
    timeoutMs: 60_000,
  });
  if ((addResult.exitCode ?? 1) !== 0) {
    return {
      requestedCwd,
      executionCwd: requestedCwd,
      isolated: false,
      finalize: async () => ({
        requestedCwd,
        executionCwd: requestedCwd,
        isolated: false,
        cleanupStatus: "not_requested",
        cleanupReason: `git worktree add failed: ${addResult.stderr || addResult.stdout}`.trim(),
      }),
    };
  }

  const executionCwd = relativeCwd && relativeCwd !== "."
    ? path.join(worktreePath, relativeCwd)
    : worktreePath;

  return {
    requestedCwd,
    executionCwd,
    isolated: true,
    finalize: async ({ success, changedFiles }) => {
      const cleanupPolicy = policy.cleanupPolicy ?? "on_success";
      const shouldKeepForDebug = policy.keepForDebug === true;
      const isDirty = changedFiles.length > 0 || await isGitWorktreeDirty(worktreePath);

      if (shouldKeepForDebug) {
        return {
          requestedCwd,
          executionCwd,
          isolated: true,
          cleanupStatus: "kept",
          cleanupReason: "keepForDebug enabled",
        };
      }

      if (cleanupPolicy === "never") {
        return {
          requestedCwd,
          executionCwd,
          isolated: true,
          cleanupStatus: "kept",
          cleanupReason: "cleanup policy set to never",
        };
      }

      if (cleanupPolicy === "on_success" && (!success || isDirty)) {
        return {
          requestedCwd,
          executionCwd,
          isolated: true,
          cleanupStatus: "kept",
          cleanupReason: !success ? "task did not succeed" : "worktree has changes",
        };
      }

      await removeGitWorktree(repoRoot, worktreePath);
      return {
        requestedCwd,
        executionCwd,
        isolated: true,
        cleanupStatus: "cleaned_up",
      };
    },
  };
}

async function resolveGitRepoRoot(cwd: string): Promise<string | null> {
  const result = await execFileNoThrow("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 10_000 });
  return (result.exitCode ?? 1) === 0 ? await realpath(result.stdout.trim()) : null;
}

async function resolveHeadRef(cwd: string): Promise<string | null> {
  const result = await execFileNoThrow("git", ["rev-parse", "--verify", "HEAD"], { cwd, timeoutMs: 10_000 });
  return (result.exitCode ?? 1) === 0 ? result.stdout.trim() : null;
}

async function isGitWorktreeDirty(cwd: string): Promise<boolean> {
  const result = await execFileNoThrow("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, timeoutMs: 10_000 });
  return (result.exitCode ?? 1) === 0 ? result.stdout.trim().length > 0 : false;
}

async function removeGitWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  const removeResult = await execFileNoThrow("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoRoot,
    timeoutMs: 60_000,
  });
  if ((removeResult.exitCode ?? 1) !== 0) {
    await rm(worktreePath, { recursive: true, force: true });
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}
