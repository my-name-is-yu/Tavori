import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const ArchiveGoalInputSchema = z.object({
  goalId: z.string().min(1, "goalId is required"),
  reason: z.string().optional(),
});
export type ArchiveGoalInput = z.infer<typeof ArchiveGoalInputSchema>;

export class ArchiveGoalTool implements ITool<ArchiveGoalInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "archive_goal",
    aliases: ["complete_goal"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };
  readonly inputSchema = ArchiveGoalInputSchema;

  constructor(private readonly stateManager: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: ArchiveGoalInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      if (!context.preApproved) {
        const approved = await context.approvalFn({
          toolName: this.metadata.name,
          input,
          reason: "Archiving goal: " + input.goalId + (input.reason ? " — " + input.reason : ""),
          permissionLevel: "write_local",
          isDestructive: false,
          reversibility: "reversible",
        });
        if (!approved) {
          return {
            success: false,
            data: null,
            summary: "Archive denied by user",
            error: "User denied archive operation",
            durationMs: Date.now() - startTime,
          };
        }
      }

      const archived = await this.stateManager.archiveGoal(input.goalId);
      if (!archived) {
        return {
          success: false,
          data: null,
          summary: "Goal not found: " + input.goalId,
          error: "Goal not found: " + input.goalId,
          durationMs: Date.now() - startTime,
        };
      }
      return {
        success: true,
        data: { goalId: input.goalId },
        summary: "Goal archived: " + input.goalId,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "ArchiveGoalTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: ArchiveGoalInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    return { status: "needs_approval", reason: "Archiving a goal requires user confirmation" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}
