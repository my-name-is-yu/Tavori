/**
 * checkpoint-manager-loop.ts
 *
 * Loop-level checkpoint save/restore for crash recovery (§4.8).
 *
 * NOTE: This is distinct from CheckpointManager in src/execution/checkpoint-manager.ts,
 * which handles multi-agent session transfer. This module handles dimension value and
 * trust balance snapshots for crash recovery within a single run.
 */

import type { StateManager } from "../state/state-manager.js";
import type { TrustManager } from "../traits/trust-manager.js";
import type { LoopIterationResult } from "./core-loop-types.js";
import type { Logger } from "../runtime/logger.js";

/**
 * Save a checkpoint after a successful verify step.
 * Records dimension values, trust balance, and cycle number.
 * Non-fatal: checkpoint save failures do not abort the run.
 */
export async function saveLoopCheckpoint(
  stateManager: StateManager,
  goalId: string,
  loopIndex: number,
  iterationResult: LoopIterationResult,
  adapterType: string,
  trustManager: TrustManager | undefined,
  logger: Logger | undefined
): Promise<void> {
  try {
    const currentGoalForCp = await stateManager.readRaw(`goals/${goalId}/goal.json`);
    const dimensionSnapshot: Record<string, number> = {};
    if (currentGoalForCp && typeof currentGoalForCp === "object") {
      const dims = (currentGoalForCp as Record<string, unknown>).dimensions as
        | Array<Record<string, unknown>>
        | undefined;
      if (dims) {
        for (const dim of dims) {
          if (typeof dim.name === "string" && typeof dim.current_value === "number") {
            dimensionSnapshot[dim.name] = dim.current_value;
          }
        }
      }
    }
    let trustSnapshot: number | undefined;
    if (trustManager) {
      try {
        const trustBalance = await trustManager.getBalance(adapterType);
        trustSnapshot = trustBalance.balance;
      } catch {
        // Non-fatal
      }
    }
    await stateManager.writeRaw(`goals/${goalId}/checkpoint.json`, {
      cycle_number: loopIndex + 1,
      last_verified_task_id: iterationResult.taskResult?.task.id,
      dimension_snapshot: dimensionSnapshot,
      trust_snapshot: trustSnapshot,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Checkpoint save failure is non-fatal
    logger?.warn("saveLoopCheckpoint: failed to save checkpoint", { goalId });
  }
}

/**
 * Restore dimension values and trust balance from a checkpoint if one exists.
 * Delegates to StateManager.restoreFromCheckpoint which uses Zod validation.
 * Returns the saved cycle_number so the caller can resume iteration counting,
 * or 0 if no checkpoint exists or restore fails.
 * Non-fatal: restore failures do not abort the run.
 */
export async function restoreLoopCheckpoint(
  stateManager: StateManager,
  goalId: string,
  adapterType: string,
  trustManager: TrustManager | undefined
): Promise<number> {
  return stateManager.restoreFromCheckpoint(goalId, adapterType, trustManager);
}
