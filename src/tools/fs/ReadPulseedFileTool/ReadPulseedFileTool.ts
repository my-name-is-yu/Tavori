import { z } from "zod";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, MAX_OUTPUT_CHARS, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const ReadPulseedFileInputSchema = z.object({
  path: z.string().min(1, "path is required"),
});
export type ReadPulseedFileInput = z.infer<typeof ReadPulseedFileInputSchema>;

const PULSEED_BASE = join(homedir(), ".pulseed");

function resolveSafe(relativePath: string): string | null {
  const full = resolve(join(PULSEED_BASE, relativePath));
  if (!full.startsWith(PULSEED_BASE + "/") && full !== PULSEED_BASE) {
    return null;
  }
  return full;
}

export class ReadPulseedFileTool implements ITool<ReadPulseedFileInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "read-pulseed-file",
    aliases: [],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = ReadPulseedFileInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: ReadPulseedFileInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const fullPath = resolveSafe(input.path);
    if (!fullPath) {
      return {
        success: false,
        data: null,
        summary: "Path traversal blocked: " + input.path,
        error: "Path must be within ~/.pulseed/",
        durationMs: Date.now() - startTime,
      };
    }
    try {
      const content = await fs.readFile(fullPath, "utf-8");
      return {
        success: true,
        data: content,
        summary: content.slice(0, 200),
        durationMs: Date.now() - startTime,
        artifacts: [fullPath],
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "Failed to read ~/.pulseed/" + input.path,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: ReadPulseedFileInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: ReadPulseedFileInput): boolean {
    return true;
  }
}
