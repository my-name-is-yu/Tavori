import { z } from "zod";

export const EthicsVerdictEnum = z.enum(["reject", "flag", "pass"]);
export type EthicsVerdictType = z.infer<typeof EthicsVerdictEnum>;

export const EthicsVerdictSchema = z.object({
  verdict: EthicsVerdictEnum,
  category: z.string(),
  reasoning: z.string(),
  risks: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type EthicsVerdict = z.infer<typeof EthicsVerdictSchema>;

export const EthicsSubjectTypeEnum = z.enum(["goal", "subgoal", "task"]);
export type EthicsSubjectType = z.infer<typeof EthicsSubjectTypeEnum>;

export const EthicsLogSchema = z.object({
  log_id: z.string(),
  timestamp: z.string(),
  subject_type: EthicsSubjectTypeEnum,
  subject_id: z.string(),
  subject_description: z.string(),
  verdict: EthicsVerdictSchema,
  layer1_triggered: z.boolean().optional(),
  rejection_delivered: z.object({
    message: z.string(),
    delivered_at: z.string(),
  }).optional(),
  user_confirmation: z.object({
    risks_presented: z.array(z.string()),
    user_response: z.enum(["acknowledged", "cancelled", "pending"]),
    responded_at: z.string().optional(),
    acknowledged_risks: z.array(z.string()).optional(),
  }).optional(),
});
export type EthicsLog = z.infer<typeof EthicsLogSchema>;

export const Layer1RuleCategoryEnum = z.enum([
  "illegal_activity",
  "direct_harm",
  "privacy_violation",
  "deception_impersonation",
  "security_breach",
  "discrimination_harassment_automation",
  "destructive_action",
  "credential_access",
]);
export type Layer1RuleCategory = z.infer<typeof Layer1RuleCategoryEnum>;

export interface Layer1Rule {
  category: Layer1RuleCategory;
  description: string;
  matches: (input: string) => boolean;
}

export const CustomConstraintSchema = z.object({
  description: z.string(),
  applies_to: z.enum(["goal", "task_means"]),
});
export type CustomConstraint = z.infer<typeof CustomConstraintSchema>;

export const CustomConstraintsConfigSchema = z.object({
  constraints: z.array(CustomConstraintSchema),
});
export type CustomConstraintsConfig = z.infer<typeof CustomConstraintsConfigSchema>;
