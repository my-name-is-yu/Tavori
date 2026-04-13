import { z } from "zod";

export const RuntimeControlOperationKindSchema = z.enum([
  "restart_daemon",
  "restart_gateway",
  "reload_config",
  "self_update",
]);
export type RuntimeControlOperationKind = z.infer<typeof RuntimeControlOperationKindSchema>;

export const RuntimeControlOperationStateSchema = z.enum([
  "pending",
  "acknowledged",
  "approved",
  "running",
  "restarting",
  "verified",
  "failed",
  "cancelled",
]);
export type RuntimeControlOperationState = z.infer<typeof RuntimeControlOperationStateSchema>;

export const RuntimeControlActorSchema = z.object({
  surface: z.enum(["chat", "gateway", "cli", "tui"]),
  platform: z.string().optional(),
  conversation_id: z.string().optional(),
  identity_key: z.string().optional(),
  user_id: z.string().optional(),
});
export type RuntimeControlActor = z.infer<typeof RuntimeControlActorSchema>;

export const RuntimeControlReplyTargetSchema = z.object({
  surface: z.enum(["chat", "gateway", "cli", "tui"]).optional(),
  platform: z.string().optional(),
  conversation_id: z.string().optional(),
  response_channel: z.string().optional(),
  outbox_topic: z.string().optional(),
  identity_key: z.string().optional(),
  user_id: z.string().optional(),
});
export type RuntimeControlReplyTarget = z.infer<typeof RuntimeControlReplyTargetSchema>;

export const RuntimeControlOperationSchema = z.object({
  operation_id: z.string().min(1),
  kind: RuntimeControlOperationKindSchema,
  state: RuntimeControlOperationStateSchema,
  requested_at: z.string(),
  updated_at: z.string(),
  requested_by: RuntimeControlActorSchema,
  reply_target: RuntimeControlReplyTargetSchema,
  reason: z.string(),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  approval_id: z.string().optional(),
  ack_outbox_seq: z.number().int().positive().optional(),
  restart_marker_path: z.string().optional(),
  expected_health: z.object({
    daemon_ping: z.boolean(),
    gateway_acceptance: z.boolean(),
  }),
  result: z.object({
    ok: z.boolean(),
    message: z.string(),
    daemon_status: z.string().optional(),
    health_error: z.string().optional(),
  }).optional(),
});
export type RuntimeControlOperation = z.infer<typeof RuntimeControlOperationSchema>;

export function isTerminalRuntimeControlState(state: RuntimeControlOperationState): boolean {
  return state === "verified" || state === "failed" || state === "cancelled";
}
