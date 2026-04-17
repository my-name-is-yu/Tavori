// ─── OpenAICodexCLIAdapter ───
//
// IAdapter implementation that spawns the `codex` CLI process.
// The task prompt is written to stdin (not passed as a CLI arg) to avoid
// exposing sensitive content in `ps aux` output.
// Uses -s workspace-write by default for non-interactive execution.
//
// Usage: echo "PROMPT" | codex exec [-s danger-full-access] [-m <model>]
//
// Verified against codex-cli 0.114.0:
//   - `exec` subcommand runs a single prompt non-interactively
//   - `-s danger-full-access` sets sandbox policy to allow full disk/command access
//   - `-m <model>` selects the model (e.g. "o4-mini", "o3")
//   - When [PROMPT] arg is omitted (or `-` is given), prompt is read from stdin
//   - --skip-git-repo-check allows execution in temporary/synced worktrees that
//     are not in Codex's trusted directory list.

import type { IAdapter, AgentTask, AgentResult } from "../../orchestrator/execution/adapter-layer.js";
import type { Logger } from "../../runtime/logger.js";
import { spawnWithTimeout, spawnResultToAgentResult } from "../spawn-helper.js";
import { wrapTerminalCommand, type TerminalBackendConfig } from "../../runtime/terminal/backend.js";

export interface OpenAICodexCLIAdapterConfig {
  /** The executable name / path for the codex CLI. Default: "codex" */
  cliPath?: string;
  /**
   * Sandbox policy passed via -s flag. Default: "workspace-write" for
   * non-interactive execution. Use "danger-full-access" only as an explicit opt-in.
   * Set to null to omit the flag entirely.
   */
  sandboxPolicy?: string | null;
  /** If set, pass -m <model> to the CLI. */
  model?: string;
  /** Repository path passed to Codex for workspace-aware execution. Default: "." */
  repoPath?: string;
  /** Pass --skip-git-repo-check. Default: true for daemon/test workspaces. */
  skipGitRepoCheck?: boolean;
  /** Optional command backend for local or containerized terminal execution. */
  terminalBackend?: TerminalBackendConfig;
}

export class OpenAICodexCLIAdapter implements IAdapter {
  readonly adapterType = "openai_codex_cli";
  readonly capabilities = ["execute_code", "read_files", "write_files", "run_commands"] as const;

  private readonly cliPath: string;
  private readonly sandboxPolicy: string | null;
  private readonly model: string | undefined;
  private readonly repoPath: string;
  private readonly skipGitRepoCheck: boolean;
  private readonly terminalBackend?: TerminalBackendConfig;
  private readonly logger?: Logger;

  constructor(config: OpenAICodexCLIAdapterConfig = {}, logger?: Logger) {
    this.cliPath = config.cliPath ?? "codex";
    this.sandboxPolicy =
      config.sandboxPolicy !== undefined ? config.sandboxPolicy : "workspace-write";
    this.model = config.model;
    this.repoPath = config.repoPath?.trim() || ".";
    this.skipGitRepoCheck = config.skipGitRepoCheck ?? true;
    this.terminalBackend = config.terminalBackend;
    this.logger = logger;
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const startedAt = Date.now();

    // Build argument list: exec [-s <policy>] [-m <model>]
    // Prompt is written to stdin (not included in args) to prevent ps aux exposure.
    const spawnArgs: string[] = ["exec"];

    if (this.sandboxPolicy) {
      spawnArgs.push("-s", this.sandboxPolicy);
    }

    if (this.model) {
      spawnArgs.push("-m", this.model);
    }

    if (this.skipGitRepoCheck) {
      spawnArgs.push("--skip-git-repo-check");
    }

    // allowed_tools: codex-cli does not have a native tool-restriction flag.
    // Log a warning for observability; toolset constraint is enforced at the
    // PulSeed layer (ToolsetLock) rather than being delegated to the CLI.
    if (task.allowed_tools && task.allowed_tools.length > 0) {
      this.logger?.warn(
        "[OpenAICodexCLIAdapter] allowed_tools is set but codex-cli does not support " +
          "a native tool-restriction flag. Proceeding without restriction.",
        { allowed_tools: task.allowed_tools }
      );
    }

    // NOTE: --path is NOT supported by codex-cli 0.114.0; use cwd instead
    // Per-task cwd override (from workspace_path: constraint) takes priority over constructor repoPath.
    const cwd = task.cwd ?? this.repoPath;
    const command = wrapTerminalCommand(
      {
        command: this.cliPath,
        args: spawnArgs,
        cwd,
        env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
        stdinData: task.system_prompt ? `[System Context]
${task.system_prompt}

[User Request]
${task.prompt}` : task.prompt,
      },
      this.terminalBackend
    );
    const result = await spawnWithTimeout(
      command.command,
      command.args,
      {
        ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
        ...(command.env !== undefined ? { env: command.env } : {}),
        stdinData: command.stdinData,
      },
      task.timeout_ms
    );

    const elapsed = Date.now() - startedAt;
    return spawnResultToAgentResult(result, elapsed, task.timeout_ms);
  }
}
