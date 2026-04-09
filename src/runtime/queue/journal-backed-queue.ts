import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Envelope, EnvelopePriority } from '../types/envelope.js';

export interface JournalBackedQueueOptions {
  journalPath: string;
  defaultLeaseMs?: number;
  maxAttempts?: number;
  now?: () => number;
}

export type JournalBackedQueueClaimFilter = (envelope: Envelope) => boolean;

export interface JournalBackedQueueAcceptResult {
  accepted: boolean;
  duplicate: boolean;
  messageId: string;
}

export interface JournalBackedQueueClaim {
  claimToken: string;
  messageId: string;
  workerId: string;
  leaseUntil: number;
  attempt: number;
  envelope: Envelope;
}

export interface JournalBackedQueueSweepResult {
  reclaimed: number;
  deadlettered: number;
  expiredClaimTokens: string[];
}

export interface JournalBackedQueueSnapshot {
  pending: Record<EnvelopePriority, string[]>;
  inflight: Record<string, JournalBackedQueueClaimRecord>;
  completed: string[];
  deadletter: string[];
}

export interface JournalBackedQueueRecord {
  envelope: Envelope;
  status: 'pending' | 'inflight' | 'completed' | 'deadletter';
  attempt: number;
  createdAt: number;
  updatedAt: number;
  workerId?: string;
  claimToken?: string;
  leaseUntil?: number;
  deadletterReason?: string;
  completedAt?: number;
}

export interface JournalBackedQueueClaimRecord {
  messageId: string;
  workerId: string;
  leaseUntil: number;
  attempt: number;
  claimedAt: number;
}

interface JournalBackedQueueState {
  version: 1;
  records: Record<string, JournalBackedQueueRecord>;
  pending: Record<EnvelopePriority, string[]>;
  inflight: Record<string, JournalBackedQueueClaimRecord>;
}

const PRIORITY_ORDER: EnvelopePriority[] = ['critical', 'high', 'normal', 'low'];
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 10_000;

function emptyPending(): Record<EnvelopePriority, string[]> {
  return {
    critical: [],
    high: [],
    normal: [],
    low: [],
  };
}

function clonePending(pending: Record<EnvelopePriority, string[]>): Record<EnvelopePriority, string[]> {
  return {
    critical: [...pending.critical],
    high: [...pending.high],
    normal: [...pending.normal],
    low: [...pending.low],
  };
}

function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failures.
    }
    throw err;
  }
}

function readJsonOrNull<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function sleepMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface JournalLockHandle {
  release(): void;
}

