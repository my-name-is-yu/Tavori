import { z } from "zod";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../types.js";

export const UpdatePlanInputSchema = z.object({
  summary: z.string().optional(),
  steps: z.array(z.object({
    step: z.string().min(1),
    status: z.enum(["pending", "in_progress", "completed"]),
  })).min(1),
});
export type UpdatePlanInput = z.infer<typeof UpdatePlanInputSchema>;

export class UpdatePlanTool implements ITool<UpdatePlanInput> {
  readonly metadata: ToolMetadata = {
    name: "update_plan",
    aliases: ["plan_update"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 0,
    maxOutputChars: 4000,
    tags: ["agentloop", "planning"],
  };

  readonly inputSchema = UpdatePlanInputSchema;

  description(): string {
    return "Update the current agentloop plan with stable step statuses.";
  }

  async call(input: UpdatePlanInput, _context: ToolCallContext): Promise<ToolResult> {
    return {
      success: true,
      data: input,
      summary: input.summary ?? `Plan updated: ${input.steps.length} step(s)`,
      durationMs: 0,
      contextModifier: `Current plan:\n${input.steps.map((s) => `- [${s.status}] ${s.step}`).join("\n")}`,
    };
  }

  async checkPermissions(_input: UpdatePlanInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: UpdatePlanInput): boolean {
    return true;
  }
}
