import { z } from "zod";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../../types.js";
import { validateFilePath } from "../FileValidationTool/FileValidationTool.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";

export const FileWriteInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  createDirs: z.boolean().default(true),
});
export type FileWriteInput = z.infer<typeof FileWriteInputSchema>;

export interface FileWriteOutput {
  path: string;
  bytesWritten: number;
}

export class FileWriteTool implements ITool<FileWriteInput, FileWriteOutput> {
  readonly metadata: ToolMetadata = {
    name: "file_write",
    aliases: [],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: false,
    isDestructive: true,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 3,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = FileWriteInputSchema;

  description(): string {
    return DESCRIPTION;
  }

  async call(input: FileWriteInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const validation = validateFilePath(input.path, context.cwd);
    if (!validation.valid) {
      return {
        success: false,
        data: null,
        summary: `Write blocked: ${validation.error}`,
        error: validation.error,
        durationMs: Date.now() - startTime,
      };
    }
    const { resolved } = validation;

    if (context.dryRun) {
      const bytes = Buffer.byteLength(input.content);
      return {
        success: true,
        data: { path: resolved, bytesWritten: bytes },
        summary: `dry-run: would write ${bytes} bytes to ${resolved}`,
        durationMs: Date.now() - startTime,
      };
    }

    try {
      if (input.createDirs) {
        await fs.mkdir(dirname(resolved), { recursive: true });
      }
      await fs.writeFile(resolved, input.content, "utf-8");
      const bytes = Buffer.byteLength(input.content);
      return {
        success: true,
        data: { path: resolved, bytesWritten: bytes },
        summary: `Wrote ${bytes} bytes to ${resolved}`,
        durationMs: Date.now() - startTime,
        artifacts: [resolved],
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Write failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: FileWriteInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    if (!context.preApproved) {
      return { status: "needs_approval", reason: "Write operations require approval" };
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}
