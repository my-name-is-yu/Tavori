/**
 * curiosity.ts
 * System prompt and response schema for the curiosity proposal purpose.
 * Used by PromptGateway for CURIOSITY_PROPOSE.
 */

import { z } from "zod";

// ─── CURIOSITY_PROPOSE ────────────────────────────────────────────────────────

export const CURIOSITY_PROPOSE_SYSTEM_PROMPT =
  "You are PulSeed, an AI agent orchestrator. " +
  "Analyze curiosity triggers and propose new exploration goals based on observed patterns and learning history. " +
  "Proposals must be grounded in evidence, directly related to current goal domains, and have clear rationale. " +
  "Return only valid JSON, no markdown or explanation outside the JSON.";

export const CuriosityProposeResponseSchema = z.object({
  proposals: z.array(
    z.object({
      title: z.string(),
      rationale: z.string(),
      related_goal_ids: z.array(z.string()).optional(),
      estimated_value: z.enum(["low", "medium", "high"]).optional(),
    })
  ),
});

export type CuriosityProposeResponse = z.infer<typeof CuriosityProposeResponseSchema>;
