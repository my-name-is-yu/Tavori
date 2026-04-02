/**
 * strategy.ts
 * System prompt and response schema for the "strategy_generation" purpose.
 * Used by PromptGateway to generate candidate strategies for achieving a goal.
 */

import { z } from "zod";
import { StrategyArraySchema } from "../../strategy/strategy-helpers.js";

export const STRATEGY_SYSTEM_PROMPT = `Generate candidate strategies for achieving the goal.
Consider past lessons, strategy templates from similar goals, and the current gap.
Each strategy should have a testable hypothesis and a clear approach.
Prefer strategies that have succeeded on similar goals when templates are available.

Respond with a JSON array (NOT a wrapped object). The array must contain 1-2 strategy objects.
Each object must have these fields:
- "hypothesis": string (the core bet/approach)
- "expected_effect": array of { "dimension": string, "direction": "increase"|"decrease", "magnitude": "small"|"medium"|"large" }
- "resource_estimate": { "sessions": number, "duration": { "value": number, "unit": "minutes"|"hours"|"days"|"weeks" }, "llm_calls": number|null }
- "allocation": number between 0 and 1

Example format:
[
  {
    "hypothesis": "...",
    "expected_effect": [{ "dimension": "...", "direction": "increase", "magnitude": "medium" }],
    "resource_estimate": { "sessions": 3, "duration": { "value": 2, "unit": "hours" }, "llm_calls": null },
    "allocation": 0.5
  }
]`;

// Re-export the canonical schema from strategy-helpers to avoid duplication
export { StrategyArraySchema as StrategyResponseSchema } from "../../strategy/strategy-helpers.js";

export type StrategyResponse = z.infer<typeof StrategyArraySchema>;
