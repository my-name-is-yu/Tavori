import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../types.js";
import { execFileNoThrow } from "../../base/utils/execFileNoThrow.js";

export const GrepInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  outputMode: z.enum(["content", "files_with_matches", "count"]).default("files_with_matches"),
  limit: z.number().default(250),
  caseInsensitive: z.boolean().default(false),
  context: z.number().optional(),
});
export type GrepInput = z.infer<typeof GrepInputSchema>;

export class GrepTool implements ITool<GrepInput, string> {
  readonly metadata: ToolMetadata = {
    name: "grep",
    aliases: ["search", "rg"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 0,
    maxOutputChars: 8000,
    tags: ["filesystem", "search", "observation", "knowledge"],
  };
  readonly inputSchema = GrepInputSchema;

  description(): string {
    return "Search file contents using regular expressions (backed by ripgrep). Returns matching lines or file paths.";
  }

  async call(input: GrepInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const searchPath = input.path ?? context.cwd;
    try {
      const args: string[] = ["--no-heading"];
      if (input.caseInsensitive) args.push("-i");
      if (input.glob) args.push("--glob", input.glob);
      if (input.context !== undefined) args.push("-C", String(input.context));
      switch (input.outputMode) {
        case "files_with_matches":
          args.push("-l");
          break;
        case "count":
          args.push("-c");
          break;
        case "content":
          args.push("-n");
          break;
      }
      args.push("--max-count", String(input.limit));
      args.push(input.pattern, searchPath);

      const result = await execFileNoThrow("rg", args, { timeoutMs: 30_000 });
      const output = result.stdout.trim();
      const lines = output ? output.split("\n") : [];
      return {
        success: true,
        data: output,
        summary: `Found ${lines.length} ${input.outputMode === "files_with_matches" ? "files" : "matches"} for pattern "${input.pattern}"`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: "",
        summary: `Grep failed: ${(err as Error).message}`,
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
