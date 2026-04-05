import { z } from "zod";
import type { ITool, ToolMetadata, ToolCallContext, ToolResult, PermissionCheckResult, ToolDescriptionContext } from "../../types.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, MAX_OUTPUT_CHARS, PERMISSION_LEVEL } from "./constants.js";

export const SleepInputSchema = z.object({
  durationMs: z.number().int().min(100).max(300000).describe("Duration to sleep in milliseconds (100ms to 5 minutes)"),
  reason: z.string().optional().describe("Why the agent is waiting (for audit logging)"),
});

export type SleepInput = z.infer<typeof SleepInputSchema>;

export interface SleepOutput {
  sleptMs: number;
  reason?: string;
}

export class SleepTool implements ITool<SleepInput, SleepOutput> {
  readonly metadata: ToolMetadata = {
    name: "sleep",
    aliases: ["wait", "pause"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 10,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };

  readonly inputSchema = SleepInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: SleepInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const reason = input.reason ?? "unspecified";

    context.logger?.debug("sleep.start", { durationMs: input.durationMs, reason });

    await new Promise<void>((resolve) => setTimeout(resolve, input.durationMs));

    const actualMs = Date.now() - startTime;

    const output: SleepOutput = {
      sleptMs: actualMs,
      reason: input.reason,
    };

    const reasonSuffix = input.reason ? ` (${input.reason})` : "";

    return {
      success: true,
      data: output,
      summary: `Slept ${actualMs}ms${reasonSuffix}`,
      durationMs: actualMs,
    };
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
