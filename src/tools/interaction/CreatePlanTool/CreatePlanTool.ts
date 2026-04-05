import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { PLAN_ID_RE, decisionsDir } from "../plan-utils.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const CreatePlanInputSchema = z.object({
  plan_id: z.string().min(1, "plan_id is required").regex(PLAN_ID_RE, "plan_id must be alphanumeric with hyphens only"),
  title: z.string().min(1, "title is required"),
  content: z.string().min(1, "content is required"),
});
export type CreatePlanInput = z.infer<typeof CreatePlanInputSchema>;

export class CreatePlanTool implements ITool<CreatePlanInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "create-plan",
    aliases: ["create_plan", "write_plan"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };
  readonly inputSchema = CreatePlanInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: CreatePlanInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const dir = decisionsDir();
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${input.plan_id}.md`);
      const created_at = new Date().toISOString();
      const fileContent = `---\ntitle: ${input.title}\ncreated_at: ${created_at}\n---\n\n${input.content}\n`;
      await fs.writeFile(filePath, fileContent, "utf8");
      return {
        success: true,
        data: { plan_id: input.plan_id, path: filePath, created_at },
        summary: `Plan written: ${input.plan_id}`,
        durationMs: Date.now() - startTime,
        artifacts: [filePath],
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "CreatePlanTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: CreatePlanInput,
    _context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    return { status: "needs_approval", reason: "Writing plan to ~/.pulseed/decisions/" };
  }

  isConcurrencySafe(_input: CreatePlanInput): boolean {
    return false;
  }
}
