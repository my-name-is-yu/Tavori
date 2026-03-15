// ─── OpenAICodexCLIAdapter ───
//
// IAdapter implementation that spawns the `codex` CLI process.
// The task prompt is passed as a positional argument to the `exec` subcommand.
// Uses --full-auto by default for non-interactive execution.
//
// Usage: codex exec [--full-auto] [--model <model>] "PROMPT"
//
// TODO: verify exact CLI flags against the installed codex CLI version.
// Current assumptions based on OpenAI Codex CLI docs (as of 2026-03):
//   - `exec` subcommand runs a single prompt non-interactively
//   - `--full-auto` enables full-auto approval mode (no human-in-the-loop prompts)
//   - `--model <model>` selects the model (e.g. "o4-mini", "o3")
//   - prompt is delivered as a positional argument
// If the CLI signature changes, update the spawnArgs array below.

import { spawn } from "node:child_process";
import type { IAdapter, AgentTask, AgentResult } from "../adapter-layer.js";

export interface OpenAICodexCLIAdapterConfig {
  /** The executable name / path for the codex CLI. Default: "codex" */
  cliPath?: string;
  /** Pass --full-auto flag to skip interactive approval prompts. Default: true */
  fullAuto?: boolean;
  /** If set, pass --model <model> to the CLI. */
  model?: string;
}

export class OpenAICodexCLIAdapter implements IAdapter {
  readonly adapterType = "openai_codex_cli";
  readonly capabilities = ["execute_code", "read_files", "write_files", "run_commands"] as const;

  private readonly cliPath: string;
  private readonly fullAuto: boolean;
  private readonly model: string | undefined;

  constructor(config: OpenAICodexCLIAdapterConfig = {}) {
    this.cliPath = config.cliPath ?? "codex";
    this.fullAuto = config.fullAuto ?? true;
    this.model = config.model;
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const startedAt = Date.now();

    return new Promise<AgentResult>((resolve) => {
      // Build argument list: exec [--full-auto] [--model <model>] "<prompt>"
      const spawnArgs: string[] = ["exec"];

      if (this.fullAuto) {
        spawnArgs.push("--full-auto");
      }

      if (this.model) {
        spawnArgs.push("--model", this.model);
      }

      // Prompt is passed as a positional argument to the exec subcommand.
      spawnArgs.push(task.prompt);

      const child = spawn(this.cliPath, spawnArgs, {
        stdio: ["pipe", "pipe", "pipe"],
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

      // Close stdin immediately since the prompt is passed as a positional arg.
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