function acquireJournalLock(lockPath: string): JournalLockHandle {
  const ownerPath = path.join(lockPath, 'owner.json');
  const ownerId = randomUUID();
  const startedAt = Date.now();

  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      atomicWriteJson(ownerPath, {
        ownerId,
        pid: process.pid,
        acquiredAt: startedAt,
      });
      return {
        release: () => {
          try {
            fs.rmSync(lockPath, { recursive: true, force: true });
          } catch {
            // Ignore lock cleanup failures.
          }
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      const owner = readJsonOrNull<{ acquiredAt?: number }>(ownerPath);
      if (owner?.acquiredAt === undefined || Date.now() - owner.acquiredAt > LOCK_STALE_MS) {
        try {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        } catch {
          // Another process may have won the race. Fall through to retry.
        }
      }

      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring journal lock at ${lockPath}`);
      }

      sleepMs(LOCK_WAIT_MS);
    }
  }
}

function isExpired(envelope: Envelope, now: number): boolean {
  const ttl = envelope.ttl_ms ?? 300_000;
  return envelope.created_at + ttl <= now;
}

function buildEmptyState(): JournalBackedQueueState {
  return {
    version: 1,
    records: {},
    pending: emptyPending(),
    inflight: {},
  };
}

function normalizeState(state: JournalBackedQueueState): JournalBackedQueueState {
  const normalized = buildEmptyState();
  normalized.version = 1;
  normalized.records = {};

  for (const [messageId, record] of Object.entries(state.records ?? {})) {
    if (!record?.envelope?.id) continue;
    normalized.records[messageId] = { ...record };
  }

  normalized.pending = emptyPending();
  for (const priority of PRIORITY_ORDER) {
    const ids = state.pending?.[priority] ?? [];
    for (const messageId of ids) {
      const record = normalized.records[messageId];
      if (!record || record.status !== 'pending') continue;
      normalized.pending[priority].push(messageId);
    }
  }

  normalized.inflight = {};
  for (const [claimToken, claim] of Object.entries(state.inflight ?? {})) {
    const record = normalized.records[claim.messageId];
    if (!record || record.status !== 'inflight' || record.claimToken !== claimToken) continue;
    normalized.inflight[claimToken] = { ...claim };
  }

  for (const [messageId, record] of Object.entries(normalized.records)) {
    if (record.status === 'pending') {
      const priority = record.envelope.priority;
      if (!normalized.pending[priority].includes(messageId)) {
        normalized.pending[priority].push(messageId);
      }
    }
    if (record.status === 'inflight' && record.claimToken) {
      normalized.inflight[record.claimToken] = {
        messageId,
        workerId: record.workerId ?? '',
        leaseUntil: record.leaseUntil ?? 0,
        attempt: record.attempt,
        claimedAt: record.updatedAt,
      };
    }
  }

  return normalized;
}

export class JournalBackedQueue {
  private readonly journalPath: string;
  private readonly lockPath: string;
  private readonly defaultLeaseMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private state: JournalBackedQueueState;

  constructor(options: JournalBackedQueueOptions) {
    this.journalPath = options.journalPath;
    this.lockPath = `${options.journalPath}.lock`;
    this.defaultLeaseMs = options.defaultLeaseMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.now = options.now ?? Date.now;
    this.state = this.loadFromDisk();
  }

  accept(envelope: Envelope): JournalBackedQueueAcceptResult {
    return this.withLockedState<JournalBackedQueueAcceptResult>((state) => {
      const existing = state.records[envelope.id];
      if (existing) {
        return {
          result: { accepted: false, duplicate: true, messageId: envelope.id },
          dirty: false,
        };
      }

      if (isExpired(envelope, this.now())) {
        return {
          result: { accepted: false, duplicate: false, messageId: envelope.id },
          dirty: false,
        };
      }

      if (envelope.dedupe_key) {
        const activeDedupeRecords = Object.entries(state.records).filter(([, record]) => {
          return (
            record.envelope.dedupe_key === envelope.dedupe_key &&
            record.status !== 'completed' &&
            record.status !== 'deadletter'
          );
        });

        const inflightMatch = activeDedupeRecords.find(([, record]) => record.status === 'inflight');
        if (inflightMatch) {
          return {
            result: {
              accepted: false,
              duplicate: true,
              messageId: inflightMatch[0],
            },
            dirty: false,
          };
        }

        for (const [messageId] of activeDedupeRecords) {
          delete state.records[messageId];
          this.removePending(state, messageId);
        }
      }

      state.records[envelope.id] = {
        envelope,
        status: 'pending',
        attempt: 0,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      state.pending[envelope.priority].push(envelope.id);
      return {
        result: { accepted: true, duplicate: false, messageId: envelope.id },
        dirty: true,
      };
    });
  }

  claim(
    workerId: string,
    leaseMs = this.defaultLeaseMs,
    filter?: JournalBackedQueueClaimFilter
  ): JournalBackedQueueClaim | null {
    return this.withLockedState((state) => {
      let dirty = false;
      for (const priority of PRIORITY_ORDER) {
        const bucket = state.pending[priority];
        let index = 0;
        while (index < bucket.length) {
          const messageId = bucket[index];
          const record = state.records[messageId];
          if (!record || record.status !== 'pending') {
            bucket.splice(index, 1);
            dirty = true;
            continue;
          }
          if (isExpired(record.envelope, this.now())) {
            bucket.splice(index, 1);
            record.status = 'deadletter';
            record.deadletterReason = 'expired before claim';
            record.updatedAt = this.now();
            dirty = true;
            continue;
          }
          if (filter && !filter(record.envelope)) {
            index += 1;
            continue;
          }

          const claimToken = randomUUID();
          const attempt = record.attempt + 1;
          const leaseUntil = this.now() + leaseMs;
          bucket.splice(index, 1);
          record.status = 'inflight';
          record.attempt = attempt;
          record.workerId = workerId;
          record.claimToken = claimToken;
          record.leaseUntil = leaseUntil;
          record.updatedAt = this.now();

          state.inflight[claimToken] = {
            messageId,
            workerId,
            leaseUntil,
            attempt,
            claimedAt: this.now(),
          };
          return {
            result: {
              claimToken,
              messageId,
              workerId,
              leaseUntil,
              attempt,
              envelope: record.envelope,
            },
            dirty: true,
          };
        }
      }

      return { result: null, dirty };
    });
  }

  renew(claimToken: string, leaseMs = this.defaultLeaseMs): JournalBackedQueueClaim | null {
    return this.withLockedState((state) => {
      const claim = state.inflight[claimToken];
      if (!claim) return { result: null, dirty: false };

      const record = state.records[claim.messageId];
      if (!record || record.status !== 'inflight' || record.claimToken !== claimToken) {
        delete state.inflight[claimToken];
        return { result: null, dirty: true };
      }

      if (this.isLeaseExpired(record, claimToken)) {
        return { result: null, dirty: false };
      }

      const leaseUntil = this.now() + leaseMs;
      claim.leaseUntil = leaseUntil;
      claim.claimedAt = this.now();
      record.leaseUntil = leaseUntil;
      record.updatedAt = this.now();
      return {
        result: {
          claimToken,
          messageId: claim.messageId,
          workerId: claim.workerId,
          leaseUntil,
          attempt: claim.attempt,
          envelope: record.envelope,
        },
        dirty: true,
      };
    });
  }

  ack(claimToken: string): boolean {
    return this.withLockedState((state) => {
      const claim = state.inflight[claimToken];
      if (!claim) return { result: false, dirty: false };

      const record = state.records[claim.messageId];
      if (!record || record.status !== 'inflight' || record.claimToken !== claimToken) {
        return { result: false, dirty: false };
      }

      if (this.isLeaseExpired(record, claimToken)) {
        return { result: false, dirty: false };
      }

      record.status = 'completed';
      record.completedAt = this.now();
      record.updatedAt = this.now();
      delete record.workerId;
      delete record.claimToken;
      delete record.leaseUntil;
      delete state.inflight[claimToken];
      return { result: true, dirty: true };
    });
  }

  nack(claimToken: string, reason: string, requeue = true): boolean {
    return this.withLockedState((state) => {
      const claim = state.inflight[claimToken];
      if (!claim) return { result: false, dirty: false };

      const record = state.records[claim.messageId];
      if (!record || record.status !== 'inflight' || record.claimToken !== claimToken) {
        return { result: false, dirty: false };
      }

      if (this.isLeaseExpired(record, claimToken)) {
        return { result: false, dirty: false };
      }

      delete state.inflight[claimToken];
      delete record.workerId;
      delete record.claimToken;
      delete record.leaseUntil;
      record.updatedAt = this.now();
      if (!requeue || record.attempt >= this.maxAttempts) {
        record.status = 'deadletter';
        record.deadletterReason = reason;
        return { result: true, dirty: true };
      }

      record.status = 'pending';
      state.pending[record.envelope.priority].push(record.envelope.id);
      return { result: true, dirty: true };
    });
  }

  requeue(messageId: string): boolean {
    return this.withLockedState((state) => {
      const record = state.records[messageId];
      if (!record) return { result: false, dirty: false };
      if (record.status === 'completed') return { result: false, dirty: false };
      if (record.status === 'pending') return { result: true, dirty: false };

      if (record.status === 'inflight' && record.claimToken) {
        delete state.inflight[record.claimToken];
      }

      delete record.workerId;
      delete record.claimToken;
      delete record.leaseUntil;
      delete record.deadletterReason;
      record.status = 'pending';
      record.updatedAt = this.now();
      state.pending[record.envelope.priority].push(messageId);
      return { result: true, dirty: true };
    });
  }

  deadletter(messageId: string, reason: string): boolean {
    return this.withLockedState((state) => {
      const record = state.records[messageId];
      if (!record) return { result: false, dirty: false };

      if (record.status === 'inflight' && record.claimToken) {
        delete state.inflight[record.claimToken];
      }

      this.removePending(state, messageId);
      delete record.workerId;
      delete record.claimToken;
      delete record.leaseUntil;
      record.status = 'deadletter';
      record.deadletterReason = reason;
      record.updatedAt = this.now();
      return { result: true, dirty: true };
    });
  }

  sweepExpiredClaims(now = this.now()): JournalBackedQueueSweepResult {
    return this.withLockedState((state) => {
      const expiredClaimTokens: string[] = [];
      let reclaimed = 0;
      let deadlettered = 0;

      for (const [claimToken, claim] of Object.entries({ ...state.inflight })) {
        if (claim.leaseUntil > now) continue;
        const record = state.records[claim.messageId];
        expiredClaimTokens.push(claimToken);
        delete state.inflight[claimToken];

        if (!record || record.status !== 'inflight' || record.claimToken !== claimToken) {
          continue;
        }

        delete record.workerId;
        delete record.claimToken;
        delete record.leaseUntil;
        record.updatedAt = now;

        if (record.attempt >= this.maxAttempts) {
          record.status = 'deadletter';
          record.deadletterReason = 'lease expired';
          deadlettered += 1;
          continue;
        }

        record.status = 'pending';
        state.pending[record.envelope.priority].push(record.envelope.id);
        reclaimed += 1;
      }

      return {
        result: { reclaimed, deadlettered, expiredClaimTokens },
        dirty: expiredClaimTokens.length > 0,
      };
    });
  }

  snapshot(): JournalBackedQueueSnapshot {
    this.refresh();
    const completed: string[] = [];
    const deadletter: string[] = [];
    for (const record of Object.values(this.state.records)) {
      if (record.status === 'completed') completed.push(record.envelope.id);
      if (record.status === 'deadletter') deadletter.push(record.envelope.id);
    }

    return {
      pending: clonePending(this.state.pending),
      inflight: { ...this.state.inflight },
      completed,
      deadletter,
    };
  }

  get(messageId: string): JournalBackedQueueRecord | undefined {
    this.refresh();
    return this.state.records[messageId] ? { ...this.state.records[messageId] } : undefined;
  }

  size(): number {
    this.refresh();
    return PRIORITY_ORDER.reduce((total, priority) => total + this.state.pending[priority].length, 0);
  }

  inflightSize(): number {
    this.refresh();
    return Object.keys(this.state.inflight).length;
  }

  private load(): JournalBackedQueueState {
    const raw = readJsonOrNull<JournalBackedQueueState>(this.journalPath);
    if (!raw || raw.version !== 1) {
      return buildEmptyState();
    }
    return normalizeState(raw);
  }

  private loadFromDisk(): JournalBackedQueueState {
    return this.load();
  }

  private refresh(): void {
    this.state = this.loadFromDisk();
  }

  private persist(state: JournalBackedQueueState): void {
    atomicWriteJson(this.journalPath, state);
  }

  private withLockedState<T>(mutator: (state: JournalBackedQueueState) => { result: T; dirty: boolean }): T {
    const lock = acquireJournalLock(this.lockPath);
    try {
      const state = this.loadFromDisk();
      const { result, dirty } = mutator(state);
      if (dirty) {
        this.persist(state);
      }
      this.state = state;
      return result;
    } finally {
      lock.release();
    }
  }

  private isLeaseExpired(record: JournalBackedQueueRecord, claimToken: string): boolean {
    return record.claimToken === claimToken && (record.leaseUntil ?? 0) <= this.now();
  }

  private removePending(state: JournalBackedQueueState, messageId: string): void {
    for (const priority of PRIORITY_ORDER) {
      const bucket = state.pending[priority];
      const index = bucket.indexOf(messageId);
      if (index >= 0) {
        bucket.splice(index, 1);
        return;
      }
    }
  }
}
