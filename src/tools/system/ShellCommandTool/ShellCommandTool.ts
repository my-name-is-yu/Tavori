import { z } from "zod";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../types.js";
import { ShellTool } from "../ShellTool/ShellTool.js";

export const ShellCommandInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().default(120_000),
  description: z.string().optional(),
});
export type ShellCommandInput = z.infer<typeof ShellCommandInputSchema>;

export class ShellCommandTool implements ITool<ShellCommandInput> {
  private readonly shellTool = new ShellTool();

  readonly metadata: ToolMetadata = {
    ...this.shellTool.metadata,
    name: "shell_command",
    aliases: ["shell_cmd"],
    tags: ["agentloop", "system", "verification"],
  };

  readonly inputSchema = ShellCommandInputSchema;

  description(): string {
    return "Run a shell command with explicit cwd and timeout. Prefer apply_patch for file edits.";
  }

  async call(input: ShellCommandInput, context: ToolCallContext): Promise<ToolResult> {
    if (input.command.includes("apply_patch")) {
      return {
        success: false,
        data: null,
        summary: "Use the apply_patch tool for patch edits instead of shell_command.",
        error: "apply_patch must be called via the apply_patch tool",
        durationMs: 0,
      };
    }
    return this.shellTool.call(input, context);
  }

  async checkPermissions(input: ShellCommandInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    return this.shellTool.checkPermissions(input, context);
  }

  isConcurrencySafe(input: ShellCommandInput): boolean {
    return this.shellTool.isConcurrencySafe(input);
  }
}
