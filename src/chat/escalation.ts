// ─── EscalationHandler ───
//
// Handles /track command: converts conversation history to a PulSeed Goal (Tier 2 promotion).
// Phase 1c: creates the Goal but does NOT auto-start CoreLoop.
// User runs `pulseed run --goal <id>` to start the loop.

import type { StateManager } from "../state/state-manager.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { GoalNegotiator } from "../goal/goal-negotiator.js";
import type { ChatHistory } from "./chat-history.js";

// ─── Types ───

export interface EscalationDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  goalNegotiator: GoalNegotiator;
}

export interface EscalationResult {
  goalId: string;
  title: string;
  description: string;
}

const SYSTEM_PROMPT =
  "You are generating a PulSeed goal from a conversation. " +
  "Extract a clear, actionable goal description from the conversation below. " +
  "Return ONLY the goal description, nothing else.";

// ─── EscalationHandler ───

export class EscalationHandler {
  constructor(private readonly deps: EscalationDeps) {}

  /**
   * Convert conversation history to a tracked PulSeed Goal.
   *
   * Steps:
   *  1. Build LLM messages from conversation history
   *  2. Call LLM to extract goal description
   *  3. GoalNegotiator.negotiate(description) — feasibility + threshold refinement
   *  4. Goal is saved inside negotiate() — no separate saveGoal call needed
   *  5. Return EscalationResult
   */
  async escalateToGoal(history: ChatHistory): Promise<EscalationResult> {
    const messages = history.getMessages();
    if (messages.length === 0) {
      throw new Error("No conversation history to escalate.");
    }

    // Step 1: Build messages array for LLM
    const llmMessages = messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    // Step 2: Call LLM to extract goal description
    const response = await this.deps.llmClient.sendMessage(llmMessages, {
      system: SYSTEM_PROMPT,
    });
    const goalDescription = response.content.trim();

    if (!goalDescription) {
      throw new Error("LLM returned empty goal description.");
    }

    // Step 3: Negotiate goal (also persists it internally)
    const { goal } = await this.deps.goalNegotiator.negotiate(goalDescription);

    // Step 4: Return result
    return {
      goalId: goal.id,
      title: goal.title,
      description: goal.description,
    };
  }
}
