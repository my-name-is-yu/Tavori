import { spawn } from "node:child_process";
import { z } from "zod";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../types.js";

export const ApplyPatchInputSchema = z.object({
  patch: z.string().min(1),
  cwd: z.string().optional(),
  checkOnly: z.boolean().default(false),
});
export type ApplyPatchInput = z.infer<typeof ApplyPatchInputSchema>;

export class ApplyPatchTool implements ITool<ApplyPatchInput> {
  readonly metadata: ToolMetadata = {
    name: "apply_patch",
    aliases: ["patch"],
    permissionLevel: "write_local",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 1,
    maxOutputChars: 8000,
    tags: ["agentloop", "filesystem", "edit"],
  };

  readonly inputSchema = ApplyPatchInputSchema;

  description(): string {
    return "Apply a unified diff patch to files under the current workspace.";
  }

  async call(input: ApplyPatchInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    const cwd = input.cwd ?? context.cwd;
    const args = input.checkOnly ? ["apply", "--check", "--whitespace=nowarn", "-"] : ["apply", "--whitespace=nowarn", "-"];
    const result = await runGitApply(args, input.patch, cwd);
    const changedPaths = extractPatchPaths(input.patch);
    return {
      success: result.exitCode === 0,
      data: {
        changedPaths,
        stdout: result.stdout,
        stderr: result.stderr,
        checkOnly: input.checkOnly,
      },
      summary: result.exitCode === 0
        ? `${input.checkOnly ? "Patch check passed" : "Patch applied"}: ${changedPaths.join(", ") || "no paths detected"}`
        : `Patch failed: ${result.stderr || result.stdout}`,
      error: result.exitCode === 0 ? undefined : result.stderr || result.stdout,
      durationMs: Date.now() - started,
      artifacts: changedPaths,
    };
  }

  async checkPermissions(_input: ApplyPatchInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(input: ApplyPatchInput): boolean {
    return input.checkOnly;
  }
}

function runGitApply(args: string[], patch: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
    child.stdin.end(patch);
  });
}

function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = line.match(/^\+\+\+\s+b\/(.+)$/);
    if (match?.[1] && match[1] !== "/dev/null") {
      paths.add(match[1]);
    }
  }
  return [...paths];
}
