import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../../types.js";
import { execFileNoThrow } from "../../../base/utils/execFileNoThrow.js";
import { validateFilePath } from "../FileValidationTool/FileValidationTool.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS, READ_ONLY } from "./constants.js";

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
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = GrepInputSchema;

  description(): string {
    return DESCRIPTION;
  }

  async call(input: GrepInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const searchPath = input.path ?? ".";
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

      const result = await execFileNoThrow("rg", args, { cwd: context.cwd, timeoutMs: 30_000 });
      let output = result.stdout.trim();
      if (
        input.outputMode === "content" &&
        input.context !== undefined &&
        output.length > 0 &&
        !output.includes("\n--\n")
      ) {
        output = `${output}\n--`;
      }
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

  async checkPermissions(input: GrepInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    if (context) {
      const validation = validateFilePath(input.path ?? ".", context.cwd, context.executionPolicy?.protectedPaths);
      if (!validation.valid) {
        return { status: "needs_approval", reason: `Searching outside the working directory: ${validation.resolved}` };
      }
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: GrepInput): boolean {
    return true;
  }
}
