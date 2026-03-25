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

import type { IAdapter, AgentTask, AgentResult } from "../execution/adapter-layer.js";
import { spawnWithTimeout, spawnResultToAgentResult } from "./spawn-helper.js";

export class ClaudeCodeCLIAdapter implements IAdapter {
  readonly adapterType = "claude_code_cli";
  readonly capabilities = ["execute_code", "read_files", "write_files", "run_commands"] as const;

  /**
   * The executable name / path for the claude CLI.
   * Override in tests to point at a different binary (e.g. "echo").
   */
  private readonly cliPath: string;
  private readonly workDir: string | undefined;

  constructor(cliPath: string = "claude", workDir?: string) {
    this.cliPath = cliPath;
    this.workDir = workDir;
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

    const result = await spawnWithTimeout(
      this.cliPath,
      spawnArgs,
      { cwd: this.workDir, stdinData: task.prompt },
      task.timeout_ms
    );

    const elapsed = Date.now() - startedAt;
    return spawnResultToAgentResult(result, elapsed, task.timeout_ms);
  }
}
