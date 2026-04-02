// ─── execFileNoThrow ───
//
// Thin wrapper around Node's execFile that never throws.
// Returns { stdout, stderr, exitCode } on success/failure,
// and { stdout: "", stderr: <message>, exitCode: null } on spawn errors.

import { execFile } from "node:child_process";

export interface ExecFileResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface ExecFileOptions {
  /** Timeout in milliseconds. Default: 10000 */
  timeoutMs?: number;
  /** Working directory for the child process. */
  cwd?: string;
  /** Environment variables. Default: process.env */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run a command with execFile and return its result without throwing.
 * On any error (spawn failure, timeout, non-zero exit), the error is
 * captured in the returned object rather than thrown.
 */
export async function execFileNoThrow(
  cmd: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<ExecFileResult> {
  const { timeoutMs = 10000, cwd, env } = options;

  return new Promise<ExecFileResult>((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        cwd,
        env,
        maxBuffer: 1024 * 1024, // 1 MB
      },
      (error, stdout, stderr) => {
        if (error) {
          // error.code is the exit code for non-zero exits; null for spawn errors
          const exitCode =
            typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
              ? (error as NodeJS.ErrnoException & { code?: number }).code!
              : null;
          resolve({ stdout: stdout ?? "", stderr: stderr ?? error.message, exitCode });
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      }
    );
  });
}
