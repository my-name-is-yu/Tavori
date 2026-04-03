// ─── A2A Protocol Types ───
//
// Zod schemas for Google A2A (Agent-to-Agent) Protocol v0.3.
// Used by A2AClient and A2AAdapter to validate all A2A message types.

import { z } from "zod";

// ─── Part variants ───

const A2ATextPartSchema = z.object({
  kind: z.literal("text"),
  text: z.string(),
});

const A2AFilePartSchema = z.object({
  kind: z.literal("file"),
  file: z.object({
    name: z.string().optional(),
    mimeType: z.string().optional(),
    bytes: z.string().optional(), // base64
    uri: z.string().optional(),
  }),
});

const A2ADataPartSchema = z.object({
  kind: z.literal("data"),
  data: z.record(z.unknown()),
});

export const A2APartSchema = z.discriminatedUnion("kind", [
  A2ATextPartSchema,
  A2AFilePartSchema,
  A2ADataPartSchema,
]);

export type A2APart = z.infer<typeof A2APartSchema>;

// ─── Message ───

export const A2AMessageSchema = z.object({
  role: z.enum(["user", "agent"]),
  parts: z.array(A2APartSchema),
  messageId: z.string().optional(),
  contextId: z.string().optional(),
  taskId: z.string().optional(),
});

export type A2AMessage = z.infer<typeof A2AMessageSchema>;

// ─── Task Status ───

export const A2ATaskStateSchema = z.enum([
  "submitted",
  "working",
  "input-required",
  "auth-required",
  "completed",
  "failed",
  "canceled",
  "rejected",
]);

export type A2ATaskState = z.infer<typeof A2ATaskStateSchema>;

export const A2ATaskStatusSchema = z.object({
  state: A2ATaskStateSchema,
  message: z.string().optional(),
  timestamp: z.string().optional(),
});

export type A2ATaskStatus = z.infer<typeof A2ATaskStatusSchema>;

// ─── Artifact ───

export const A2AArtifactSchema = z.object({
  artifactId: z.string().optional(),
  parts: z.array(A2APartSchema),
  name: z.string().optional(),
  description: z.string().optional(),
});

export type A2AArtifact = z.infer<typeof A2AArtifactSchema>;

// ─── Task ───

export const A2ATaskSchema = z.object({
  id: z.string(),
  contextId: z.string().optional(),
  status: A2ATaskStatusSchema,
  artifacts: z.array(A2AArtifactSchema).optional(),
  history: z.array(A2AMessageSchema).optional(),
  kind: z.literal("task").optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type A2ATask = z.infer<typeof A2ATaskSchema>;

// ─── Agent Card ───

export const A2ASkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  examples: z.array(z.string()).optional(),
});

export type A2ASkill = z.infer<typeof A2ASkillSchema>;

export const A2AAgentCardSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  url: z.string(),
  version: z.string().optional(),
  capabilities: z
    .object({
      streaming: z.boolean().optional(),
      pushNotifications: z.boolean().optional(),
    })
    .optional(),
  skills: z.array(A2ASkillSchema).optional(),
  securitySchemes: z.array(z.record(z.unknown())).optional(),
  defaultInputModes: z.array(z.string()).optional(),
  defaultOutputModes: z.array(z.string()).optional(),
});

export type A2AAgentCard = z.infer<typeof A2AAgentCardSchema>;

// ─── JSON-RPC envelope ───

export const A2AJsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

export type A2AJsonRpcResponse = z.infer<typeof A2AJsonRpcResponseSchema>;

// ─── Terminal states (for polling/streaming exit condition) ───

export const A2A_TERMINAL_STATES: ReadonlySet<A2ATaskState> = new Set<A2ATaskState>([
  "completed",
  "failed",
  "canceled",
  "rejected",
]);
