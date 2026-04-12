import { describe, expect, it } from "vitest";
import type { Task } from "../../../../base/types/task.js";
import { isTaskRelevantVerificationCommand } from "../task-agent-loop-verification.js";

function makeTask(verificationMethod: string): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "test task",
    rationale: "why",
    approach: "how",
    success_criteria: [{ description: "done", verification_method: verificationMethod, is_blocking: true }],
    scope_boundary: { in_scope: ["."], out_of_scope: [], blast_radius: "low" },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 1, unit: "hours" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
  };
}

describe("isTaskRelevantVerificationCommand", () => {
  it("matches verification commands to blocking mechanical criteria", () => {
    const task = makeTask("npx vitest run src/foo.test.ts");
    expect(isTaskRelevantVerificationCommand(task, {
      toolName: "shell_command",
      command: "npx vitest run src/foo.test.ts",
      cwd: process.cwd(),
      success: true,
      category: "verification",
      evidenceEligible: true,
      relevantToTask: true,
      outputSummary: "ok",
      durationMs: 1,
    })).toBe(true);

    expect(isTaskRelevantVerificationCommand(task, {
      toolName: "shell_command",
      command: "npx tsc --noEmit",
      cwd: process.cwd(),
      success: true,
      category: "verification",
      evidenceEligible: true,
      relevantToTask: true,
      outputSummary: "ok",
      durationMs: 1,
    })).toBe(false);
  });

  it("falls back to any evidence-eligible verification command when criteria are non-mechanical", () => {
    const task = makeTask("Manual review");
    expect(isTaskRelevantVerificationCommand(task, {
      toolName: "verify",
      command: "test -f src/foo.ts",
      cwd: process.cwd(),
      success: true,
      category: "verification",
      evidenceEligible: true,
      relevantToTask: true,
      outputSummary: "ok",
      durationMs: 1,
    })).toBe(true);
  });
});
