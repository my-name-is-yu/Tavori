import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonFileAtomic, readJsonFileOrNull } from "../base/utils/json-io.js";

export interface LeaderLockRecord {
  owner_token: string;
  pid: number;
  acquired_at: number;
  last_renewed_at: number;
  lease_until: number;
}

export interface LeaderLockAcquireOptions {
  ownerToken?: string;
  leaseMs?: number;
  now?: number;
}

export interface LeaderLockRenewOptions {
  leaseMs?: number;
  now?: number;
}

const DEFAULT_LEASE_MS = 30_000;
const MUTEX_RETRY_DELAY_MS = 10;
const MUTEX_MAX_ATTEMPTS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function writeMutexPid(mutexDir: string): Promise<void> {
  await fsp.writeFile(path.join(mutexDir, "pid"), String(process.pid), "utf-8");
}

async function clearStaleMutex(mutexDir: string): Promise<boolean> {
  try {
    const pidText = await fsp.readFile(path.join(mutexDir, "pid"), "utf-8");
    const pid = Number.parseInt(pidText.trim(), 10);
    if (!Number.isFinite(pid) || !(await isProcessAlive(pid))) {
      await fsp.rm(mutexDir, { recursive: true, force: true });
      return true;
    }
  } catch {
    await fsp.rm(mutexDir, { recursive: true, force: true });
    return true;
  }

  return false;
}

async function acquireMutex(mutexDir: string): Promise<void> {
  await ensureDir(path.dirname(mutexDir));

  for (let attempt = 0; attempt < MUTEX_MAX_ATTEMPTS; attempt++) {
    try {
      await fsp.mkdir(mutexDir);
      await writeMutexPid(mutexDir);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }

      if (!(await clearStaleMutex(mutexDir))) {
        await sleep(MUTEX_RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(`Timed out waiting for mutex: ${mutexDir}`);
}

async function releaseMutex(mutexDir: string): Promise<void> {
  await fsp.rm(mutexDir, { recursive: true, force: true });
}

async function withMutex<T>(mutexDir: string, fn: () => Promise<T>): Promise<T> {
  await acquireMutex(mutexDir);
  try {
    return await fn();
  } finally {
    await releaseMutex(mutexDir);
  }
}

function isLeaderLockRecord(value: unknown): value is LeaderLockRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LeaderLockRecord>;
  return (
    typeof record.owner_token === "string" &&
    typeof record.pid === "number" &&
    typeof record.acquired_at === "number" &&
    typeof record.last_renewed_at === "number" &&
    typeof record.lease_until === "number"
  );
}

export class LeaderLockManager {
  private readonly recordPath: string;
  private readonly mutexPath: string;
  private readonly defaultLeaseMs: number;

  constructor(runtimeRoot: string, defaultLeaseMs = DEFAULT_LEASE_MS) {
    runtimeRoot = path.resolve(runtimeRoot);
    this.recordPath = path.join(runtimeRoot, "leader", "leader.json");
    this.mutexPath = `${this.recordPath}.lock`;
    this.defaultLeaseMs = defaultLeaseMs;
  }

  private buildRecord(ownerToken: string, leaseMs: number, now: number): LeaderLockRecord {
    return {
      owner_token: ownerToken,
      pid: process.pid,
      acquired_at: now,
      last_renewed_at: now,
      lease_until: now + leaseMs,
    };
  }

  private async readRaw(): Promise<LeaderLockRecord | null> {
    const raw = await readJsonFileOrNull<unknown>(this.recordPath);
    return isLeaderLockRecord(raw) ? raw : null;
  }

  async acquire(opts: LeaderLockAcquireOptions = {}): Promise<LeaderLockRecord | null> {
    const now = opts.now ?? Date.now();
    const leaseMs = opts.leaseMs ?? this.defaultLeaseMs;
    const ownerToken = opts.ownerToken ?? randomUUID();

    return withMutex(this.mutexPath, async () => {
      const current = await this.readRaw();
      const currentOwnerAlive = current ? await isProcessAlive(current.pid) : false;
      if (current && current.lease_until > now && currentOwnerAlive) {
        return null;
      }

      const record = this.buildRecord(ownerToken, leaseMs, now);
      await writeJsonFileAtomic(this.recordPath, record);
      return record;
    });
  }

  async renew(ownerToken: string, opts: LeaderLockRenewOptions = {}): Promise<LeaderLockRecord | null> {
    const now = opts.now ?? Date.now();
    const leaseMs = opts.leaseMs ?? this.defaultLeaseMs;

    return withMutex(this.mutexPath, async () => {
      const current = await this.readRaw();
      if (!current || current.owner_token !== ownerToken || current.lease_until <= now) {
        return null;
      }

      const renewed: LeaderLockRecord = {
        ...current,
        last_renewed_at: now,
        lease_until: now + leaseMs,
      };
      await writeJsonFileAtomic(this.recordPath, renewed);
      return renewed;
    });
  }

  async release(ownerToken: string): Promise<boolean> {
    return withMutex(this.mutexPath, async () => {
      const current = await this.readRaw();
      if (!current || current.owner_token !== ownerToken) {
        return false;
      }

      await fsp.rm(this.recordPath, { force: true });
      return true;
    });
  }

  async read(): Promise<LeaderLockRecord | null> {
    return this.readRaw();
  }

  async reapStale(now = Date.now()): Promise<LeaderLockRecord | null> {
    return withMutex(this.mutexPath, async () => {
      const current = await this.readRaw();
      if (!current || current.lease_until > now) {
        return null;
      }

      await fsp.rm(this.recordPath, { force: true });
      return current;
    });
  }
}
