import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../types.js";
import { execFileNoThrow } from "../../base/utils/execFileNoThrow.js";

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
    permissionLevel: "read_metrics", isReadOnly: false, isDestructive: false,
    shouldDefer: false, alwaysLoad: true, maxConcurrency: 3,
    maxOutputChars: 8000, tags: ["observation", "verification", "knowledge"],
  };
  readonly inputSchema = ShellInputSchema;

  description(): string {
    return "Execute a read-only shell command and return stdout, stderr, and exit code. Mutation commands are blocked.";
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

  async checkPermissions(input: ShellInput): Promise<PermissionCheckResult> {
    const cmd = input.command.trim();
    const SAFE_PATTERNS = [
      /^(cat|head|tail|wc|ls|pwd|echo|date|hostname|which|type|file)/,
      /^git\s+(status|log|diff|show|branch|rev-parse|rev-list|describe|tag\s+-l)/,
      /^npm\s+(ls|list|view|info|outdated|audit)/,
      /^npx\s+vitest\s+(run|list|--reporter)/,
      /^npx\s+tsc\s+--noEmit/,
      /^rg\s/, /^find\s/, /^du\s/, /^df\s/, /^tree\s/,
    ];
    const DENY_PATTERNS = [
      /rm\s/, /mv\s/, /cp\s/, /mkdir\s/, /touch\s/, /chmod\s/, /chown\s/,
      /git\s+(push|commit|merge|rebase|reset|checkout|clean|stash)/,
      /npm\s+(install|uninstall|publish|run|exec)/,
      /curl\s.*(-X\s*(POST|PUT|DELETE|PATCH)|-d\s)/,
      /wget\s/, /sudo\s/, /mkfs/, /dd\s+if=/, /shutdown/, /reboot/,
      />/, /\|.*(tee|dd|rm|mv)/,
    ];
    const segments = cmd.split(/\s*(?:&&|\|\||;)\s*/);
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      if (DENY_PATTERNS.some(p => p.test(trimmed))) {
        return { status: "denied", reason: `Denied command segment: ${trimmed}` };
      }
    }
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      if (!SAFE_PATTERNS.some(p => p.test(trimmed))) {
        return { status: "needs_approval", reason: `Unknown command segment requires approval: ${trimmed}` };
      }
    }
    return { status: "allowed" };
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
