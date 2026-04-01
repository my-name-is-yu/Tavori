// ─── Agent Profile Types ───
//
// Schema for agent definition files loaded from ~/.pulseed/agents/*.md.
// Each file has YAML frontmatter + a system prompt body.

import { z } from "zod";

// ─── Schema ───

export const AgentProfileSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, "name must be lowercase alphanumeric and hyphens only"),
  adapter: z.string(),
  model: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  token_budget: z.number().positive().optional(),
  description: z.string().default(""),
  priority: z.number().int().default(0),
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

// ─── Extended type with system prompt ───

export interface AgentProfileWithPrompt extends AgentProfile {
  system_prompt: string;
  file_path: string;
}
