import { z } from "zod";
import { EnvelopePrioritySchema, EnvelopeTypeSchema } from "../types/envelope.js";

export const ApprovalStateSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
]);
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

export const QueueRecordStateSchema = z.enum(["queued", "completed", "cancelled"]);
export type QueueRecordState = z.infer<typeof QueueRecordStateSchema>;

export const QueueRecordSchema = z.object({
  message_id: z.string(),
  envelope_type: EnvelopeTypeSchema,
  priority: EnvelopePrioritySchema,
  state: QueueRecordStateSchema,
  dedupe_key: z.string().optional(),
  available_at: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
});
export type QueueRecord = z.infer<typeof QueueRecordSchema>;
