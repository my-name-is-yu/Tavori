import { z } from "zod";
import { promises as fs } from "node:fs";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../types.js";
import { validateFilePath } from "./file-validation.js";

export const FileEditInputSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
  replaceAll: z.boolean().default(false),
});
export type FileEditInput = z.infer<typeof FileEditInputSchema>;

export interface FileEditOutput {
  path: string;
  matchesReplaced: number;
  bytesWritten: number;
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(search, idx)) !== -1) {
    count++;
    idx += search.length;
  }
  return count;
}

function previewAround(text: string, searchText: string, contextLines = 3): string {
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.includes(searchText));
  if (idx === -1) return "";
  const start = Math.max(0, idx - contextLines);
  const end = Math.min(lines.length, idx + contextLines + 1);
  return lines.slice(start, end).join("\n");
}

export class FileEditTool implements ITool<FileEditInput, FileEditOutput> {
  readonly metadata: ToolMetadata = {
    name: "file_edit",
    aliases: [],
    permissionLevel: "write_local",
    isReadOnly: false,
    isDestructive: true,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 3,
    maxOutputChars: 8000,
    tags: ["file", "edit", "modify", "replace"],
  };
  readonly inputSchema = FileEditInputSchema;

  description(): string {
    return "Edit an existing file by replacing exact text matches. Safer than full file writes for targeted changes.";
  }

  async call(input: FileEditInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const validation = validateFilePath(input.path, context.cwd);
    if (!validation.valid) {
      return {
        success: false,
        data: null,
        summary: `Edit blocked: ${validation.error}`,
        error: validation.error,
        durationMs: Date.now() - startTime,
      };
    }
    const { resolved } = validation;

    let content: string;
    try {
      content = await fs.readFile(resolved, "utf-8");
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Read failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }

    const matchCount = countOccurrences(content, input.oldText);
    if (matchCount === 0) {
      return {
        success: false,
        data: null,
        summary: "Text not found in file",
        error: "Text not found in file",
        durationMs: Date.now() - startTime,
      };
    }
    if (!input.replaceAll && matchCount > 1) {
      return {
        success: false,
        data: null,
        summary: `Found ${matchCount} matches — use replaceAll or provide more context to make match unique`,
        error: `Found ${matchCount} matches — use replaceAll or provide more context to make match unique`,
        durationMs: Date.now() - startTime,
      };
    }

    if (context.dryRun) {
      const preview = previewAround(content, input.oldText);
      return {
        success: true,
        data: { path: resolved, matchesReplaced: matchCount, bytesWritten: 0 },
        summary: `dry-run: would replace ${matchCount} match(es)\n${preview}`,
        durationMs: Date.now() - startTime,
      };
    }

    const newContent = input.replaceAll
      ? content.split(input.oldText).join(input.newText)
      : content.replace(input.oldText, input.newText);
    const replaced = input.replaceAll ? matchCount : 1;

    try {
      await fs.writeFile(resolved, newContent, "utf-8");
      const bytes = Buffer.byteLength(newContent);
      return {
        success: true,
        data: { path: resolved, matchesReplaced: replaced, bytesWritten: bytes },
        summary: `Replaced ${replaced} match(es) in ${resolved}`,
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

  async checkPermissions(_input: FileEditInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    if (!context.preApproved) {
      return { status: "needs_approval", reason: "Write operations require approval" };
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}
