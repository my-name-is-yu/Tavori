import { z } from "zod";
import {
  ObservationTriggerEnum,
  ObservationLayerEnum,
  ObservationMethodSchema,
  PaceStatusEnum,
} from "./core.js";

// --- Observation Log Entry ---

export const ObservationLogEntrySchema = z.object({
  observation_id: z.string(),
  timestamp: z.string(),
  trigger: ObservationTriggerEnum,
  goal_id: z.string(),
  dimension_name: z.string(),
  layer: ObservationLayerEnum,
  method: ObservationMethodSchema,
  raw_result: z.unknown(),
  extracted_value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  confidence: z.number().min(0).max(1),
  notes: z.string().nullable().default(null),
});
export type ObservationLogEntry = z.infer<typeof ObservationLogEntrySchema>;

// --- Observation Log (collection for a goal) ---

export const ObservationLogSchema = z.object({
  goal_id: z.string(),
  entries: z.array(ObservationLogEntrySchema),
});
export type ObservationLog = z.infer<typeof ObservationLogSchema>;

// --- Reschedule Options (for behind milestones) ---

export const RescheduleOptionItemSchema = z.object({
  option_type: z.enum(["extend_deadline", "reduce_target", "renegotiate"]),
  description: z.string(),
  new_target_date: z.string().nullable().default(null),
  new_target_value: z.number().nullable().default(null),
});
export type RescheduleOptionItem = z.infer<typeof RescheduleOptionItemSchema>;

export const RescheduleOptionsSchema = z.object({
  milestone_id: z.string(),
  goal_id: z.string(),
  current_pace: PaceStatusEnum,
  options: z.array(RescheduleOptionItemSchema),
  generated_at: z.string(),
});
export type RescheduleOptions = z.infer<typeof RescheduleOptionsSchema>;
