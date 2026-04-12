import { z } from "zod";
import type { CorePhaseKind, CorePhaseSpec } from "../../execution/agent-loop/core-phase-runner.js";

export interface CorePhaseInvocationContext {
  goalId: string;
  taskId?: string;
  gapAggregate?: number;
  stallDetected?: boolean;
  hasTaskResult?: boolean;
}

export const ObservationEvidenceSchema = z.object({
  summary: z.string(),
  evidence: z.array(z.string()).default([]),
  missing_info: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type ObservationEvidence = z.infer<typeof ObservationEvidenceSchema>;

export const KnowledgeRefreshEvidenceSchema = z.object({
  summary: z.string(),
  required_knowledge: z.array(z.string()).default([]),
  acquisition_candidates: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  worthwhile: z.boolean().default(false),
});
export type KnowledgeRefreshEvidence = z.infer<typeof KnowledgeRefreshEvidenceSchema>;

export const StallInvestigationEvidenceSchema = z.object({
  summary: z.string(),
  suspected_causes: z.array(z.string()).default([]),
  recommended_next_evidence: z.array(z.string()).default([]),
  relevant_actions: z.array(z.enum(["refine", "pivot", "escalate", "continue"])).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type StallInvestigationEvidence = z.infer<typeof StallInvestigationEvidenceSchema>;

export const ReplanningOptionsSchema = z.object({
  summary: z.string(),
  recommended_action: z.enum(["continue", "refine", "pivot"]).default("continue"),
  candidates: z.array(z.object({
    title: z.string(),
    rationale: z.string(),
    expected_evidence_gain: z.string(),
    blast_radius: z.string(),
    target_dimensions: z.array(z.string()).default([]),
    dependencies: z.array(z.string()).default([]),
  })).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type ReplanningOptions = z.infer<typeof ReplanningOptionsSchema>;

export const VerificationEvidenceSchema = z.object({
  summary: z.string(),
  supported_claims: z.array(z.string()).default([]),
  unsupported_claims: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;

function baseSpec<TInput, TOutput>(input: {
  phase: CorePhaseKind;
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  outputSchema: z.ZodType<TOutput, z.ZodTypeDef, unknown>;
  failPolicy: "return_low_confidence" | "fallback_deterministic" | "fail_cycle";
  runWhen: (ctx: CorePhaseInvocationContext) => boolean;
}): Pick<CorePhaseSpec<TInput, TOutput>, "phase" | "inputSchema" | "outputSchema" | "failPolicy"> & { runWhen: (ctx: CorePhaseInvocationContext) => boolean } {
  return input;
}

export function buildObserveEvidenceSpec(): ReturnType<typeof baseSpec<{
  goalTitle: string;
  goalDescription: string;
  dimensions: string[];
  workspacePath?: string;
}, ObservationEvidence>> {
  return baseSpec({
    phase: "observe_evidence",
    inputSchema: z.object({
      goalTitle: z.string(),
      goalDescription: z.string(),
      dimensions: z.array(z.string()).default([]),
      workspacePath: z.string().optional(),
    }),
    outputSchema: ObservationEvidenceSchema,
    failPolicy: "fallback_deterministic",
    runWhen: () => true,
  });
}

export function buildKnowledgeRefreshSpec(): ReturnType<typeof baseSpec<{
  goalTitle: string;
  topDimensions: string[];
  gapAggregate: number;
}, KnowledgeRefreshEvidence>> {
  return baseSpec({
    phase: "knowledge_refresh",
    inputSchema: z.object({
      goalTitle: z.string(),
      topDimensions: z.array(z.string()).default([]),
      gapAggregate: z.number(),
    }),
    outputSchema: KnowledgeRefreshEvidenceSchema,
    failPolicy: "return_low_confidence",
    runWhen: (ctx) => (ctx.gapAggregate ?? 0) > 0,
  });
}

export function buildStallInvestigationSpec(): ReturnType<typeof baseSpec<{
  goalTitle: string;
  stallType: string;
  dimensionName?: string;
  suggestedCause?: string;
}, StallInvestigationEvidence>> {
  return baseSpec({
    phase: "stall_investigation",
    inputSchema: z.object({
      goalTitle: z.string(),
      stallType: z.string(),
      dimensionName: z.string().optional(),
      suggestedCause: z.string().optional(),
    }),
    outputSchema: StallInvestigationEvidenceSchema,
    failPolicy: "return_low_confidence",
    runWhen: (ctx) => ctx.stallDetected === true,
  });
}

export function buildReplanningOptionsSpec(): ReturnType<typeof baseSpec<{
  goalTitle: string;
  targetDimensions: string[];
  gapAggregate: number;
  currentApproach?: string;
}, ReplanningOptions>> {
  return baseSpec({
    phase: "replanning_options",
    inputSchema: z.object({
      goalTitle: z.string(),
      targetDimensions: z.array(z.string()).default([]),
      gapAggregate: z.number(),
      currentApproach: z.string().optional(),
    }),
    outputSchema: ReplanningOptionsSchema,
    failPolicy: "fallback_deterministic",
    runWhen: (ctx) => (ctx.gapAggregate ?? 0) > 0,
  });
}

export function buildVerificationEvidenceSpec(requiredTools: readonly string[] = []): CorePhaseSpec<{
  taskId: string;
  taskDescription: string;
  successCriteria: string[];
  executionAction: string;
}, VerificationEvidence> & { runWhen: (ctx: CorePhaseInvocationContext) => boolean } {
  return {
    phase: "verification_evidence",
    inputSchema: z.object({
      taskId: z.string(),
      taskDescription: z.string(),
      successCriteria: z.array(z.string()).default([]),
      executionAction: z.string(),
    }),
    outputSchema: VerificationEvidenceSchema,
    requiredTools,
    allowedTools: [],
    failPolicy: "fallback_deterministic",
    runWhen: (ctx) => ctx.hasTaskResult === true,
  };
}
