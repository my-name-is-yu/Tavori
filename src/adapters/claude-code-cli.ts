// ─── ClaudeCodeCLIAdapter ───
//
// IAdapter implementation that spawns the `claude` CLI process.
// The task prompt is passed via stdin and the --print flag is used
// for non-interactive (print-mode) execution.
//
// TODO: verify exact CLI flags against the installed claude CLI version.
// Current assumptions based on Claude Code CLI docs (as of 2026-03):
//   - `--print` enables non-interactive print mode
//   - prompt is delivered via stdin
// If the CLI signature changes, update the spawnArgs array below.

import { spawn } from "node:child_process";
import type { IAdapter, AgentTask, AgentResult } from "../adapter-layer.js";

export class ClaudeCodeCLIAdapter implements IAdapter {
  readonly adapterType = "claude_code_cli";
  readonly capabilities = ["execute_code", "read_files", "write_files", "run_commands"] as const;

  /**
   * The executable name / path for the claude CLI.
   * Override in tests to point at a different binary (e.g. "echo").
   */
  private readonly cliPath: string;

  constructor(cliPath: string = "claude") {
    this.cliPath = cliPath;
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const startedAt = Date.now();

    return new Promise<AgentResult>((resolve) => {
      // TODO: verify --print flag works for your installed claude CLI version.
      // Alternative: omit --print and rely purely on stdin piping.
      const spawnArgs: string[] = ["--print"];

      const child = spawn(this.cliPath, spawnArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      // Timeout: send SIGTERM, then record timeout result.
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, task.timeout_ms);

      // Suppress EPIPE errors on stdin: the spawned process may exit and close
      // its stdin pipe before we finish writing (race condition in tests).
      child.stdin.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE") throw err;
        // EPIPE = process already closed stdin; safe to ignore
      });

      // Write the prompt to stdin and close it so the CLI knows input is done.
      child.stdin.write(task.prompt, "utf8");
      child.stdin.end();

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err: Error) => {
        clearTimeout(timeoutHandle);
        resolve({
          success: false,
          output: stdout,
          error: err.message,
          exit_code: null,
          elapsed_ms: Date.now() - startedAt,
          stopped_reason: "error",
        });
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timeoutHandle);
        const elapsed = Date.now() - startedAt;

        if (timedOut) {
          resolve({
            success: false,
            output: stdout,
            error: `Timed out after ${task.timeout_ms}ms`,
            exit_code: code,
            elapsed_ms: elapsed,
            stopped_reason: "timeout",
          });
          return;
        }

        const success = code === 0;
        resolve({
          success,
          output: stdout,
          error: success ? null : stderr || `Process exited with code ${code}`,
          exit_code: code,
          elapsed_ms: elapsed,
          stopped_reason: success ? "completed" : "error",
        });
      });
    });
  }
}
