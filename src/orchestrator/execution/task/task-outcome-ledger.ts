import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { Task, VerificationResult } from "../../../base/types/task.js";

export type TaskOutcomeEventType =
  | "acked"
  | "started"
  | "succeeded"
  | "failed"
  | "retried"
  | "abandoned";

export interface TaskOutcomeEvent {
  type: TaskOutcomeEventType;
  ts: string;
  attempt: number;
  task_status: Task["status"];
  verification_verdict?: VerificationResult["verdict"];
  action?: string;
  reason?: string;
  stopped_reason?: string | null;
  created_at: string | null;
  acked_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  verification_at: string | null;
  elapsed_ms: number | null;
  estimated_duration_ms: number | null;
}

export interface TaskOutcomeSummary {
  task_id: string;
  goal_id: string;
  latest_event_type: TaskOutcomeEventType | null;
  latest_event_at: string | null;
  attempt: number;
  task_status: Task["status"];
  verification_verdict?: VerificationResult["verdict"];
  action?: string;
  created_at: string | null;
  acked_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  verification_at: string | null;
  last_failure_at: string | null;
  abandoned_at: string | null;
  estimated_duration_ms: number | null;
  latencies: {
    created_to_acked_ms: number | null;
    acked_to_started_ms: number | null;
    started_to_completed_ms: number | null;
    completed_to_verification_ms: number | null;
    created_to_completed_ms: number | null;
  };
}

export interface TaskOutcomeLedgerRecord {
  task_id: string;
  goal_id: string;
  events: TaskOutcomeEvent[];
  summary: TaskOutcomeSummary;
}

export interface TaskOutcomeAggregateSummary {
  total_tasks: number;
  terminal_tasks: number;
  succeeded: number;
  failed: number;
  abandoned: number;
  retried: number;
  success_rate: number | null;
  retry_rate: number | null;
  abandoned_rate: number | null;
  p95_created_to_acked_ms: number | null;
  p95_started_to_completed_ms: number | null;
  p95_created_to_completed_ms: number | null;
}

interface AppendTaskOutcomeEventParams {
  task: Task;
  type: TaskOutcomeEventType;
  attempt?: number;
  ts?: string;
  action?: string;
  reason?: string;
  stoppedReason?: string | null;
  verificationResult?: VerificationResult;
  elapsedMs?: number | null;
}

const ledgerPath = (goalId: string, taskId: string): string => `tasks/${goalId}/ledger/${taskId}.json`;

function toMillis(value: string | null | undefined): number | null {
  if (!value) return null;
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

function diffMs(start: string | null | undefined, end: string | null | undefined): number | null {
  const startMs = toMillis(start);
  const endMs = toMillis(end);
  return startMs === null || endMs === null ? null : endMs - startMs;
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? null;
}

function estimateDurationMs(task: Task): number | null {
  if (!task.estimated_duration) return null;
  const multipliers: Record<string, number> = {
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
  };
  return task.estimated_duration.value * (multipliers[task.estimated_duration.unit] ?? 60 * 60 * 1000);
}

function buildEvent(params: AppendTaskOutcomeEventParams): TaskOutcomeEvent {
  const ts = params.ts ?? new Date().toISOString();
  return {
    type: params.type,
    ts,
    attempt: params.attempt ?? Math.max(params.task.consecutive_failure_count, 1),
    task_status: params.task.status,
    verification_verdict: params.verificationResult?.verdict ?? params.task.verification_verdict,
    action: params.action,
    reason: params.reason,
    stopped_reason: params.stoppedReason ?? null,
    created_at: params.task.created_at ?? null,
    acked_at: params.type === "acked" ? ts : null,
    started_at: params.task.started_at ?? null,
    completed_at: params.task.completed_at ?? null,
    verification_at: params.verificationResult?.timestamp ?? null,
    elapsed_ms: params.elapsedMs ?? diffMs(params.task.started_at, params.task.completed_at),
    estimated_duration_ms: estimateDurationMs(params.task),
  };
}

function findLastEvent(
  events: TaskOutcomeEvent[],
  predicate: (event: TaskOutcomeEvent) => boolean
): TaskOutcomeEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && predicate(event)) {
      return event;
    }
  }
  return null;
}

