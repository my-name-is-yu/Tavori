import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EthicsVerdict } from "../../base/types/ethics.js";
import type { Logger } from "../../runtime/logger.js";

const execFileAsync = promisify(execFile);

// ─── Constants ───

const TASK_NOTE_MARKER = "TO" + "DO";
const ISSUE_MARKER = "FIX" + "ME";

// ─── Workspace Context Scanner ───

/**
 * Gather lightweight workspace facts to ground LLM dimension decomposition.
 * Runs grep/find commands with a 5s total timeout budget.
 * Never throws — returns empty string on any failure.
 */
export async function gatherNegotiationContext(
  goalDescription: string,
  cwd?: string,
  logger?: Logger
): Promise<string> {
  const dir = cwd ?? process.cwd();
  const parts: string[] = [];

  try {
    // Extract keywords from the goal description
    const STOP_WORDS = new Set([
      "a", "an", "the", "and", "or", "but", "to", "for", "in", "on", "at",
      "of", "with", "is", "are", "be", "do", "will", "that", "this", "it",
      "we", "you", "i", "as", "from", "by", "を", "に", "は", "が", "の",
      "で", "と", "も", "する", "た", "て", "し", "へ", "な", "こと",
    ]);
    const keywords = goalDescription
      .split(/[\s,./、。（）()「」\-]+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()));

    // Project structure: count TypeScript files
    let tsFileCount = 0;
    try {
      const { stdout } = await execFileAsync(
        "find",
        [dir + "/src", "-name", "*.ts"],
        { timeout: 3000 }
      );
      const tsFiles = stdout.trim().split("\n").filter(Boolean);
      tsFileCount = tsFiles.length;
      parts.push(
        `Project structure: ${tsFileCount} TypeScript files in src/`
      );

      // Show up to 20 files for structure overview
      const sample = tsFiles.slice(0, 20).map((f) => f.replace(dir + "/", ""));
      if (sample.length > 0) {
        parts.push(`Sample files:\n  ${sample.join("\n  ")}`);
      }
    } catch {
      // find may fail if src/ doesn't exist — ignore
    }

    // Keyword occurrence counts
    const keywordResults: string[] = [];
    const topKeywords = keywords.slice(0, 5);
    for (const kw of topKeywords) {
      try {
        const { stdout } = await execFileAsync(
          "grep",
          ["-rn", "--include=*.ts", "-c", kw, dir + "/src"],
          { timeout: 2000 }
        );
        // Each line is "file:count" — sum them up
        const totalCount = stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .reduce((sum, line) => {
            const count = parseInt(line.split(":").pop() ?? "0", 10);
            return sum + (isNaN(count) ? 0 : count);
          }, 0);
        const fileCount = stdout
          .trim()
          .split("\n")
          .filter((l) => {
            const c = parseInt(l.split(":").pop() ?? "0", 10);
            return !isNaN(c) && c > 0;
          }).length;
        if (totalCount > 0) {
          keywordResults.push(
            `  - "${kw}": ${totalCount} occurrences across ${fileCount} files`
          );
        }
      } catch {
        // grep exit 1 = no matches, ignore
      }
    }

    const descLower = goalDescription.toLowerCase();
    if (descLower.includes("todo") || descLower.includes("fixme")) {
      for (const marker of [TASK_NOTE_MARKER, ISSUE_MARKER] as const) {
        if (!descLower.includes(marker.toLowerCase())) continue;
        try {
          const { stdout: countOut } = await execFileAsync(
            "grep",
            ["-rn", "--include=*.ts", marker, dir + "/src"],
            { timeout: 3000 }
          );
          const lines = countOut.trim().split("\n").filter(Boolean);
          const fileSet = new Set(lines.map((l) => l.split(":")[0]));
          keywordResults.push(
            `  - "${marker}": ${lines.length} occurrences across ${fileSet.size} files`
          );

          // Sample matches (up to 5)
          const sample = lines.slice(0, 5).map((l) => {
            const rel = l.replace(dir + "/", "");
            return `  ${rel}`;
          });
          if (sample.length > 0) {
            parts.push(`Sample ${marker} matches:\n${sample.join("\n")}`);
          }
        } catch {
          // ignore
        }
      }
    }

    if (keywordResults.length > 0) {
      parts.splice(1, 0, `Keywords found:\n${keywordResults.join("\n")}`);
    }
  } catch (err) {
    logger?.warn(`[gatherNegotiationContext] Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }

  if (parts.length === 0) return "";

  return `=== Workspace Context ===\n${parts.join("\n")}`;
}

// ─── Error class ───

export class EthicsRejectedError extends Error {
  constructor(public readonly verdict: EthicsVerdict) {
    super(`Goal rejected by ethics gate: ${verdict.reasoning}`);
    this.name = "EthicsRejectedError";
  }
}
