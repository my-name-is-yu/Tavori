import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../types.js";
import type { StateManager } from "../../base/state/state-manager.js";

export const DeleteGoalInputSchema = z.object({
  goalId: z.string().min(1, "goalId is required"),
});
export type DeleteGoalInput = z.infer<typeof DeleteGoalInputSchema>;

export class DeleteGoalTool implements ITool<DeleteGoalInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "delete_goal",
    aliases: ["remove_goal"],
    permissionLevel: "write_local",
    isReadOnly: false,
    isDestructive: true,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: ["mutation", "goal", "state", "destructive"],
  };
  readonly inputSchema = DeleteGoalInputSchema;

  constructor(private readonly stateManager: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return "Permanently delete a goal and all its children. IRREVERSIBLE — the goal cannot be recovered after deletion.";
  }

  async call(input: DeleteGoalInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      if (!context.preApproved) {
        const approved = await context.approvalFn({
          toolName: this.metadata.name,
          input,
          reason: "Permanently delete goal: " + input.goalId + ". This cannot be undone.",
          permissionLevel: "write_local",
          isDestructive: true,
          reversibility: "irreversible",
        });
        if (!approved) {
          return {
            success: false,
            data: null,
            summary: "Delete denied by user",
            error: "User denied delete operation",
            durationMs: Date.now() - startTime,
          };
        }
      }

      const deleted = await this.stateManager.deleteGoal(input.goalId);
      if (!deleted) {
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
        summary: "Goal permanently deleted: " + input.goalId,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "DeleteGoalTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: DeleteGoalInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    return {
      status: "needs_approval",
      reason: "Permanently deleting a goal is irreversible and requires user confirmation",
    };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}
