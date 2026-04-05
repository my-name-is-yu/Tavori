import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { execFileNoThrow } from "../../../base/utils/execFileNoThrow.js";
import { DESCRIPTION_PREFIX } from "./prompt.js";
import { TAGS, MAX_OUTPUT_CHARS, PERMISSION_LEVEL } from "./constants.js";

export const GitLogInputSchema = z.object({
  cwd: z.string().optional(),
  maxCount: z.number().default(20),
  since: z.string().optional(),
  author: z.string().optional(),
  path: z.string().optional(),
  format: z.enum(["oneline", "full"]).default("oneline"),
});
export type GitLogInput = z.infer<typeof GitLogInputSchema>;

export interface GitLogEntryFull {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export class GitLogTool implements ITool<GitLogInput, string[] | GitLogEntryFull[]> {
  readonly metadata: ToolMetadata = {
    name: "git_log",
    aliases: ["git-log", "gitlog"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = GitLogInputSchema;

  description(context?: ToolDescriptionContext): string {
    const cwd = context?.cwd ?? process.cwd();
    return `${DESCRIPTION_PREFIX} Current directory: ${cwd}.`;
  }

  async call(input: GitLogInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const cwd = input.cwd ?? context.cwd;

    const args = buildGitArgs(input);

    const result = await execFileNoThrow("git", args, { cwd, timeoutMs: 10_000 });

    if (result.exitCode !== 0) {
      return {
        success: false,
        data: [],
        summary: `git log failed: ${result.stderr.slice(0, 200)}`,
        error: result.stderr.slice(0, 500),
        durationMs: Date.now() - startTime,
      };
    }

    const raw = result.stdout.trim();
    if (!raw) {
      return {
        success: true,
        data: [],
        summary: "No commits found",
        durationMs: Date.now() - startTime,
      };
    }

    if (input.format === "oneline") {
      const lines = raw.split("\n").filter(Boolean);
      return {
        success: true,
        data: lines,
        summary: `Found ${lines.length} commit(s)`,
        durationMs: Date.now() - startTime,
      };
    }

    // full format: parse structured entries
    const entries = parseFullLog(raw);
    return {
      success: true,
      data: entries,
      summary: `Found ${entries.length} commit(s)`,
      durationMs: Date.now() - startTime,
    };
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}

function buildGitArgs(input: GitLogInput): string[] {
  const args = ["log", `--max-count=${input.maxCount}`];

  if (input.format === "oneline") {
    args.push("--oneline");
  } else {
    // Separator we can split on: use a null byte record separator
    args.push("--format=%x00hash:%H%x00author:%an%x00date:%aI%x00message:%s");
  }

  if (input.since) {
    args.push(`--since=${input.since}`);
  }
  if (input.author) {
    args.push(`--author=${input.author}`);
  }
  if (input.path) {
    args.push("--", input.path);
  }

  return args;
}

function parseFullLog(raw: string): GitLogEntryFull[] {
  // Each record starts with \x00hash:
  const records = raw.split("\x00hash:").filter(Boolean);
  return records.map((record) => {
    const lines = record.split("\x00");
    const hash = lines[0] ?? "";
    const author = (lines[1] ?? "").replace(/^author:/, "");
    const date = (lines[2] ?? "").replace(/^date:/, "");
    const message = (lines[3] ?? "").replace(/^message:/, "");
    return { hash, author, date, message };
  });
}