function buildSummary(task: Task, events: TaskOutcomeEvent[]): TaskOutcomeSummary {
  const ackedAt = findLastEvent(events, (event) => event.type === "acked")?.acked_at ?? null;
  const lastEvent = events.at(-1) ?? null;
  const lastFailure = findLastEvent(events, (event) => event.type === "failed");
  const lastAbandoned = findLastEvent(events, (event) => event.type === "abandoned");
  const verificationAt =
    lastEvent?.verification_at ??
    findLastEvent(events, (event) => event.verification_at !== null)?.verification_at ??
    null;

  return {
    task_id: task.id,
    goal_id: task.goal_id,
    latest_event_type: lastEvent?.type ?? null,
    latest_event_at: lastEvent?.ts ?? null,
    attempt: lastEvent?.attempt ?? Math.max(task.consecutive_failure_count, 1),
    task_status: task.status,
    verification_verdict: task.verification_verdict,
    action: lastEvent?.action,
    created_at: task.created_at ?? null,
    acked_at: ackedAt,
    started_at: task.started_at ?? null,
    completed_at: task.completed_at ?? null,
    verification_at: verificationAt,
    last_failure_at: lastFailure?.ts ?? null,
    abandoned_at: lastAbandoned?.ts ?? null,
    estimated_duration_ms: estimateDurationMs(task),
    latencies: {
      created_to_acked_ms: diffMs(task.created_at ?? null, ackedAt),
      acked_to_started_ms: diffMs(ackedAt, task.started_at ?? null),
      started_to_completed_ms: diffMs(task.started_at ?? null, task.completed_at ?? null),
      completed_to_verification_ms: diffMs(task.completed_at ?? null, verificationAt),
      created_to_completed_ms: diffMs(task.created_at ?? null, task.completed_at ?? null),
    },
  };
}

async function readLedgerRecord(
  stateManager: StateManager,
  goalId: string,
  taskId: string
): Promise<TaskOutcomeLedgerRecord | null> {
  const existing = await stateManager.readRaw(ledgerPath(goalId, taskId));
  if (!existing || typeof existing !== "object") {
    return null;
  }
  const record = existing as Partial<TaskOutcomeLedgerRecord>;
  return {
    task_id: typeof record.task_id === "string" ? record.task_id : taskId,
    goal_id: typeof record.goal_id === "string" ? record.goal_id : goalId,
    events: Array.isArray(record.events) ? (record.events as TaskOutcomeEvent[]) : [],
    summary: record.summary as TaskOutcomeSummary,
  };
}

async function writeLedgerRecord(
  stateManager: StateManager,
  task: Task,
  events: TaskOutcomeEvent[]
): Promise<TaskOutcomeLedgerRecord> {
  const record: TaskOutcomeLedgerRecord = {
    task_id: task.id,
    goal_id: task.goal_id,
    events,
    summary: buildSummary(task, events),
  };
  await stateManager.writeRaw(ledgerPath(task.goal_id, task.id), record);
  return record;
}

export async function appendTaskOutcomeEvent(
  stateManager: StateManager,
  params: AppendTaskOutcomeEventParams
): Promise<TaskOutcomeLedgerRecord> {
  const existing = await readLedgerRecord(stateManager, params.task.goal_id, params.task.id);
  const nextEvent = buildEvent(params);
  const events = [...(existing?.events ?? []), nextEvent];
  return writeLedgerRecord(stateManager, params.task, events);
}

export async function syncTaskOutcomeSummary(
  stateManager: StateManager,
  task: Task
): Promise<TaskOutcomeLedgerRecord> {
  const existing = await readLedgerRecord(stateManager, task.goal_id, task.id);
  return writeLedgerRecord(stateManager, task, existing?.events ?? []);
}

