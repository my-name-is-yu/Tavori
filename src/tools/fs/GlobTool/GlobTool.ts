import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { glob } from "glob";
import { isAbsolute } from "node:path";
import { validateFilePath } from "../FileValidationTool/FileValidationTool.js";
import { DESCRIPTION_PREFIX, DESCRIPTION_SUFFIX } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS, READ_ONLY } from "./constants.js";

export const GlobInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  limit: z.number().default(500),
});
export type GlobInput = z.infer<typeof GlobInputSchema>;

export class GlobTool implements ITool<GlobInput, string[]> {
  readonly metadata: ToolMetadata = {
    name: "glob",
    aliases: ["find_files", "ls_glob"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = GlobInputSchema;

  description(context?: ToolDescriptionContext): string {
    const cwd = context?.cwd ?? process.cwd();
    return `${DESCRIPTION_PREFIX}${cwd}${DESCRIPTION_SUFFIX}`;
  }

  async call(input: GlobInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const searchPath = input.path ?? context.cwd;
    try {
      const matches = await glob(input.pattern, { cwd: searchPath, absolute: true, nodir: false });
      const limited = matches.slice(0, input.limit);
      return {
        success: true,
        data: limited,
        summary: `Found ${matches.length} files matching "${input.pattern}"${matches.length > input.limit ? ` (showing first ${input.limit})` : ""}`,
        durationMs: Date.now() - startTime,
        artifacts: limited,
      };
    } catch (err) {
      return {
        success: false,
        data: [],
        summary: `Glob failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: GlobInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    if (isAbsolute(input.pattern) || input.pattern.split(/[\\/]+/).includes("..")) {
      return { status: "needs_approval", reason: `Glob pattern may access outside the working directory: ${input.pattern}` };
    }
    if (context) {
      const validation = validateFilePath(input.path ?? ".", context.cwd, context.executionPolicy?.protectedPaths);
      if (!validation.valid) {
        return { status: "needs_approval", reason: `Globbing outside the working directory: ${validation.resolved}` };
      }
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: GlobInput): boolean {
    return true;
  }
}
