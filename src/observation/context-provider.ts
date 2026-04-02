import { execFile } from "node:child_process";
import { accessSync } from "fs";
import { promisify } from "node:util";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import type { MemoryTier } from "../types/memory-lifecycle.js";

const execFileAsync = promisify(execFile);

// ─── Token Budget Constants ───

const WORKSPACE_CONTEXT_BUDGET = 8000;
const WORKSPACE_CONTEXT_MAX_CHARS = 32000;

// ─── Context Item ───

export interface ContextItem {
  label: string;
  content: string;
  memory_tier: MemoryTier;
}

// ─── Tier Classification ───

/**
 * Classify a context section by memory tier.
 * - core: active goal dimensions, current gap, active strategy
 * - recall: recent observations (git diff), strategy history, test status
 * - archival: completed goals
 */
function classifyTier(label: string): MemoryTier {
  const l = label.toLowerCase();
  if (l.includes("goal") || l.includes("gap") || l.includes("strategy")) {
    return "core";
  }
  if (l.includes("recent changes") || l.includes("test status") || l.includes("observation")) {
    return "recall";
  }
  if (l.includes("completed") || l.includes("archive")) {
    return "archival";
  }
  // Default: grep file results are recall (recent workspace context)
  return "recall";
}

// ─── Tier-aware Selection ───

/**
 * Select context items with tier-priority ordering.
 * - Always include all core items
 * - Fill remaining slots from recall items
 * - Only include archival if slots remain
 * - Items with no tier default to recall (backward compat)
 */
export function selectByTier(items: ContextItem[], maxItems: number): ContextItem[] {
  const core = items.filter((i) => (i.memory_tier ?? "recall") === "core");
  const recall = items.filter((i) => (i.memory_tier ?? "recall") === "recall");
  const archival = items.filter((i) => (i.memory_tier ?? "recall") === "archival");

  const selected: ContextItem[] = [...core];
  let remaining = maxItems - selected.length;

  for (const item of recall) {
    if (remaining <= 0) break;
    selected.push(item);
    remaining--;
  }

  for (const item of archival) {
    if (remaining <= 0) break;
    selected.push(item);
    remaining--;
  }

  return selected;
}

/**
 * Apply head 60% / tail 40% truncation with a marker in the middle.
 */
function truncateTobudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  return (
    text.slice(0, headChars) +
    "\n[... truncated to fit token budget ...]\n" +
    text.slice(text.length - tailChars)
  );
}

/**
 * Provides workspace context for task generation.
 * Given a goalId and dimensionName, returns relevant file contents,
 * grep results, and test status.
 */
export async function buildWorkspaceContext(
  goalId: string,
  dimensionName: string,
  options?: {
    cwd?: string;
    maxFileContentLines?: number; // default: 100
    maxTotalChars?: number; // default: WORKSPACE_CONTEXT_MAX_CHARS
  }
): Promise<string> {
  const maxTotalChars = options?.maxTotalChars ?? WORKSPACE_CONTEXT_MAX_CHARS;
  const items = await collectContextItems(goalId, dimensionName, { ...options, maxTotalChars });
  const selected = selectByTier(items, items.length); // include all; callers may use selectByTier with a cap
  const parts = selected.flatMap((item) => [item.label, item.content]);
  const result = parts.join("\n\n") || "(No workspace context available)";
  return truncateTobudget(result, maxTotalChars);
}

/**
 * Collect workspace context as typed ContextItems with memory_tier annotations.
 * Exported for callers that need tier-aware selection.
 */
export async function buildWorkspaceContextItems(
  goalId: string,
  dimensionName: string,
  options?: {
    cwd?: string;
    maxFileContentLines?: number;
    maxItems?: number; // default: unlimited
    maxTotalChars?: number; // default: WORKSPACE_CONTEXT_MAX_CHARS
  }
): Promise<ContextItem[]> {
  const maxTotalChars = options?.maxTotalChars ?? WORKSPACE_CONTEXT_MAX_CHARS;
  const items = await collectContextItems(goalId, dimensionName, { ...options, maxTotalChars });
  const maxItems = options?.maxItems ?? items.length;
  return selectByTier(items, maxItems);
}

