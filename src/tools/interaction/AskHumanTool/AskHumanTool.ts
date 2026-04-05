import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const AskHumanInputSchema = z.object({
  question: z.string().min(1, "question is required"),
  options: z.array(z.string()).optional(),
});
export type AskHumanInput = z.infer<typeof AskHumanInputSchema>;

export class AskHumanTool implements ITool<AskHumanInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "ask-human",
    aliases: ["ask_human", "human_input"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };
  readonly inputSchema = AskHumanInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: AskHumanInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const approved = await context.approvalFn({
        toolName: "ask-human",
        input: { question: input.question, options: input.options },
        reason: input.question,
        permissionLevel: "read_only",
        isDestructive: false,
        reversibility: "reversible",
      });
      const answer = approved ? "approved" : "denied";
      return {
        success: true,
        data: { answer, question: input.question },
        summary: `Human answered: ${answer}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "AskHumanTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: AskHumanInput,
    _context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: AskHumanInput): boolean {
    return false;
  }
}
