import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
  ToolDescriptionContext,
} from "../../types.js";
import type { ObservationEngine } from "../../../platform/observation/observation-engine.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const ObserveGoalInputSchema = z.object({
  goal_id: z.string().min(1, "goal_id is required"),
});
export type ObserveGoalInput = z.infer<typeof ObserveGoalInputSchema>;

export class ObserveGoalTool implements ITool<ObserveGoalInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "observe-goal",
    aliases: ["observe_goal"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };
  readonly inputSchema = ObserveGoalInputSchema;

  constructor(private readonly observationEngine: ObservationEngine) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: ObserveGoalInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      await this.observationEngine.observe(input.goal_id, []);
      return {
        success: true,
        data: { goal_id: input.goal_id },
        summary: `Observation sweep completed for goal "${input.goal_id}"`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "ObserveGoalTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: ObserveGoalInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: ObserveGoalInput): boolean {
    return true;
  }
}