async function collectContextItems(
  _goalId: string,
  dimensionName: string,
  options?: {
    cwd?: string;
    maxFileContentLines?: number;
    maxTotalChars?: number;
  }
): Promise<ContextItem[]> {
  const cwd = options?.cwd || process.cwd();
  const maxTotalChars = options?.maxTotalChars ?? WORKSPACE_CONTEXT_MAX_CHARS;
  let cumulativeChars = 0;
  const items: ContextItem[] = [];

  // Determine per-file line limit based on half-budget threshold
  const effectiveMaxLines = (): number => {
    const halfBudget = maxTotalChars / 2;
    return cumulativeChars > halfBudget
      ? 50
      : (options?.maxFileContentLines ?? 100);
  };

  // 1. Search for files related to the dimension name
  // Convert dimension_name to search terms (e.g., "unfinished_item_count" → "UNFINISHED ITEM")
  const searchTerms = dimensionNameToSearchTerms(dimensionName);

  for (const term of searchTerms) {
    if (cumulativeChars >= maxTotalChars) break;
    try {
      const { stdout } = await execFileAsync(
        "grep",
        ["-rn", "--include=*.ts", "--include=*.js", "-l", term, cwd],
        { timeout: 10000 }
      );
      const files = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(0, 5);

      if (files.length > 0) {
        const label = `[grep "${term}" — ${files.length} files matched]`;
        const contentParts: string[] = [];

        // Read first few matching files (up to 3, effectiveMaxLines each)
        for (const filePath of files.slice(0, 3)) {
          if (cumulativeChars >= maxTotalChars) break;
          try {
            const content = await readFile(filePath, "utf-8");
            const maxLines = effectiveMaxLines();
            const lines = content.split("\n").slice(0, maxLines);
            const relativePath = filePath.replace(cwd + "/", "");
            contentParts.push(`[File: ${relativePath} (${lines.length} lines)]`);
            contentParts.push(lines.join("\n"));
          } catch {
            // skip unreadable files
          }
        }

        const itemContent = contentParts.join("\n\n");
        cumulativeChars += label.length + itemContent.length;
        items.push({
          label,
          content: itemContent,
          memory_tier: classifyTier(label),
        });
      }
    } catch {
      // grep returns exit 1 for zero matches — ignore
    }
  }

  if (cumulativeChars < maxTotalChars) {
    // 2. Git diff (recent changes) — recall tier
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "HEAD~1", "--stat"],
        { cwd, timeout: 10000 }
      );
      if (stdout.trim()) {
        const label = `[Recent changes: git diff HEAD~1 --stat]`;
        const content = stdout.trim();
        cumulativeChars += label.length + content.length;
        items.push({ label, content, memory_tier: classifyTier(label) });
      }
    } catch {
      // ignore
    }
  }

  if (cumulativeChars < maxTotalChars) {
    // 3. Test status summary — recall tier
    try {
      const { stdout } = await execFileAsync(
        "npx",
        ["vitest", "run", "--reporter=dot"],
        { cwd, timeout: 30000 }
      );
      const lastLines = stdout.split("\n").slice(-10).join("\n");
      const label = `[Test status]`;
      cumulativeChars += label.length + lastLines.length;
      items.push({ label, content: lastLines, memory_tier: classifyTier(label) });
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "stdout" in err) {
        const lastLines = (
          (err as { stdout: string }).stdout || ""
        )
          .split("\n")
          .slice(-10)
          .join("\n");
        if (lastLines.trim()) {
          const label = `[Test status (failures detected)]`;
          cumulativeChars += label.length + lastLines.length;
          items.push({ label, content: lastLines, memory_tier: classifyTier(label) });
        }
      }
    }
  }

  return items;
}

/**
 * Build a context string for chat mode execution.
 * Gathers git diff, test status, and keyword-matching files.
 */
