import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const UpdateGoalInputSchema = z.object({
  goalId: z.string().min(1, "goalId is required"),
  description: z.string().optional(),
  status: z.enum(["active", "paused", "completed"]).optional(),
});
export type UpdateGoalInput = z.infer<typeof UpdateGoalInputSchema>;

export class UpdateGoalTool implements ITool<UpdateGoalInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "update_goal",
    aliases: ["edit_goal"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };
  readonly inputSchema = UpdateGoalInputSchema;

  constructor(private readonly stateManager: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: UpdateGoalInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const goal = await this.stateManager.loadGoal(input.goalId);
      if (!goal) {
        return {
          success: false,
          data: null,
          summary: "Goal not found: " + input.goalId,
          error: "Goal not found: " + input.goalId,
          durationMs: Date.now() - startTime,
        };
      }

      const updated = { ...goal, updated_at: new Date().toISOString() };
      if (input.description !== undefined) updated.description = input.description;
      if (input.status !== undefined) (updated as Record<string, unknown>).status = input.status;

      await this.stateManager.saveGoal(updated);
      return {
        success: true,
        data: { goalId: input.goalId },
        summary: "Goal updated: " + input.goalId,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "UpdateGoalTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}
