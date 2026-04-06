import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * Per-goal advisory locking using lockfiles.
 * Lock path: <baseDir>/goals/<goalId>/.lock/
 * Uses mkdir as atomic primitive (POSIX: EEXIST = lock held).
 */

export interface LockOptions {
  maxRetries?: number;     // default 5
  initialDelayMs?: number; // default 50
  maxTotalMs?: number;     // default 500
}

function lockPath(goalId: string, baseDir: string): string {
  return path.join(baseDir, "goals", goalId, ".lock");
}

function pidFilePath(lockDir: string): string {
  return path.join(lockDir, "pid");
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function tryAcquire(lockDir: string, checkStale = false): Promise<boolean> {
  try {
    await fsp.mkdir(lockDir, { recursive: false });
    await fsp.writeFile(pidFilePath(lockDir), String(process.pid), "utf-8");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      if (checkStale) {
        await clearStaleLock(lockDir);
        // Retry once after clearing stale lock
        try {
          await fsp.mkdir(lockDir, { recursive: false });
          await fsp.writeFile(pidFilePath(lockDir), String(process.pid), "utf-8");
          return true;
        } catch (retryErr) {
          if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") {
            return false;
          }
          throw retryErr;
        }
      }
      return false;
    }
    throw err;
  }
}

async function clearStaleLock(lockDir: string): Promise<void> {
  try {
    const pidStr = await fsp.readFile(pidFilePath(lockDir), "utf-8");
    const pid = parseInt(pidStr.trim(), 10);
    if (!isNaN(pid) && !(await isProcessAlive(pid))) {
      await fsp.rm(lockDir, { recursive: true, force: true });
    }
  } catch {
    // If we cannot read pid, leave the lock intact
  }
}

/** Acquire an advisory lock for the given goalId. Throws if timeout exceeded. */
export async function acquireLock(
  goalId: string,
  baseDir: string,
  opts?: LockOptions
): Promise<void> {
  const maxRetries = opts?.maxRetries ?? 5;
  const initialDelayMs = opts?.initialDelayMs ?? 50;
  const maxTotalMs = opts?.maxTotalMs ?? 500;

  const lockDir = lockPath(goalId, baseDir);

  // Ensure parent dir exists
  await fsp.mkdir(path.dirname(lockDir), { recursive: true });

  const start = Date.now();
  let delay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (await tryAcquire(lockDir, true)) {
      return;
    }

    if (Date.now() - start >= maxTotalMs) {
      throw new Error(`acquireLock: timeout exceeded for goal "${goalId}" after ${maxTotalMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, maxTotalMs);
  }

  throw new Error(`acquireLock: max retries exceeded for goal "${goalId}"`);
}

/** Release the advisory lock for the given goalId. No-op if lock does not exist. */
export async function releaseLock(goalId: string, baseDir: string): Promise<void> {
  const lockDir = lockPath(goalId, baseDir);
  try {
    await fsp.rm(lockDir, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