function inferMutationEvent(task: Task): TaskOutcomeEventType | null {
  if (task.status === "running") return "started";
  if (task.execution_output?.includes("[STOPPED]")) return "abandoned";
  if (task.verification_verdict === "pass") return "succeeded";
  if (task.status === "error" || task.status === "timed_out" || task.verification_verdict === "fail") return "failed";
  return null;
}

export async function recordTaskOutcomeMutation(
  stateManager: StateManager,
  task: Task
): Promise<TaskOutcomeLedgerRecord> {
  const existing = await readLedgerRecord(stateManager, task.goal_id, task.id);
  const inferredType = inferMutationEvent(task);
  const latestType = existing?.events.at(-1)?.type ?? null;

  if (inferredType !== null && latestType !== inferredType) {
    return appendTaskOutcomeEvent(stateManager, {
      task,
      type: inferredType,
      attempt: Math.max(task.consecutive_failure_count, 1),
      reason: inferredType === "abandoned" ? "task mutated externally" : undefined,
    });
  }

  return syncTaskOutcomeSummary(stateManager, task);
}

async function readLedgerRecordsInDir(dirPath: string): Promise<TaskOutcomeLedgerRecord[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: false });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const records: TaskOutcomeLedgerRecord[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(dirPath, entry), "utf-8")) as Partial<TaskOutcomeLedgerRecord>;
      if (
        typeof raw.task_id === "string" &&
        typeof raw.goal_id === "string" &&
        Array.isArray(raw.events) &&
        raw.summary &&
        typeof raw.summary === "object"
      ) {
        records.push(raw as TaskOutcomeLedgerRecord);
      }
    } catch {
      // Ignore malformed ledger records during aggregation.
    }
  }
  return records;
}

export async function summarizeTaskOutcomeLedgers(baseDir: string): Promise<TaskOutcomeAggregateSummary> {
  const tasksDir = path.join(baseDir, "tasks");
  let goalEntries: import("node:fs").Dirent[];
  try {
    goalEntries = await fsp.readdir(tasksDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        total_tasks: 0,
        terminal_tasks: 0,
        succeeded: 0,
        failed: 0,
        abandoned: 0,
        retried: 0,
        success_rate: null,
        retry_rate: null,
        abandoned_rate: null,
        p95_created_to_acked_ms: null,
        p95_started_to_completed_ms: null,
        p95_created_to_completed_ms: null,
      };
    }
    throw err;
  }

  const ledgerDirs = goalEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(tasksDir, entry.name, "ledger"));

  const records = (await Promise.all(ledgerDirs.map((dirPath) => readLedgerRecordsInDir(dirPath)))).flat();
  const createdToAcked = records
    .map((record) => record.summary.latencies.created_to_acked_ms)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const startedToCompleted = records
    .map((record) => record.summary.latencies.started_to_completed_ms)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const createdToCompleted = records
    .map((record) => record.summary.latencies.created_to_completed_ms)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const succeeded = records.filter((record) => record.summary.latest_event_type === "succeeded").length;
  const failed = records.filter((record) => record.summary.latest_event_type === "failed").length;
  const abandoned = records.filter((record) => record.summary.latest_event_type === "abandoned").length;
  const retried = records.filter((record) => record.events.some((event) => event.type === "retried")).length;
  const terminalTasks = succeeded + failed + abandoned;

  return {
    total_tasks: records.length,
    terminal_tasks: terminalTasks,
    succeeded,
    failed,
    abandoned,
    retried,
    success_rate: terminalTasks > 0 ? succeeded / terminalTasks : null,
    retry_rate: records.length > 0 ? retried / records.length : null,
    abandoned_rate: terminalTasks > 0 ? abandoned / terminalTasks : null,
    p95_created_to_acked_ms: percentile95(createdToAcked),
    p95_started_to_completed_ms: percentile95(startedToCompleted),
    p95_created_to_completed_ms: percentile95(createdToCompleted),
  };
}
