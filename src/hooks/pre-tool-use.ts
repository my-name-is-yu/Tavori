/**
 * pre-tool-use hook
 *
 * Reads PreToolUse JSON from stdin, checks for irreversible action patterns and
 * basic constraint violations, then allows or blocks the tool call.
 *
 * Exit codes:
 *   0 — pass (tool call allowed)
 *   2 — block (irreversible action or constraint violation detected)
 */

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Irreversible action patterns
// ---------------------------------------------------------------------------

export const IRREVERSIBLE_PATTERNS: RegExp[] = [
  /git\s+push/,
  /rm\s+-rf/,
  /curl\s+-X\s+(POST|PUT|DELETE|PATCH)/i,
  /docker\s+(push|rm)\b/i,
  /npm\s+publish/,
  /\bdeploy\b/i,
  /DROP\s+TABLE/i,
  /DELETE\s+FROM/i,
];

/**
 * Returns the first matching pattern string if any irreversible pattern is
 * detected in `text`, otherwise null.
 */
export function detectIrreversible(text: string): string | null {
  for (const pattern of IRREVERSIBLE_PATTERNS) {
    if (pattern.test(text)) {
      return pattern.toString();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool input scanning
// ---------------------------------------------------------------------------

/**
 * Flatten all string values from a nested object into a single space-joined string.
 */
function flattenValues(obj: unknown): string {
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(flattenValues).join(' ');
  if (obj !== null && typeof obj === 'object') {
    return Object.values(obj as Record<string, unknown>).map(flattenValues).join(' ');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface PreToolUseInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PreToolUseResult {
  exitCode: 0 | 2;
  stderrMessage?: string;
}

export function run(input: PreToolUseInput): PreToolUseResult {
  const { tool_name, tool_input } = input;

  // Build the text corpus to scan: all string values in tool_input
  const corpus = flattenValues(tool_input);

  const matched = detectIrreversible(corpus);
  if (matched) {
    return {
      exitCode: 2,
      stderrMessage:
        `[Motive] Blocked: irreversible action detected in ${tool_name} call.\n` +
        `  Matched pattern: ${matched}\n` +
        `  Please perform this action manually after human review.`,
    };
  }

  // Basic constraint check: block writes to paths clearly outside project scope
  // (absolute paths that do not start with the project root are suspicious for Write/Edit tools)
  const writeTools = new Set(['Write', 'Edit', 'NotebookEdit']);
  if (writeTools.has(tool_name)) {
    const filePath =
      (tool_input.file_path as string | undefined) ??
      (tool_input.notebook_path as string | undefined);

    if (filePath && filePath.startsWith('/') && filePath.includes('..')) {
      return {
        exitCode: 2,
        stderrMessage:
          `[Motive] Blocked: suspicious path traversal detected in ${tool_name}.\n` +
          `  Path: ${filePath}`,
      };
    }
  }

  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/* c8 ignore start */
if (process.argv[1] && process.argv[1].endsWith('pre-tool-use.js')) {
  const raw = readFileSync('/dev/stdin', 'utf-8');
  const input = JSON.parse(raw) as PreToolUseInput;
  const { exitCode, stderrMessage } = run(input);
  if (stderrMessage) process.stderr.write(stderrMessage + '\n');
  process.exit(exitCode);
}
/* c8 ignore end */
