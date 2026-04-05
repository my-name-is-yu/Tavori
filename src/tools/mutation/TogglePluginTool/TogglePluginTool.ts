import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const TogglePluginInputSchema = z.object({
  pluginId: z.string().min(1, "pluginId is required"),
  enabled: z.boolean(),
});
export type TogglePluginInput = z.infer<typeof TogglePluginInputSchema>;

export class TogglePluginTool implements ITool<TogglePluginInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "toggle_plugin",
    aliases: ["enable_plugin", "disable_plugin"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };
  readonly inputSchema = TogglePluginInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(_input: TogglePluginInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      return {
        success: false,
        data: null,
        summary: "Plugin enable/disable is not yet supported via tools. Use CLI instead.",
        error: "Plugin enable/disable is not yet supported via tools. Use CLI instead.",
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "TogglePluginTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: TogglePluginInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    return { status: "needs_approval", reason: "Toggling a plugin requires user confirmation" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}
