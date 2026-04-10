import { z } from "zod";

export const RuntimeEnvelopeKindSchema = z.enum(["event", "command", "approval", "system"]);
export type RuntimeEnvelopeKind = z.infer<typeof RuntimeEnvelopeKindSchema>;

export const RuntimeEnvelopePrioritySchema = z.enum(["critical", "high", "normal", "low"]);
export type RuntimeEnvelopePriority = z.infer<typeof RuntimeEnvelopePrioritySchema>;

export const RuntimeEnvelopeSchema = z.object({
  message_id: z.string(),
  kind: RuntimeEnvelopeKindSchema,
  name: z.string(),
  source: z.string(),
  goal_id: z.string().optional(),
  correlation_id: z.string().optional(),
  idempotency_key: z.string().optional(),
  dedupe_key: z.string().optional(),
  priority: RuntimeEnvelopePrioritySchema,
  payload: z.unknown(),
  created_at: z.number().int().nonnegative(),
  ttl_ms: z.number().int().positive().optional(),
  attempt: z.number().int().nonnegative().default(0),
});
export type RuntimeEnvelope = z.infer<typeof RuntimeEnvelopeSchema>;

export const RuntimeQueueStateSchema = z.enum([
  "accepted",
  "queued",
  "claimed",
  "retry_wait",
  "completed",
  "deadletter",
  "cancelled",
]);
export type RuntimeQueueState = z.infer<typeof RuntimeQueueStateSchema>;

export const RuntimeQueueRecordSchema = z.object({
  message_id: z.string(),
  state: z.enum(["queued", "claimed", "retry_wait", "completed", "deadletter", "cancelled"]),
  available_at: z.number().int().nonnegative(),
  claimed_by: z.string().optional(),
  lease_until: z.number().int().nonnegative().optional(),
  attempt: z.number().int().nonnegative().default(0),
  last_error: z.string().optional(),
  updated_at: z.number().int().nonnegative(),
});
export type RuntimeQueueRecord = z.infer<typeof RuntimeQueueRecordSchema>;

export const GoalLeaseRecordSchema = z.object({
  goal_id: z.string(),
  owner_token: z.string(),
  attempt_id: z.string(),
  worker_id: z.string(),
  lease_until: z.number().int().nonnegative(),
  acquired_at: z.number().int().nonnegative(),
  last_renewed_at: z.number().int().nonnegative(),
});
export type GoalLeaseRecord = z.infer<typeof GoalLeaseRecordSchema>;

