import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../types.js";
import type { StateManager } from "../../base/state/state-manager.js";

export const SetGoalInputSchema = z.object({
  description: z.string().min(1, "description is required"),
});
export type SetGoalInput = z.infer<typeof SetGoalInputSchema>;

export class SetGoalTool implements ITool<SetGoalInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "set_goal",
    aliases: ["create_goal"],
    permissionLevel: "write_local",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: ["mutation", "goal", "state"],
  };
  readonly inputSchema = SetGoalInputSchema;

  constructor(private readonly stateManager: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return "Create a new goal with the given description. The goal is reversible — it can be deleted later.";
  }

  async call(input: SetGoalInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const now = new Date().toISOString();
      const goalId = crypto.randomUUID();
      const goal = {
        id: goalId,
        parent_id: null,
        node_type: "goal" as const,
        title: input.description.slice(0, 120),
        description: input.description,
        status: "active" as const,
        dimensions: [],
        gap_aggregation: "max" as const,
        dimension_mapping: null,
        constraints: [],
        children_ids: [],
        target_date: null,
        origin: "manual" as const,
        pace_snapshot: null,
        deadline: null,
        confidence_flag: null,
        user_override: false,
        feasibility_note: null,
        uncertainty_weight: 1.0,
        decomposition_depth: 0,
        specificity_score: null,
        loop_status: "idle" as const,
        created_at: now,
        updated_at: now,
      };
      await this.stateManager.saveGoal(goal);
      return {
        success: true,
        data: { goalId },
        summary: "Goal created: " + goalId,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "SetGoalTool failed: " + (err as Error).message,
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
