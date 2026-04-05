/**
 * Shared utility for parsing raw tool output into typed values.
 * Used by both observation-tools.ts and gap-calculator-tools.ts.
 */

export interface ParsedToolValue {
  value: number | string | boolean | null;
  type: "number" | "string" | "boolean" | "null";
}

/**
 * Parse raw tool output (shell stdout, glob file list, http response) into a typed value.
 *
 * - glob / array: returns file count as number
 * - shell / { stdout }: parse stdout as number, fall back to trimmed string, null if empty
 * - http_fetch / { statusCode }: true if 2xx, false otherwise
 * - other: attempt JSON number/string parse, fall back to string
 */
export function parseToolOutput(
  toolName: string,
  rawData: unknown,
): ParsedToolValue {
  // Glob: array of file matches -> count
  if (Array.isArray(rawData)) {
    const count = rawData.length;
    return { value: count, type: "number" };
  }

  // Shell: { stdout, ... } -> numeric or string
  if (isShellOutput(rawData)) {
    const stdout = rawData.stdout.trim();
    if (stdout === "") return { value: null, type: "null" };
    const num = Number(stdout);
    if (!isNaN(num)) return { value: num, type: "number" };
    return { value: stdout, type: "string" };
  }

  // HTTP fetch: { statusCode, body? } -> boolean 2xx check
  if (isHttpOutput(rawData)) {
    const ok = rawData.statusCode >= 200 && rawData.statusCode < 300;
    return { value: ok, type: "boolean" };
  }

  // Fallback: stringify
  if (rawData === null || rawData === undefined) {
    return { value: null, type: "null" };
  }
  return { value: String(rawData), type: "string" };
}

// ─── Type guards ───

function isShellOutput(data: unknown): data is { stdout: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    "stdout" in data &&
    typeof (data as Record<string, unknown>).stdout === "string"
  );
}

function isHttpOutput(data: unknown): data is { statusCode: number } {
  return (
    typeof data === "object" &&
    data !== null &&
    "statusCode" in data &&
    typeof (data as Record<string, unknown>).statusCode === "number"
  );
}
