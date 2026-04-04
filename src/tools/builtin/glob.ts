import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../types.js";
import { glob } from "glob";

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
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 0,
    maxOutputChars: 8000,
    tags: ["filesystem", "search", "observation"],
  };
  readonly inputSchema = GlobInputSchema;

  description(context?: ToolDescriptionContext): string {
    const cwd = context?.cwd ?? process.cwd();
    return `Find files matching a glob pattern. Current directory: ${cwd}. Returns an array of matching file paths sorted by modification time.`;
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

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
