import { randomUUID } from "node:crypto";
import type { Task } from "../../orchestrator/execution/types/task.js";

export function isBashModeInput(input: string): boolean {
  return input.trimStart().startsWith("!");
}

export function extractBashCommand(input: string): string | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("!")) return null;
  return trimmed.slice(1).trim();
}

export function isSafeBashCommand(command: string): boolean {
  const SAFE_PATTERNS = [
    /^(cat|head|tail|wc|ls|pwd|echo|date|hostname|which|type|file)/,
    /^git\s+(status|log|diff|show|branch|rev-parse|rev-list|describe|tag\s+-l)/,
    /^npm\s+(ls|list|view|info|outdated|audit)/,
    /^npx\s+vitest\s+(run|list|--reporter)/,
    /^npx\s+tsc\s+--noEmit/,
    /^rg\s/, /^find\s/, /^du\s/, /^df\s/, /^tree\s/,
  ];
  return SAFE_PATTERNS.some((pattern) => pattern.test(command.trim()));
}

export function createShellApprovalTask(command: string, cwd: string, reason?: string): Task {
  const now = new Date().toISOString();
  return {
    id: `shell-${randomUUID()}`,
    goal_id: "shell-mode",
    strategy_id: null,
    target_dimensions: [],
    primary_dimension: "shell",
    work_description: `Run shell command: ${command}`,
    rationale: reason ?? `User requested direct shell execution in Pulseed TUI from ${cwd}.`,
    approach: "Execute via the built-in shell tool using the existing approval flow.",
    success_criteria: [],
    scope_boundary: {
      in_scope: [`Execute: ${command}`],
      out_of_scope: ["Any unrelated changes"],
      blast_radius: cwd,
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "unknown",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: now,
  };
}

export function formatShellOutput(command: string, output: { stdout: string; stderr: string; exitCode: number }): string {
  const parts: string[] = [`$ ${command}`];
  if (output.stdout.trim()) {
    parts.push(output.stdout.trimEnd());
  }
  if (output.stderr.trim()) {
    parts.push(output.stderr.trimEnd());
  }
  parts.push(`(exit ${output.exitCode})`);
  return "```bash\n" + parts.join("\n") + "\n```";
}
