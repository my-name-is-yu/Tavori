import { z } from "zod";
import { DependencyTypeEnum } from "./core.js";

export const DependencyEdgeStatusEnum = z.enum(["active", "satisfied", "invalidated"]);
export type DependencyEdgeStatus = z.infer<typeof DependencyEdgeStatusEnum>;

export const DependencyEdgeSchema = z.object({
  from_goal_id: z.string(),
  to_goal_id: z.string(),
  type: DependencyTypeEnum,
  status: DependencyEdgeStatusEnum.default("active"),
  condition: z.string().nullable().default(null),
  affected_dimensions: z.array(z.string()).default([]),
  mitigation: z.string().nullable().default(null),
  detection_confidence: z.number().min(0).max(1).default(1.0),
  reasoning: z.string().nullable().default(null),
  created_at: z.string(),
});
export type DependencyEdge = z.infer<typeof DependencyEdgeSchema>;

export const DependencyGraphSchema = z.object({
  nodes: z.array(z.string()),
  edges: z.array(DependencyEdgeSchema),
  updated_at: z.string(),
});
export type DependencyGraph = z.infer<typeof DependencyGraphSchema>;
