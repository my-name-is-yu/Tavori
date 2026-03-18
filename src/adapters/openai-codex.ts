// ─── OpenAICodexCLIAdapter ───
//
// IAdapter implementation that spawns the `codex` CLI process.
// The task prompt is written to stdin (not passed as a CLI arg) to avoid
// exposing sensitive content in `ps aux` output.
// Uses -s danger-full-access by default for non-interactive execution.
//
// Usage: echo "PROMPT" | codex exec [-s danger-full-access] [-m <model>]
//
// Verified against codex-cli 0.114.0:
//   - `exec` subcommand runs a single prompt non-interactively
//   - `-s danger-full-access` sets sandbox policy to allow full disk/command access
//   - `-m <model>` selects the model (e.g. "o4-mini", "o3")
//   - When [PROMPT] arg is omitted (or `-` is given), prompt is read from stdin
//   - NOTE: --full-auto does NOT exist in this version; use sandbox policy instead

import { spawn } from "node:child_process";
import type { IAdapter, AgentTask, AgentResult } from "../execution/adapter-layer.js";

export interface OpenAICodexCLIAdapterConfig {
  /** The executable name / path for the codex CLI. Default: "codex" */
  cliPath?: string;
  /**
   * Sandbox policy passed via -s flag. Default: "danger-full-access" for
   * non-interactive execution. Use "workspace-write" for a safer sandbox.
   * Set to null to omit the flag entirely.
   */
  sandboxPolicy?: string | null;
  /** If set, pass -m <model> to the CLI. */
  model?: string;
  /** Repository path passed to Codex for workspace-aware execution. Default: "." */
  repoPath?: string;
}

export class OpenAICodexCLIAdapter implements IAdapter {
  readonly adapterType = "openai_codex_cli";
  readonly capabilities = ["execute_code", "read_files", "write_files", "run_commands"] as const;

  private readonly cliPath: string;
  private readonly sandboxPolicy: string | null;
  private readonly model: string | undefined;
  private readonly repoPath: string;

  constructor(config: OpenAICodexCLIAdapterConfig = {}) {
    this.cliPath = config.cliPath ?? "codex";
    this.sandboxPolicy =
      config.sandboxPolicy !== undefined ? config.sandboxPolicy : "danger-full-access";
    this.model = config.model;
    this.repoPath = config.repoPath?.trim() || ".";
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const startedAt = Date.now();

    return new Promise<AgentResult>((resolve) => {
      // Build argument list: exec [-s <policy>] [-m <model>]
      // Prompt is written to stdin (not included in args) to prevent ps aux exposure.
      const spawnArgs: string[] = ["exec"];

      if (this.sandboxPolicy) {
        spawnArgs.push("-s", this.sandboxPolicy);
      }

      if (this.model) {
        spawnArgs.push("-m", this.model);
      }

      // NOTE: --path is NOT supported by codex-cli 0.114.0; use cwd instead

      const child = spawn(this.cliPath, spawnArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: this.repoPath,
        env: process.env,
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

      // Write the prompt to stdin and close so the CLI knows input is done.
      // This avoids exposing the prompt in `ps aux` output.
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
