import { z } from "zod";
import { NegotiationResponseTypeEnum } from "./core.js";

export const NegotiationStepEnum = z.enum([
  "ethics_check",
  "goal_intake",
  "dimension_decomposition",
  "baseline_observation",
  "feasibility_evaluation",
  "response_generation",
]);
export type NegotiationStep = z.infer<typeof NegotiationStepEnum>;

export const FeasibilityPathEnum = z.enum(["quantitative", "qualitative", "hybrid"]);
export type FeasibilityPath = z.infer<typeof FeasibilityPathEnum>;

export const DimensionDecompositionSchema = z.object({
  name: z.string(),
  label: z.string(),
  threshold_type: z.enum(["min", "max", "range", "present", "match"]),
  threshold_value: z.union([z.number(), z.string(), z.boolean(), z.array(z.union([z.number(), z.string()]))]).nullable(),
  observation_method_hint: z.string(),
});
export type DimensionDecomposition = z.infer<typeof DimensionDecompositionSchema>;

export const FeasibilityResultSchema = z.object({
  dimension: z.string(),
  path: FeasibilityPathEnum,
  feasibility_ratio: z.number().nullable(),
  assessment: z.enum(["realistic", "ambitious", "infeasible"]),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string(),
  key_assumptions: z.array(z.string()),
  main_risks: z.array(z.string()),
});
export type FeasibilityResult = z.infer<typeof FeasibilityResultSchema>;

export const CapabilityCheckLogSchema = z.object({
  capabilities_available: z.array(z.string()),
  gaps_detected: z.array(z.object({
    dimension: z.string(),
    required_capability: z.string(),
    acquirable: z.boolean(),
  })),
  infeasible_dimensions: z.array(z.string()),
}).strict();
export type CapabilityCheckLog = z.infer<typeof CapabilityCheckLogSchema>;

export const NegotiationLogSchema = z.object({
  goal_id: z.string(),
  timestamp: z.string(),
  is_renegotiation: z.boolean().default(false),
  renegotiation_trigger: z.enum(["stall", "new_info", "user_request"]).nullable().default(null),

  step2_decomposition: z.object({
    dimensions: z.array(DimensionDecompositionSchema),
    method: z.literal("llm"),
  }).nullable().default(null),

  step3_baseline: z.object({
    observations: z.array(z.object({
      dimension: z.string(),
      value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
      confidence: z.number(),
      method: z.string(),
    })),
  }).nullable().default(null),

  step4_evaluation: z.object({
    path: FeasibilityPathEnum,
    dimensions: z.array(FeasibilityResultSchema),
  }).nullable().default(null),

  step4_capability_check: CapabilityCheckLogSchema.nullable().default(null),

  step5_response: z.object({
    type: NegotiationResponseTypeEnum,
    accepted: z.boolean(),
    initial_confidence: z.enum(["high", "medium", "low"]),
    user_acknowledged: z.boolean().default(false),
    counter_proposal: z.object({
      realistic_target: z.number(),
      reasoning: z.string(),
      alternatives: z.array(z.string()),
    }).nullable().default(null),
  }).nullable().default(null),
});
export type NegotiationLog = z.infer<typeof NegotiationLogSchema>;

export const NegotiationResponseSchema = z.object({
  type: NegotiationResponseTypeEnum,
  message: z.string(),
  accepted: z.boolean(),
  initial_confidence: z.enum(["high", "medium", "low"]),
  counter_proposal: z.object({
    realistic_target: z.number(),
    reasoning: z.string(),
    alternatives: z.array(z.string()),
  }).optional(),
  flags: z.array(z.string()).optional(),
});
export type NegotiationResponse = z.infer<typeof NegotiationResponseSchema>;