export const ApprovalStateSchema = z.enum(["pending", "approved", "denied", "expired", "cancelled"]);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export const ApprovalRecordSchema = z.object({
  approval_id: z.string(),
  goal_id: z.string().optional(),
  request_envelope_id: z.string(),
  correlation_id: z.string(),
  state: ApprovalStateSchema,
  created_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  resolved_at: z.number().int().nonnegative().optional(),
  response_channel: z.string().optional(),
  payload: z.unknown(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const OutboxRecordSchema = z.object({
  seq: z.number().int().positive(),
  event_type: z.string(),
  goal_id: z.string().optional(),
  correlation_id: z.string().optional(),
  created_at: z.number().int().nonnegative(),
  payload: z.unknown(),
});
export type OutboxRecord = z.infer<typeof OutboxRecordSchema>;

export const RuntimeHealthStatusSchema = z.enum(["ok", "degraded", "failed"]);
export type RuntimeHealthStatus = z.infer<typeof RuntimeHealthStatusSchema>;

export const RuntimeHealthCapabilitySchema = z.object({
  status: RuntimeHealthStatusSchema,
  checked_at: z.number().int().nonnegative(),
  last_ok_at: z.number().int().nonnegative().optional(),
  last_degraded_at: z.number().int().nonnegative().optional(),
  last_failed_at: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});
export type RuntimeHealthCapability = z.infer<typeof RuntimeHealthCapabilitySchema>;

export const RuntimeHealthKpiSchema = z.object({
  process_alive: RuntimeHealthCapabilitySchema,
  command_acceptance: RuntimeHealthCapabilitySchema,
  task_execution: RuntimeHealthCapabilitySchema,
  degraded_at: z.number().int().nonnegative().optional(),
  recovered_at: z.number().int().nonnegative().optional(),
});
export type RuntimeHealthKpi = z.infer<typeof RuntimeHealthKpiSchema>;

export interface RuntimeHealthCapabilityStatuses {
  process_alive: RuntimeHealthStatus;
  command_acceptance: RuntimeHealthStatus;
  task_execution: RuntimeHealthStatus;
}

export interface RuntimeHealthKpiSnapshot {
  status: RuntimeHealthStatus;
  process_alive: boolean;
  can_accept_command: boolean;
  can_execute_task: boolean;
  degraded_at?: number;
  recovered_at?: number;
}

export const RuntimeDaemonHealthSchema = z.object({
  status: RuntimeHealthStatusSchema,
  leader: z.boolean(),
  checked_at: z.number().int().nonnegative(),
  kpi: RuntimeHealthKpiSchema.optional(),
  details: z.record(z.unknown()).optional(),
});
export type RuntimeDaemonHealth = z.infer<typeof RuntimeDaemonHealthSchema>;

export const RuntimeComponentsHealthSchema = z.object({
  checked_at: z.number().int().nonnegative(),
  components: z.record(RuntimeHealthStatusSchema),
});
export type RuntimeComponentsHealth = z.infer<typeof RuntimeComponentsHealthSchema>;

export const RuntimeHealthSnapshotSchema = z.object({
  status: RuntimeHealthStatusSchema,
  leader: z.boolean(),
  checked_at: z.number().int().nonnegative(),
  components: z.record(RuntimeHealthStatusSchema),
  kpi: RuntimeHealthKpiSchema.optional(),
  details: z.record(z.unknown()).optional(),
});
export type RuntimeHealthSnapshot = z.infer<typeof RuntimeHealthSnapshotSchema>;

export function summarizeRuntimeHealthStatus(
  components: Record<string, RuntimeHealthStatus>
): RuntimeHealthStatus {
  const statuses = Object.values(components);
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

export function evolveRuntimeHealthKpi(
  previous: RuntimeHealthKpi | null | undefined,
  nextStatuses: RuntimeHealthCapabilityStatuses,
  checkedAt: number,
  reasons: Partial<Record<keyof RuntimeHealthCapabilityStatuses, string>> = {}
): RuntimeHealthKpi {
  const updateCapability = (
    prior: RuntimeHealthCapability | undefined,
    nextStatus: RuntimeHealthStatus,
    reason?: string
  ): RuntimeHealthCapability => {
    const changed = prior?.status !== nextStatus;
    return {
      status: nextStatus,
      checked_at: checkedAt,
      last_ok_at: nextStatus === "ok" ? checkedAt : prior?.last_ok_at,
      last_degraded_at:
        nextStatus === "degraded"
          ? changed
            ? checkedAt
            : prior?.last_degraded_at ?? checkedAt
          : prior?.last_degraded_at,
      last_failed_at:
        nextStatus === "failed"
          ? changed
            ? checkedAt
            : prior?.last_failed_at ?? checkedAt
          : prior?.last_failed_at,
      reason: nextStatus === "ok" ? undefined : reason ?? prior?.reason,
    };
  };

  const next = RuntimeHealthKpiSchema.parse({
    process_alive: updateCapability(
      previous?.process_alive,
      nextStatuses.process_alive,
      reasons.process_alive
    ),
    command_acceptance: updateCapability(
      previous?.command_acceptance,
      nextStatuses.command_acceptance,
      reasons.command_acceptance
    ),
    task_execution: updateCapability(
      previous?.task_execution,
      nextStatuses.task_execution,
      reasons.task_execution
    ),
    degraded_at: previous?.degraded_at,
    recovered_at: previous?.recovered_at,
  });

  const previousStatus = previous ? summarizeRuntimeHealthKpi(previous) : "ok";
  const currentStatus = summarizeRuntimeHealthKpi(next);
  if (currentStatus === "ok") {
    next.recovered_at = previousStatus === "ok" ? previous?.recovered_at : checkedAt;
    next.degraded_at = previous?.degraded_at;
  } else {
    next.degraded_at = previousStatus === "ok" ? checkedAt : previous?.degraded_at ?? checkedAt;
    next.recovered_at = previous?.recovered_at;
  }

  return next;
}

export function summarizeRuntimeHealthKpi(kpi: RuntimeHealthKpi): RuntimeHealthStatus {
  return summarizeRuntimeHealthStatus({
    process_alive: kpi.process_alive.status,
    command_acceptance: kpi.command_acceptance.status,
    task_execution: kpi.task_execution.status,
  });
}

export function compactRuntimeHealthKpi(
  kpi: RuntimeHealthKpi | null | undefined
): RuntimeHealthKpiSnapshot | null {
  if (!kpi) {
    return null;
  }

  return {
    status: summarizeRuntimeHealthKpi(kpi),
    process_alive: kpi.process_alive.status === "ok",
    can_accept_command: kpi.command_acceptance.status === "ok",
    can_execute_task: kpi.task_execution.status === "ok",
    degraded_at: kpi.degraded_at,
    recovered_at: kpi.recovered_at,
  };
}
