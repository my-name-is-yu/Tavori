import { z } from "zod";

// --- Capability ---

export const CapabilityTypeEnum = z.enum(["tool", "permission", "service", "data_source"]);
export type CapabilityType = z.infer<typeof CapabilityTypeEnum>;

export const CapabilityStatusEnum = z.enum(["available", "missing", "requested", "acquiring", "verification_failed"]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusEnum>;

// --- Acquisition Context (defined before CapabilitySchema to allow reference) ---

export const AcquisitionMethodEnum = z.enum(["tool_creation", "permission_request", "service_setup"]);
export type AcquisitionMethod = z.infer<typeof AcquisitionMethodEnum>;

export const AcquisitionContextSchema = z.object({
  goal_id: z.string(),
  originating_task_id: z.string().optional(),
  acquired_at: z.string(),
  notes: z.string().optional(),
});
export type AcquisitionContext = z.infer<typeof AcquisitionContextSchema>;

export const CapabilitySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: CapabilityTypeEnum,
  status: CapabilityStatusEnum,
  provider: z.string().optional(),
  acquired_at: z.string().optional(),
  acquisition_context: AcquisitionContextSchema.optional(),
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

// --- Capability Acquisition ---

export const CapabilityAcquisitionTaskSchema = z.object({
  gap: CapabilityGapSchema,
  method: AcquisitionMethodEnum,
  task_description: z.string(),
  success_criteria: z.array(z.string()),
  verification_attempts: z.number().default(0),
  max_verification_attempts: z.number().default(3),
});
export type CapabilityAcquisitionTask = z.infer<typeof CapabilityAcquisitionTaskSchema>;

export const CapabilityDependencySchema = z.object({
  capability_id: z.string(),
  depends_on: z.array(z.string()),
});
export type CapabilityDependency = z.infer<typeof CapabilityDependencySchema>;

export const CapabilityVerificationResultEnum = z.enum(["pass", "fail", "escalate"]);
export type CapabilityVerificationResult = z.infer<typeof CapabilityVerificationResultEnum>;
