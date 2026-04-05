import { z } from "zod";
import fs from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../types.js";

export const WritePulseedFileInputSchema = z.object({
  path: z.string().min(1, "path is required"),
  content: z.string(),
});
export type WritePulseedFileInput = z.infer<typeof WritePulseedFileInputSchema>;

const PULSEED_BASE = join(homedir(), ".pulseed");

function resolveSafe(relativePath: string): string | null {
  const full = resolve(join(PULSEED_BASE, relativePath));
  if (!full.startsWith(PULSEED_BASE + "/") && full !== PULSEED_BASE) {
    return null;
  }
  return full;
}

export class WritePulseedFileTool implements ITool<WritePulseedFileInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "write-pulseed-file",
    aliases: [],
    permissionLevel: "write_local",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: ["file", "pulseed", "write"],
  };
  readonly inputSchema = WritePulseedFileInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return "Write a file to the ~/.pulseed/ directory. Creates parent directories as needed.";
  }

  async call(input: WritePulseedFileInput, _context: ToolCallContext): Promise<ToolResult> {
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
      await fs.mkdir(dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, input.content, "utf-8");
      const byteLength = Buffer.byteLength(input.content, "utf-8");
      return {
        success: true,
        data: { path: fullPath, byteLength },
        summary: `Wrote ${byteLength} bytes to ~/.pulseed/${input.path}`,
        durationMs: Date.now() - startTime,
        artifacts: [fullPath],
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "Failed to write ~/.pulseed/" + input.path,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: WritePulseedFileInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return {
      status: "needs_approval",
      reason: `Writing to ~/.pulseed/${input.path}`,
    };
  }

  isConcurrencySafe(_input: WritePulseedFileInput): boolean {
    return false;
  }
}
