import { z } from "zod";

// --- Capability ---

export const CapabilityTypeEnum = z.enum(["tool", "permission", "service"]);
export type CapabilityType = z.infer<typeof CapabilityTypeEnum>;

export const CapabilityStatusEnum = z.enum(["available", "missing", "requested"]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusEnum>;

export const CapabilitySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: CapabilityTypeEnum,
  status: CapabilityStatusEnum,
  provider: z.string().optional(),
});
export type Capability = z.infer<typeof CapabilitySchema>;

// --- Capability Registry ---

export const CapabilityRegistrySchema = z.object({
  capabilities: z.array(CapabilitySchema),
  last_checked: z.string(), // ISO timestamp
});
export type CapabilityRegistry = z.infer<typeof CapabilityRegistrySchema>;

// --- Capability Gap ---

export const CapabilityGapSchema = z.object({
  missing_capability: z.object({
    name: z.string(),
    type: CapabilityTypeEnum,
  }),
  reason: z.string(),
  alternatives: z.array(z.string()),
  impact_description: z.string(),
  related_task_id: z.string().optional(),
});
export type CapabilityGap = z.infer<typeof CapabilityGapSchema>;