export async function buildChatContext(taskDescription: string, cwd: string): Promise<string> {
  const gitRoot = resolveGitRoot(cwd);
  const CHAT_CONTEXT_MAX_CHARS = 24000; // ~6000 tokens
  const parts: string[] = [
    `Working directory: ${cwd}`,
    gitRoot !== cwd ? `Git root: ${gitRoot}` : null,
    `Task: ${taskDescription}`,
    `Session type: chat_execution`,
  ].filter((x): x is string => x !== null);

  // 1. git diff HEAD --stat (cap 30 lines)
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "HEAD", "--stat"],
      { cwd: gitRoot, timeout: 10000 }
    );
    const lines = stdout.trim().split("\n").slice(0, 30).join("\n");
    if (lines) {
      parts.push(`[Recent changes: git diff HEAD --stat]\n${lines}`);
    }
  } catch {
    // ignore
  }

  // 2. vitest last 20 lines (5s timeout)
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["vitest", "run", "--reporter=dot"],
      { cwd: gitRoot, timeout: 5000 }
    );
    const lastLines = stdout.split("\n").slice(-20).join("\n");
    if (lastLines.trim()) {
      parts.push(`[Test status]\n${lastLines}`);
    }
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "stdout" in err) {
      const lastLines = ((err as { stdout: string }).stdout || "")
        .split("\n")
        .slice(-20)
        .join("\n");
      if (lastLines.trim()) {
        parts.push(`[Test status (failures detected)]\n${lastLines}`);
      }
    }
  }

  // 3. Keyword-based file search (words >= 4 chars, max 3 keywords, max 3 files, 50 lines each)
  const keywords = taskDescription
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .slice(0, 3);

  for (const keyword of keywords) {
    try {
      const { stdout } = await execFileAsync(
        "grep",
        ["-rn", "--include=*.ts", "--include=*.js", "-l", keyword, gitRoot],
        { timeout: 10000 }
      );
      const files = stdout.trim().split("\n").filter(Boolean).slice(0, 3);
      for (const filePath of files) {
        try {
          const content = await readFile(filePath, "utf-8");
          const lines = content.split("\n").slice(0, 50).join("\n");
          const relativePath = filePath.replace(gitRoot + "/", "");
          parts.push(`[File: ${relativePath} (keyword: ${keyword})]\n${lines}`);
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // grep no match — ignore
    }
  }

  const combined = parts.join("\n\n");
  return truncateTobudget(combined, CHAT_CONTEXT_MAX_CHARS);
}

/**
 * Walk up from cwd until a .git directory is found.
 * Returns cwd itself if no git root is found.
 */
export function resolveGitRoot(cwd: string): string {
  let dir = cwd;
  while (true) {
    try {
      accessSync(join(dir, ".git"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return cwd;
      dir = parent;
    }
  }
}

/**
 * Convert dimension names to search terms for grep.
 * e.g., "unfinished_item_count" → ["UNFINISHED ITEM"], "fixme_count" → ["FIXME"],
 *        "test_coverage" → ["test", "coverage"], "code_quality" → ["quality"]
 */
export function dimensionNameToSearchTerms(dimensionName: string): string[] {
  const terms: string[] = [];
  const lower = dimensionName.toLowerCase();

  if (lower.includes("todo")) terms.push("TODO");
  if (lower.includes("fixme")) terms.push("FIXME");
  if (lower.includes("test")) terms.push("test");
  if (lower.includes("coverage")) terms.push("coverage");
  if (lower.includes("lint") || lower.includes("eslint")) terms.push("eslint");
  if (lower.includes("error") || lower.includes("bug")) terms.push("error");
  if (lower.includes("doc") || lower.includes("readme")) terms.push("README");

  // Fallback: use the dimension name itself as a search term
  if (terms.length === 0) {
    const words = dimensionName.split("_").filter((w) => w.length > 2);
    terms.push(...words.slice(0, 2));
  }

  return terms.length > 0 ? terms : [dimensionName];
}

// Export budget constants for testing
export { WORKSPACE_CONTEXT_BUDGET, WORKSPACE_CONTEXT_MAX_CHARS };
