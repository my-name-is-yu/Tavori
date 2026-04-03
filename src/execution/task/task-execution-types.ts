import { TaskSchema, VerificationResultSchema } from "../../types/task.js";
import type { Task, VerificationResult } from "../../types/task.js";
import type { CapabilityAcquisitionTask } from "../../types/capability.js";

/**
 * Result produced by one full task cycle (generate → approve → execute → verify).
 * Defined here (not in task-lifecycle.ts) to break the circular dependency between
 * task-lifecycle.ts and task-approval.ts.
 */
export interface TaskCycleResult {
  task: Task;
  verificationResult: VerificationResult;
  action: "completed" | "keep" | "discard" | "escalate" | "approval_denied" | "capability_acquiring";
  acquisition_task?: CapabilityAcquisitionTask;
}

/**
 * Creates a synthetic TaskCycleResult for a skipped (duplicate-detected) task.
 */
export function createSkippedTaskResult(goalId: string, targetDimension: string): TaskCycleResult {
  const skippedTask = TaskSchema.parse({ id: "skipped", goal_id: goalId, target_dimensions: [], primary_dimension: targetDimension, work_description: "skipped (duplicate)", rationale: "", approach: "", success_criteria: [], scope_boundary: { in_scope: [], out_of_scope: [], blast_radius: "" }, constraints: [], created_at: new Date().toISOString() });
  const skippedVerification = VerificationResultSchema.parse({ task_id: "skipped", verdict: "fail", confidence: 0, evidence: [], dimension_updates: [], timestamp: new Date().toISOString() });
  return { task: skippedTask, verificationResult: skippedVerification, action: "discard" };
}
