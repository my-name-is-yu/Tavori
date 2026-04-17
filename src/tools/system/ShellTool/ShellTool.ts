import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../../types.js";
import { execFileNoThrow } from "../../../base/utils/execFileNoThrow.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, MAX_OUTPUT_CHARS, PERMISSION_LEVEL } from "./constants.js";
import { assessShellCommand } from "./command-policy.js";

export const ShellInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().default(120_000),
  description: z.string().optional(),
});
export type ShellInput = z.infer<typeof ShellInputSchema>;

export interface ShellOutput { stdout: string; stderr: string; exitCode: number; }

export class ShellTool implements ITool<ShellInput, ShellOutput> {
  readonly metadata: ToolMetadata = {
    name: "shell", aliases: ["bash", "exec", "run"],
    permissionLevel: PERMISSION_LEVEL, isReadOnly: false, isDestructive: false,
    shouldDefer: false, alwaysLoad: true, maxConcurrency: 3,
    maxOutputChars: MAX_OUTPUT_CHARS, tags: [...TAGS],
  };
  readonly inputSchema = ShellInputSchema;

  description(): string {
    return DESCRIPTION;
  }

  async call(input: ShellInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const cwd = input.cwd ?? context.cwd;
    try {
      const shell = process.env.SHELL ?? "/bin/zsh";
      const result = await execFileNoThrow(shell, ["-c", input.command], { cwd, timeoutMs: input.timeoutMs });
      const exitCode = result.exitCode ?? -1;
      const output: ShellOutput = { stdout: result.stdout, stderr: result.stderr, exitCode };
      return {
        success: exitCode === 0, data: output,
        summary: exitCode === 0
          ? `Command succeeded (exit 0)${result.stdout.length > 0 ? `: ${result.stdout.slice(0, 200)}` : ""}`
          : `Command failed (exit ${exitCode}): ${result.stderr.slice(0, 200)}`,
        error: exitCode !== 0 ? result.stderr.slice(0, 500) : undefined,
        durationMs: Date.now() - startTime,
        contextModifier: exitCode === 0 ? `Shell output: ${result.stdout.slice(0, 500)}` : undefined,
      };
    } catch (err) {
      return {
        success: false, data: { stdout: "", stderr: (err as Error).message, exitCode: -1 },
        summary: `Shell execution failed: ${(err as Error).message}`,
        error: (err as Error).message, durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: ShellInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    const assessment = assessShellCommand(input.command, context?.executionPolicy, context?.trusted === true);
    if (assessment.status === "allowed") return { status: "allowed" };
    if (assessment.status === "needs_approval") {
      return { status: "needs_approval", reason: assessment.reason ?? "Shell command requires approval" };
    }
    return { status: "denied", reason: assessment.reason ?? "Shell command denied by policy" };
  }

  isConcurrencySafe(input: ShellInput): boolean {
    const cmd = input.command.trim();
    const readOnlyPatterns = [
      /^(cat|head|tail|wc|ls|pwd|echo|date)/,
      /^git\s+(status|log|diff|show|branch)/,
      /^rg\s/, /^find\s/,
    ];
    return readOnlyPatterns.some((re) => re.test(cmd));
  }
}
