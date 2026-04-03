import { z } from "zod";

// 4 checkpoint types where guardrails execute
export const GuardrailCheckpointEnum = z.enum([
  "before_model",
  "after_model",
  "before_tool",
  "after_tool",
]);
export type GuardrailCheckpoint = z.infer<typeof GuardrailCheckpointEnum>;

// Severity levels for guardrail results
export const GuardrailSeverityEnum = z.enum(["info", "warning", "critical"]);
export type GuardrailSeverity = z.infer<typeof GuardrailSeverityEnum>;

// Result of a guardrail check
export const GuardrailResultSchema = z.object({
  hook_name: z.string(),
  checkpoint: GuardrailCheckpointEnum,
  allowed: z.boolean(),
  severity: GuardrailSeverityEnum.default("info"),
  reason: z.string().optional(),
  modified_input: z.unknown().optional(),
});
export type GuardrailResult = z.infer<typeof GuardrailResultSchema>;

// Aggregate result from running all hooks at a checkpoint
export const GuardrailAggregateResultSchema = z.object({
  allowed: z.boolean(),
  results: z.array(GuardrailResultSchema),
  modified_input: z.unknown().optional(),
});
export type GuardrailAggregateResult = z.infer<typeof GuardrailAggregateResultSchema>;

// Context passed to guardrail hooks
export const GuardrailContextSchema = z.object({
  checkpoint: GuardrailCheckpointEnum,
  goal_id: z.string().optional(),
  task_id: z.string().optional(),
  input: z.unknown(), // prompt string, task object, or result object depending on checkpoint
  metadata: z.record(z.unknown()).optional(),
});
export type GuardrailContext = z.infer<typeof GuardrailContextSchema>;

// Interface for guardrail hook implementations
export interface IGuardrailHook {
  readonly name: string;
  readonly checkpoint: GuardrailCheckpoint;
  readonly priority: number; // lower = runs first
  execute(context: GuardrailContext): Promise<GuardrailResult>;
}
