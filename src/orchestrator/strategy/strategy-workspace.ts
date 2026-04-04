/**
 * strategy-workspace.ts
 *
 * Workspace context gathering and per-iteration caching for StrategyManager.
 * Provides grounded project state to strategy selection prompts.
 */

import type { ToolExecutor } from "../../tools/executor.js";
import type { ToolCallContext } from "../../tools/types.js";

// --- WorkspaceContext ---

export interface WorkspaceContext {
  /** Project root files (package.json, tsconfig.json, etc.) */
  rootFiles: string[];
  /** Source file tree (depth-limited) */
  sourceTree: string[];
  /** Recent git activity */
  recentCommits: string[];
  /** Available scripts (from package.json) */
  scripts: Record<string, string>;
  /** Dependencies */
  dependencies: string[];
  /** Test file structure */
  testFiles: string[];
}

/**
 * Build workspace context using tools.
 * Runs 5 parallel tool calls (all read-only).
 * Returns a best-effort result — failed tool calls produce empty arrays.
 */
export async function buildWorkspaceContext(
  toolExecutor: ToolExecutor,
  context: ToolCallContext,
): Promise<WorkspaceContext> {
  const [rootGlob, srcGlob, gitLog, pkgRead, testGlob] =
    await toolExecutor.executeBatch(
      [
        { toolName: "glob", input: { pattern: "*", path: context.cwd } },
        { toolName: "glob", input: { pattern: "src/**/*.ts", path: context.cwd } },
        { toolName: "shell", input: { command: "git log --oneline -10" } },
        { toolName: "read", input: { file_path: `${context.cwd}/package.json` } },
        { toolName: "glob", input: { pattern: "**/*.test.ts", path: context.cwd } },
      ],
      context,
    );

  let pkg: Record<string, unknown> = {};
  if (pkgRead.success && typeof pkgRead.data === "string") {
    try {
      pkg = JSON.parse(pkgRead.data) as Record<string, unknown>;
    } catch {
      // Malformed package.json — ignore
    }
  }

  const gitStdout =
    gitLog.success &&
    typeof gitLog.data === "object" &&
    gitLog.data !== null &&
    "stdout" in gitLog.data &&
    typeof (gitLog.data as { stdout: unknown }).stdout === "string"
      ? (gitLog.data as { stdout: string }).stdout
      : "";

  return {
    rootFiles: rootGlob.success && Array.isArray(rootGlob.data) ? (rootGlob.data as string[]) : [],
    sourceTree: srcGlob.success && Array.isArray(srcGlob.data) ? (srcGlob.data as string[]) : [],
    recentCommits: gitStdout ? gitStdout.split("\n").filter(Boolean) : [],
    scripts: isStringRecord(pkg.scripts) ? (pkg.scripts as Record<string, string>) : {},
    dependencies: typeof pkg.dependencies === "object" && pkg.dependencies !== null
      ? Object.keys(pkg.dependencies as object)
      : [],
    testFiles: testGlob.success && Array.isArray(testGlob.data) ? (testGlob.data as string[]) : [],
  };
}

function isStringRecord(val: unknown): val is Record<string, string> {
  return (
    typeof val === "object" &&
    val !== null &&
    !Array.isArray(val) &&
    Object.values(val as Record<string, unknown>).every((v) => typeof v === "string")
  );
}

// --- WorkspaceContextCache ---

/**
 * Per-iteration cache for WorkspaceContext.
 *
 * Cache is keyed by iteration number. When the iteration advances,
 * the previous result is discarded and rebuilt on next access.
 * Callers can also call `invalidate()` after a task execution completes.
 */
export class WorkspaceContextCache {
  private cached: WorkspaceContext | null = null;
  private cachedAtIteration: number = -1;

  /**
   * Return cached WorkspaceContext if the iteration matches,
   * otherwise rebuild it using the tool executor.
   */
  async get(
    iteration: number,
    toolExecutor: ToolExecutor,
    context: ToolCallContext,
  ): Promise<WorkspaceContext> {
    if (this.cached !== null && this.cachedAtIteration === iteration) {
      return this.cached;
    }
    this.cached = await buildWorkspaceContext(toolExecutor, context);
    this.cachedAtIteration = iteration;
    return this.cached;
  }

  /** Force-invalidate the cache (e.g., after task execution completes). */
  invalidate(): void {
    this.cached = null;
    this.cachedAtIteration = -1;
  }

  /** Whether a valid cache entry exists for the given iteration. */
  isValid(iteration: number): boolean {
    return this.cached !== null && this.cachedAtIteration === iteration;
  }
}

// --- WorkspaceContext formatting ---

/**
 * Format a WorkspaceContext into a compact string for inclusion in LLM prompts.
 */
export function formatWorkspaceContext(ctx: WorkspaceContext): string {
  const lines: string[] = ["=== Workspace Context ==="];

  if (ctx.rootFiles.length > 0) {
    lines.push(`Root files: ${ctx.rootFiles.join(", ")}`);
  }

  if (ctx.sourceTree.length > 0) {
    const preview = ctx.sourceTree.slice(0, 20);
    const extra = ctx.sourceTree.length - preview.length;
    lines.push(
      `Source files (${ctx.sourceTree.length}): ${preview.join(", ")}` +
        (extra > 0 ? ` ... and ${extra} more` : ""),
    );
  }

  if (ctx.recentCommits.length > 0) {
    lines.push("Recent commits:");
    for (const c of ctx.recentCommits.slice(0, 5)) {
      lines.push(`  ${c}`);
    }
  }

  if (Object.keys(ctx.scripts).length > 0) {
    const scriptList = Object.entries(ctx.scripts)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    lines.push(`Scripts: ${scriptList}`);
  }

  if (ctx.dependencies.length > 0) {
    lines.push(`Dependencies: ${ctx.dependencies.slice(0, 10).join(", ")}`);
  }

  if (ctx.testFiles.length > 0) {
    lines.push(`Test files: ${ctx.testFiles.length} files`);
  }

  return lines.join("\n");
}
