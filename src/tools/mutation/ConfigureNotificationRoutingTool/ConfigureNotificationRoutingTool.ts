import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { applyNaturalLanguageNotificationRouting } from "../../../runtime/notification-routing.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const ConfigureNotificationRoutingInputSchema = z.object({
  instruction: z.string().min(1, "instruction is required"),
});
export type ConfigureNotificationRoutingInput = z.infer<typeof ConfigureNotificationRoutingInputSchema>;

export class ConfigureNotificationRoutingTool implements ITool<ConfigureNotificationRoutingInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "configure_notification_routing",
    aliases: ["route_notifications", "configure_reports"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };
  readonly inputSchema = ConfigureNotificationRoutingInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: ConfigureNotificationRoutingInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const update = await applyNaturalLanguageNotificationRouting(input.instruction);
      return {
        success: true,
        data: update,
        summary: update.summary,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: null,
        summary: "ConfigureNotificationRoutingTool failed: " + message,
        error: message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: ConfigureNotificationRoutingInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    return {
      status: "needs_approval",
      reason: "Changing notification and report routing requires user confirmation",
    };
  }

  isConcurrencySafe(_input?: ConfigureNotificationRoutingInput): boolean {
    return false;
  }
}
