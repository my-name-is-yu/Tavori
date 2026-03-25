/**
 * checkpoint-manager-loop.ts
 *
 * Loop-level checkpoint save/restore for crash recovery (§4.8).
 *
 * NOTE: This is distinct from CheckpointManager in src/execution/checkpoint-manager.ts,
 * which handles multi-agent session transfer. This module handles dimension value and
 * trust balance snapshots for crash recovery within a single run.
 */

import type { StateManager } from "../state-manager.js";
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
 * Non-fatal: restore failures do not abort the run.
 */
export async function restoreLoopCheckpoint(
  stateManager: StateManager,
  goalId: string,
  adapterType: string,
  trustManager: TrustManager | undefined
): Promise<void> {
  try {
    const checkpoint = await stateManager.readRaw(`goals/${goalId}/checkpoint.json`);
    if (
      checkpoint &&
      typeof checkpoint === "object" &&
      typeof (checkpoint as Record<string, unknown>).cycle_number === "number"
    ) {
      const cp = checkpoint as {
        cycle_number: number;
        last_verified_task_id?: string;
        dimension_snapshot?: Record<string, number>;
        trust_snapshot?: number;
        timestamp?: string;
      };
      // Restore dimension values from snapshot
      if (cp.dimension_snapshot && typeof cp.dimension_snapshot === "object") {
        const goalData = await stateManager.readRaw(`goals/${goalId}/goal.json`);
        if (goalData && typeof goalData === "object") {
          const goalObj = goalData as Record<string, unknown>;
          const dims = goalObj.dimensions as Array<Record<string, unknown>> | undefined;
          if (dims) {
            for (const dim of dims) {
              const snapshotVal = cp.dimension_snapshot[String(dim.name)];
              if (typeof snapshotVal === "number") {
                dim.current_value = snapshotVal;
              }
            }
            await stateManager.writeRaw(`goals/${goalId}/goal.json`, goalObj);
          }
        }
      }
      // Restore trust balance for the adapter domain from snapshot
      if (typeof cp.trust_snapshot === "number" && trustManager) {
        try {
          await trustManager.setOverride(
            adapterType,
            cp.trust_snapshot,
            "checkpoint_restore"
          );
        } catch {
          // Non-fatal — trust restore failure should not abort the run
        }
      }
    }
  } catch {
    // Checkpoint restore failure is non-fatal — start from beginning
  }
}
