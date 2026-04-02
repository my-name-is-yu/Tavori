// ─── fetchIssueContext ───
//
// Extracts GitHub issue numbers from goal text and fetches their content via
// `gh issue view`. Returns formatted context for inclusion in task prompts.
// On any failure, returns empty string (graceful degradation).

import { execFileNoThrow } from "../utils/execFileNoThrow.js";

const MAX_ISSUES = 3;
const MAX_BODY_CHARS = 3000;
const FETCH_TIMEOUT_MS = 10000;

interface GhIssueJson {
  title: string;
  body: string;
}

/**
 * Extract unique GitHub issue numbers from text.
 * Skips hex-color-like tokens (non-digit characters after #).
 *
 * Matches #NNN preceded by start-of-string, whitespace, or opening paren,
 * and NOT followed by any non-digit word character.
 * This avoids matching hex colors like #fff, #abc123, or #1a2b3c.
 */
export function extractIssueNumbers(text: string): number[] {
  // Regex is defined locally to avoid shared `lastIndex` state bugs with /g flag
  const issueRefRe = /(?:^|[\s(])#(\d+)(?![a-zA-Z])/g;
  const seen = new Set<number>();
  const results: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = issueRefRe.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
    if (!seen.has(num)) {
      seen.add(num);
      results.push(num);
    }
  }
  return results;
}

/**
 * Fetch a single GitHub issue and format it for prompt inclusion.
 * Returns null on any failure.
 */
async function fetchIssue(num: number): Promise<string | null> {
  try {
    const result = await execFileNoThrow(
      "gh",
      ["issue", "view", String(num), "--json", "title,body"],
      { timeoutMs: FETCH_TIMEOUT_MS }
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return null;
    }
    const parsed = JSON.parse(result.stdout) as GhIssueJson;
    const title = parsed.title ?? "";
    const body = (parsed.body ?? "").slice(0, MAX_BODY_CHARS);
    return `## Referenced Issue #${num}\nTitle: ${title}\n${body}`;
  } catch {
    return null;
  }
}

/**
 * Extract GitHub issue numbers from `text`, fetch their content via `gh`,
 * and return formatted context for use in task prompts.
 *
 * - Deduplicates issue numbers.
 * - Processes at most 3 issues (first ones found).
 * - Returns empty string on any failure.
 */
export async function fetchIssueContext(text: string): Promise<string> {
  try {
    const nums = extractIssueNumbers(text).slice(0, MAX_ISSUES);
    if (nums.length === 0) return "";

    const parts = await Promise.all(nums.map(fetchIssue));
    const valid = parts.filter((p): p is string => p !== null);
    return valid.join("\n\n");
  } catch {
    return "";
  }
}
