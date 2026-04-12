import { access } from "node:fs/promises";
import { z } from "zod";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../types.js";

export const ViewImageInputSchema = z.object({
  path: z.string().min(1),
  detail: z.enum(["auto", "original"]).default("auto"),
});
export type ViewImageInput = z.infer<typeof ViewImageInputSchema>;

export class ViewImageTool implements ITool<ViewImageInput> {
  readonly metadata: ToolMetadata = {
    name: "view_image",
    aliases: ["inspect_image"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 4000,
    tags: ["agentloop", "media", "vision"],
  };

  readonly inputSchema = ViewImageInputSchema;

  description(): string {
    return "Register a local image path as an agentloop visual artifact.";
  }

  async call(input: ViewImageInput, _context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      await access(input.path);
      return {
        success: true,
        data: { path: input.path, detail: input.detail },
        summary: `Image artifact ready: ${input.path}`,
        durationMs: Date.now() - started,
        artifacts: [input.path],
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Image not found: ${input.path}`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      };
    }
  }

  async checkPermissions(_input: ViewImageInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: ViewImageInput): boolean {
    return true;
  }
}
