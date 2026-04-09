import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Logger } from "../../runtime/logger.js";
import { atomicWrite } from "./state-persistence.js";
import { replayWAL } from "./state-wal.js";
import type { WALIntent } from "./state-wal.js";

export interface StateManagerWALRecoveryOptions {
  baseDir: string;
  logger?: Logger;
  listGoalIds: () => Promise<string[]>;
}

export async function recoverStateManagerWAL(
  options: StateManagerWALRecoveryOptions,
): Promise<void> {
  const { baseDir, logger, listGoalIds } = options;
  let goalIds: string[];
  try {
    goalIds = await listGoalIds();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  for (const goalId of goalIds) {
    const replayed = await replayWAL(goalId, baseDir, async (intent) => {
      await replayStateManagerIntent(baseDir, intent, logger);
    });
    if (replayed > 0) {
      logger?.info(`[StateManager] Replayed ${replayed} WAL entries for goal ${goalId}`);
    }
  }
}

/** Map a WAL intent op back to the appropriate file write. */
export async function replayStateManagerIntent(
  baseDir: string,
  intent: WALIntent,
  logger?: Logger,
): Promise<void> {
  const data = intent.data as Record<string, unknown>;
  switch (intent.op) {
    case "save_goal": {
      const goalId = data?.id as string;
      if (goalId) {
        const dir = path.join(baseDir, "goals", goalId);
        await fsp.mkdir(dir, { recursive: true });
        await atomicWrite(path.join(dir, "goal.json"), data);
      }
      break;
    }
    case "save_observation": {
      const goalId = data?.goal_id as string;
      if (goalId) {
        const dir = path.join(baseDir, "goals", goalId);
        await fsp.mkdir(dir, { recursive: true });
        await atomicWrite(path.join(dir, "observations.json"), data);
      }
      break;
    }
    case "append_observation": {
      const goalId = data?.goal_id as string;
      if (goalId) {
        const dir = path.join(baseDir, "goals", goalId);
        await fsp.mkdir(dir, { recursive: true });
        await atomicWrite(path.join(dir, "observations.json"), data);
      }
      break;
    }
    case "save_gap_history":
    case "append_gap_entry": {
      const goalId = data?.goalId as string;
      if (goalId) {
        const dir = path.join(baseDir, "goals", goalId);
        await fsp.mkdir(dir, { recursive: true });
        await atomicWrite(path.join(dir, "gap-history.json"), data?.entries ?? data);
      }
      break;
    }
    case "save_pace_snapshot": {
      const goalId = data?.id as string;
      if (goalId) {
        const dir = path.join(baseDir, "goals", goalId);
        await fsp.mkdir(dir, { recursive: true });
        await atomicWrite(path.join(dir, "goal.json"), data);
      }
      break;
    }
    case "write_raw": {
      const relativePath = data?.path as string;
      const payload = data?.payload;
      if (relativePath && payload !== undefined) {
        const resolved = path.resolve(baseDir, relativePath);
        await fsp.mkdir(path.dirname(resolved), { recursive: true });
        await atomicWrite(resolved, payload);
      }
      break;
    }
    default:
      logger?.warn(`[StateManager] Unknown WAL intent op: ${intent.op}`);
  }
}
