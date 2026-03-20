import type { Task } from "../types/task.js";
import type { TrustManager } from "../traits/trust-manager.js";

/**
 * Check whether the task requires human approval and, if so, request it.
 *
 * @returns true if approved or approval not needed; false if approval was denied
 */
export async function checkIrreversibleApproval(
  trustManager: TrustManager,
  approvalFn: (task: Task) => Promise<boolean>,
  task: Task,
  confidence: number = 0.5
): Promise<boolean> {
  const domain = task.task_category;
  const needsApproval = await trustManager.requiresApproval(
    task.reversibility,
    domain,
    confidence,
    task.task_category
  );

  if (!needsApproval) {
    return true;
  }

  return approvalFn(task);
}
