/**
 * Shell command execution helper for post-execution health checks.
 *
 * runPostExecutionHealthCheck is extracted here as a standalone function.
 * The class method in TaskLifecycle is a thin wrapper that passes
 * `this.runShellCommand.bind(this)` so vi.spyOn(lifecycle, "runShellCommand") still works.
 */

import type { IAdapter } from "./adapter-layer.js";
import type { Task } from "../types/task.js";

type ShellCommandFn = (
  argv: string[],
  options: { timeout: number; cwd: string }
) => Promise<{ success: boolean; stdout: string; stderr: string }>;

/**
 * Run build and test checks after successful task execution to verify
 * the codebase remains healthy. Opt-in via healthCheckEnabled constructor option.
 */
export async function runPostExecutionHealthCheck(
  _adapter: IAdapter,
  _task: Task,
  runShellCommandFn: ShellCommandFn,
): Promise<{ healthy: boolean; output: string }> {
  // Run build check
  try {
    const buildResult = await runShellCommandFn(["npm", "run", "build"], {
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
    const testResult = await runShellCommandFn(
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
