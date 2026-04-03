import { z } from "zod";
import { ThresholdTypeEnum } from "./core.js";
import { GoalSchema } from "./goal.js";
import { FeasibilityResultSchema } from "./negotiation.js";

// --- RefineConfig ---

export const RefineConfigSchema = z.object({
  maxDepth: z.number().int().min(1).default(3),
  tokenBudget: z.number().int().min(1).default(50000),
  feasibilityCheck: z.boolean().default(true),
  minSpecificity: z.number().min(0).max(1).default(0.7),
  maxChildrenPerNode: z.number().int().min(1).default(5),
  force: z.boolean().optional(),
});
export type RefineConfig = z.infer<typeof RefineConfigSchema>;

// --- LeafDimension ---

export const LeafDimensionSchema = z.object({
  name: z.string(),
  label: z.string(),
  threshold_type: ThresholdTypeEnum,
  threshold_value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  data_source: z.string(),
  observation_command: z.string(),
});
export type LeafDimension = z.infer<typeof LeafDimensionSchema>;

// --- LeafTestResult ---

export const LeafTestResultSchema = z.object({
  is_measurable: z.boolean(),
  dimensions: z.array(LeafDimensionSchema).nullable(),
  reason: z.string(),
});
export type LeafTestResult = z.infer<typeof LeafTestResultSchema>;

// --- RefineResult (recursive, uses lazy) ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const RefineResultSchema: z.ZodTypeAny = z.lazy(() =>
  z.object({
    goal: GoalSchema,
    leaf: z.boolean(),
    children: z.array(RefineResultSchema).nullable(),
    feasibility: z.array(FeasibilityResultSchema).nullable(),
    tokensUsed: z.number().int().min(0),
    reason: z.string(),
  })
);

export type RefineResult = {
  goal: z.infer<typeof GoalSchema>;
  leaf: boolean;
  children: RefineResult[] | null;
  feasibility: z.infer<typeof FeasibilityResultSchema>[] | null;
  tokensUsed: number;
  reason: string;
};
