import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../types.js";
import type { StateManager } from "../../base/state/state-manager.js";

export const GoalStateInputSchema = z.object({
  goalId: z.string().optional(),
  includeTree: z.boolean().default(false),
});
export type GoalStateInput = z.infer<typeof GoalStateInputSchema>;

export class GoalStateTool implements ITool<GoalStateInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "goal_state",
    aliases: ["get_goal_state", "observe_goal"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 8000,
    tags: ["observe", "goal", "self-grounding"],
  };
  readonly inputSchema = GoalStateInputSchema;

  constructor(private readonly stateManager: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return "Observe PulSeed internal goal state. Returns dimensions, thresholds, current values, gap scores, and confidence for one or all active goals.";
  }

  async call(input: GoalStateInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      if (input.goalId) {
        return await this._singleGoal(input.goalId, input.includeTree, startTime);
      }
      return await this._allGoals(startTime);
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "GoalStateTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private async _singleGoal(goalId: string, includeTree: boolean, startTime: number): Promise<ToolResult> {
    const goal = await this.stateManager.loadGoal(goalId);
    if (!goal) {
      return {
        success: false,
        data: null,
        summary: "Goal not found: " + goalId,
        error: "Goal not found: " + goalId,
        durationMs: Date.now() - startTime,
      };
    }

    const data: Record<string, unknown> = {
      id: goal.id,
      title: goal.title,
      status: goal.status,
      loop_status: goal.loop_status,
      dimensions: goal.dimensions.map((d) => ({
        name: d.name,
        label: d.label,
        current_value: d.current_value,
        threshold: d.threshold,
        confidence: d.confidence,
        last_updated: d.last_updated,
        weight: d.weight,
      })),
    };

    if (includeTree && goal.children_ids.length > 0) {
      const subtree = await this.stateManager.getSubtree(goalId);
      data["subtree"] = subtree
        .filter((g) => g.id !== goalId)
        .map((g) => ({ id: g.id, title: g.title, status: g.status, parent_id: g.parent_id }));
    }

    return {
      success: true,
      data,
      summary: "Goal " + goalId + ": status=" + goal.status + ", " + goal.dimensions.length + " dimensions",
      durationMs: Date.now() - startTime,
    };
  }

  private async _allGoals(startTime: number): Promise<ToolResult> {
    const goalIds = await this.stateManager.listGoalIds();
    if (goalIds.length === 0) {
      return {
        success: true,
        data: { goals: [] },
        summary: "No active goals found",
        durationMs: Date.now() - startTime,
      };
    }

    const goals = await Promise.all(
      goalIds.map(async (id) => {
        const g = await this.stateManager.loadGoal(id);
        if (!g) return null;
        return {
          id: g.id,
          title: g.title,
          status: g.status,
          loop_status: g.loop_status,
          dimension_count: g.dimensions.length,
          dimensions: g.dimensions.map((d) => ({
            name: d.name,
            current_value: d.current_value,
            confidence: d.confidence,
          })),
        };
      })
    );

    const filtered = goals.filter(Boolean);
    return {
      success: true,
      data: { goals: filtered },
      summary: "Found " + filtered.length + " active goal(s)",
      durationMs: Date.now() - startTime,
    };
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
