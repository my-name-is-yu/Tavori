import { z } from "zod";
import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { validateFilePath } from "../FileValidationTool/FileValidationTool.js";
import { DESCRIPTION_TEMPLATE } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, MAX_OUTPUT_CHARS, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const ListDirInputSchema = z.object({
  path: z.string().min(1),
  recursive: z.boolean().default(false),
  maxDepth: z.number().default(2),
  includeHidden: z.boolean().default(false),
});
export type ListDirInput = z.infer<typeof ListDirInputSchema>;

export interface DirEntry {
  name: string;
  type: "file" | "dir" | "symlink";
  size?: number;
}

export class ListDirTool implements ITool<ListDirInput, DirEntry[]> {
  readonly metadata: ToolMetadata = {
    name: "list_dir",
    aliases: ["ls", "listdir", "readdir"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = ListDirInputSchema;

  description(context?: ToolDescriptionContext): string {
    const cwd = context?.cwd ?? process.cwd();
    return DESCRIPTION_TEMPLATE(cwd);
  }

  async call(input: ListDirInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const dirPath = path.isAbsolute(input.path) ? input.path : path.resolve(context.cwd, input.path);
    try {
      const entries = await listDir(dirPath, input.recursive, input.maxDepth, input.includeHidden, 0);
      return {
        success: true,
        data: entries,
        summary: `Listed ${entries.length} entries in ${dirPath}`,
        durationMs: Date.now() - startTime,
        artifacts: [dirPath],
      };
    } catch (err) {
      return {
        success: false,
        data: [],
        summary: `list_dir failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: ListDirInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    if (context) {
      const validation = validateFilePath(input.path, context.cwd, context.executionPolicy?.protectedPaths);
      if (!validation.valid) {
        return { status: "needs_approval", reason: `Listing outside the working directory: ${validation.resolved}` };
      }
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: ListDirInput): boolean {
    return true;
  }
}

async function listDir(
  dirPath: string,
  recursive: boolean,
  maxDepth: number,
  includeHidden: boolean,
  depth: number
): Promise<DirEntry[]> {
  const rawEntries = await fs.readdir(dirPath, { withFileTypes: true });
  const results: DirEntry[] = [];

  for (const dirent of rawEntries) {
    if (!includeHidden && dirent.name.startsWith(".")) {
      continue;
    }

    const entry = await toDirEntry(dirPath, dirent);
    results.push(entry);

    if (recursive && entry.type === "dir" && depth < maxDepth - 1) {
      const subEntries = await listDir(
        path.join(dirPath, dirent.name),
        recursive,
        maxDepth,
        includeHidden,
        depth + 1
      );
      results.push(...subEntries.map((e) => ({ ...e, name: path.join(dirent.name, e.name) })));
    }
  }

  return results;
}

async function toDirEntry(dirPath: string, dirent: Dirent): Promise<DirEntry> {
  if (dirent.isSymbolicLink()) {
    return { name: dirent.name, type: "symlink" };
  }
  if (dirent.isDirectory()) {
    return { name: dirent.name, type: "dir" };
  }
  // file — get size
  try {
    const stat = await fs.stat(path.join(dirPath, dirent.name));
    return { name: dirent.name, type: "file", size: stat.size };
  } catch {
    return { name: dirent.name, type: "file" };
  }
}
