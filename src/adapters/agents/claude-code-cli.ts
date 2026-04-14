// ─── ClaudeCodeCLIAdapter ───
//
// IAdapter implementation that spawns the `claude` CLI process.
// The task prompt is passed via stdin and the --print flag is used
// for non-interactive (print-mode) execution.
//
// Verified flags (claude CLI, 2026-03):
//   -p / --print  — non-interactive print mode; prints response and exits.
//                   Workspace trust dialog is skipped in this mode.
//                   Prompt can be supplied as a positional argument or via stdin.
//   --dangerously-skip-permissions — bypasses all permission checks (use in sandboxes only)
// If the CLI signature changes, update the spawnArgs array below.

import type { IAdapter, AgentTask, AgentResult } from "../../orchestrator/execution/adapter-layer.js";
import { spawnWithTimeout, spawnResultToAgentResult } from "../spawn-helper.js";
import { wrapTerminalCommand, type TerminalBackendConfig } from "../../runtime/terminal/backend.js";

export interface ClaudeCodeCLIAdapterConfig {
  cliPath?: string;
  workDir?: string;
  terminalBackend?: TerminalBackendConfig;
}

export class ClaudeCodeCLIAdapter implements IAdapter {
  readonly adapterType = "claude_code_cli";
  readonly capabilities = ["execute_code", "read_files", "write_files", "run_commands"] as const;

  /**
   * The executable name / path for the claude CLI.
   * Override in tests to point at a different binary (e.g. "echo").
   */
  private readonly cliPath: string;
  private readonly workDir: string | undefined;
  private readonly terminalBackend: TerminalBackendConfig | undefined;

  constructor(cliPathOrConfig: string | ClaudeCodeCLIAdapterConfig = "claude", workDir?: string) {
    if (typeof cliPathOrConfig === "string") {
      this.cliPath = cliPathOrConfig;
      this.workDir = workDir;
      this.terminalBackend = undefined;
    } else {
      this.cliPath = cliPathOrConfig.cliPath ?? "claude";
      this.workDir = cliPathOrConfig.workDir;
      this.terminalBackend = cliPathOrConfig.terminalBackend;
    }
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const startedAt = Date.now();

    // --print (-p): verified non-interactive flag; prints response and exits.
    // Prompt is written to stdin; the CLI reads it when running in pipe mode.
    const spawnArgs: string[] = ["--print"];

    // Pass allowed_tools via --allowedTools flag if specified.
    // This preserves prompt cache integrity by ensuring tool list is immutable
    // per session (toolset immutability constraint).
    if (task.allowed_tools && task.allowed_tools.length > 0) {
      spawnArgs.push("--allowedTools", task.allowed_tools.join(","));
    }

    // Per-task cwd override (from workspace_path: constraint) takes priority over constructor workDir.
    const cwd = task.cwd ?? this.workDir;
    const command = wrapTerminalCommand(
      {
        command: this.cliPath,
        args: spawnArgs,
        cwd,
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
