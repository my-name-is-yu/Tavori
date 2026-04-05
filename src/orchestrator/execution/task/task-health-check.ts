/**
 * Shell command execution helper for post-execution health checks.
 *
 * runPostExecutionHealthCheck is extracted here as a standalone function.
 * The class method in TaskLifecycle is a thin wrapper that passes
 * `this.runShellCommand.bind(this)` so vi.spyOn(lifecycle, "runShellCommand") still works.
 */

import type { ToolExecutor } from "../../../tools/executor.js";
import type { ToolCallContext } from "../../../tools/types.js";

type ShellCommandFn = (
  argv: string[],
  options: { timeout: number; cwd: string }
) => Promise<{ success: boolean; stdout: string; stderr: string }>;

function makeHealthCheckContext(): ToolCallContext {
  return {
    cwd: process.cwd(),
    goalId: "health-check",
    trustBalance: 100,
    preApproved: true,
    trusted: true,
    approvalFn: async () => true,
  };
}

async function runCommandViaToolExecutor(
  toolExecutor: ToolExecutor,
  argv: string[],
  timeoutMs: number,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const command = argv.join(" ");
  const ctx = makeHealthCheckContext();
  const result = await toolExecutor.execute(
    "shell",
    { command, timeoutMs },
    ctx,
  );
  if (!result.success) {
    return { success: false, stdout: "", stderr: result.error ?? result.summary };
  }
  const data = result.data as { stdout?: string; stderr?: string } | string | null;
  if (typeof data === "string") {
    return { success: true, stdout: data, stderr: "" };
  }
  return {
    success: true,
    stdout: (data as { stdout?: string })?.stdout ?? "",
    stderr: (data as { stderr?: string })?.stderr ?? "",
  };
}

/**
 * Run build and test checks after successful task execution to verify
 * the codebase remains healthy. Opt-in via healthCheckEnabled constructor option.
 *
 * When toolExecutor is provided, shell commands are routed through the 5-gate
 * ToolExecutor pipeline (with trusted=true to bypass DENY_PATTERNS).
 * Falls back to runShellCommandFn when toolExecutor is absent.
 */
export async function runPostExecutionHealthCheck(
  runShellCommandFn: ShellCommandFn,
  toolExecutor?: ToolExecutor,
): Promise<{ healthy: boolean; output: string }> {
  const runCmd = toolExecutor
    ? (argv: string[], opts: { timeout: number; cwd: string }) =>
        runCommandViaToolExecutor(toolExecutor, argv, opts.timeout)
    : runShellCommandFn;

  // Run build check
  try {
    const buildResult = await runCmd(["npm", "run", "build"], {
      timeout: 60000,
      cwd: process.cwd(),
    });
    if (!buildResult.success) {
      return {
        healthy: false,
        output: `Build failed: ${buildResult.stderr || buildResult.stdout}`,
      };
    }
  } catch (err) {
    return { healthy: false, output: `Build check error: ${err}` };
  }

  // Run quick test check (just verify tests still pass)
  try {
    const testResult = await runCmd(
      ["npx", "vitest", "run", "--reporter=dot"],
      { timeout: 120000, cwd: process.cwd() }
    );
    if (!testResult.success) {
      return {
        healthy: false,
        output: `Tests failed: ${testResult.stderr || testResult.stdout}`,
      };
    }
  } catch (err) {
    return { healthy: false, output: `Test check error: ${err}` };
  }

  return { healthy: true, output: "Build and tests passed" };
}

/**
 * Run a shell command safely using execFile (not exec) to avoid shell injection.
 */
export async function runShellCommand(
  argv: string[],
  options: { timeout: number; cwd: string }
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  try {
    const { stdout, stderr } = await execFileAsync(argv[0]!, argv.slice(1), {
      timeout: options.timeout,
      cwd: options.cwd,
    });
    return { success: true, stdout, stderr };
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "stdout" in err) {
      const e = err as { stdout: string; stderr: string };
      return { success: false, stdout: e.stdout || "", stderr: e.stderr || "" };
    }
    return { success: false, stdout: "", stderr: String(err) };
  }
}
