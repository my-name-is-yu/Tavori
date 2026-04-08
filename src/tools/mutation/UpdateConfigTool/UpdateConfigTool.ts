import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { configChangeRequiresApproval } from "../../../base/config/config-metadata.js";
import { getConfigKeys, updateGlobalConfig } from "../../../base/config/global-config.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const UpdateConfigInputSchema = z.object({
  key: z.string().min(1, "key is required"),
  value: z.unknown(),
});
export type UpdateConfigInput = z.infer<typeof UpdateConfigInputSchema>;

export class UpdateConfigTool implements ITool<UpdateConfigInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "update_config",
    aliases: ["set_config"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };
  readonly inputSchema = UpdateConfigInputSchema;

  description(_context?: ToolDescriptionContext): string {
    const keys = getConfigKeys();
    return "Update PulSeed configuration. Available keys: " + keys.join(", ") + ".";
  }

  async call(input: UpdateConfigInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const validKeys = getConfigKeys();
      if (!validKeys.includes(input.key)) {
        return {
          success: false,
          data: null,
          summary: "Unknown config key: " + input.key,
          error: "Unknown config key: \"" + input.key + "\". Available: " + validKeys.join(", "),
          durationMs: Date.now() - startTime,
        };
      }

      const updated = await updateGlobalConfig({ [input.key]: input.value });
      const newValue = (updated as Record<string, unknown>)[input.key];

      const { CONFIG_METADATA } = await import("../../../base/config/config-metadata.js");
      const meta = CONFIG_METADATA[input.key];
      const timing = meta?.appliesAt === "next_session" ? "next session" : "immediately";

      return {
        success: true,
        data: { key: input.key, value: newValue },
        summary: "Config updated: " + input.key + " = " + JSON.stringify(newValue) + " (applies " + timing + ")",
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "UpdateConfigTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: UpdateConfigInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    if (configChangeRequiresApproval(input.key)) {
      return {
        status: "needs_approval",
        reason: "This configuration change is high impact and requires user confirmation",
      };
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}
