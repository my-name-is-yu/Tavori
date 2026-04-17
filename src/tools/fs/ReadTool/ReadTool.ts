import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../../types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validateFilePath } from "../FileValidationTool/FileValidationTool.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS, READ_ONLY } from "./constants.js";

export const ReadInputSchema = z.object({
  file_path: z.string().min(1),
  offset: z.number().min(0).optional(),
  limit: z.number().min(1).default(2000),
});
export type ReadInput = z.infer<typeof ReadInputSchema>;

export class ReadTool implements ITool<ReadInput, string> {
  readonly metadata: ToolMetadata = {
    name: "read",
    aliases: ["cat", "view"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = ReadInputSchema;

  description(): string {
    return DESCRIPTION;
  }

  async call(input: ReadInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const filePath = path.isAbsolute(input.file_path)
      ? input.file_path
      : path.resolve(context.cwd, input.file_path);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");
      const start = input.offset ?? 0;
      const end = Math.min(start + input.limit, lines.length);
      const selected = lines.slice(start, end);
      const formatted = selected.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
      return {
        success: true,
        data: formatted,
        summary: `Read ${end - start} lines from ${path.basename(filePath)} (lines ${start + 1}-${end} of ${lines.length})`,
        durationMs: Date.now() - startTime,
        artifacts: [filePath],
      };
    } catch (err) {
      return {
        success: false,
        data: "",
        summary: `Read failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: ReadInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    const basename = path.basename(input.file_path);
    const sensitivePatterns = [".env", "credentials", "secret", "private_key"];
    if (sensitivePatterns.some((p) => basename.toLowerCase().includes(p))) {
      return { status: "needs_approval", reason: `Reading potentially sensitive file: ${basename}` };
    }
    if (context) {
      const validation = validateFilePath(input.file_path, context.cwd, context.executionPolicy?.protectedPaths);
      if (!validation.valid) {
        return { status: "needs_approval", reason: `Reading outside the working directory: ${validation.resolved}` };
      }
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: ReadInput): boolean {
    return true;
  }
}
