import { z } from "zod";
import type { ILLMClient } from "../llm/llm-client.js";

// ─── Types ───

export type IntentType =
  | "loop_start"
  | "loop_stop"
  | "status"
  | "report"
  | "goal_list"
  | "goal_create"
  | "help"
  | "dashboard"
  | "chat"
  | "unknown";

export interface RecognizedIntent {
  intent: IntentType;
  params?: Record<string, string>; // e.g., { description: "write a README" }
  response?: string; // conversational response text for "chat" intent
  raw: string; // original user input
}

// ─── Keyword table ───

interface KeywordRule {
  pattern: RegExp;
  intent: IntentType;
}

const KEYWORD_RULES: KeywordRule[] = [
  {
    pattern: /^\?(help)?$/i,
    intent: "help",
  },
  {
    pattern: /^\/(stop|quit|exit)/i,
    intent: "loop_stop",
  },
  {
    pattern: /^\/(run|start)(\s+.*)?$/i,
    intent: "loop_start",
  },
  {
    pattern: /^\/status$/i,
    intent: "status",
  },
  {
    pattern: /^\/report$/i,
    intent: "report",
  },
  {
    pattern: /^\/(goals?\s*(list)?)$/i,
    intent: "goal_list",
  },
  {
    pattern: /^\/help$/i,
    intent: "help",
  },
  {
    pattern: /^\/dashboard$/i,
    intent: "dashboard",
  },
];

// ─── LLM response schema ───

const LLMIntentSchema = z.object({
  intent: z.enum([
    "loop_start",
    "loop_stop",
    "goal_create",
    "chat",
    "unknown",
  ]),
  response: z.string().optional(),
  params: z.object({
    description: z.string().optional(),
    goalId: z.string().optional(),
  }).optional(),
});

const SYSTEM_PROMPT = `You are PulSeed's assistant. PulSeed is an AI agent orchestrator that manages goals with measurable dimensions.

Available actions you can trigger:
- goal_create: When the user clearly wants to create a new goal. Extract the description.
- loop_start: When the user wants to start executing a goal.
- loop_stop: When the user wants to stop execution.

For any other input, respond conversationally. Explain PulSeed's state, answer questions, or suggest what to do.

Respond in JSON: { "intent": "chat" | "goal_create" | "loop_start" | "loop_stop", "response": "your response text", "params": { "description": "..." } }`;

// ─── IntentRecognizer ───

/**
 * Hybrid intent recognizer: tries keyword regex first (free), falls back to LLM.
 */
export class IntentRecognizer {
  constructor(private llmClient?: ILLMClient) {}

  async recognize(input: string): Promise<RecognizedIntent> {
    // 1. Try keyword match first (cost: $0, instant)
    const keywordResult = this.keywordMatch(input);
    if (keywordResult) return keywordResult;

    // 2. LLM fallback if available
    if (this.llmClient) return this.llmFallback(input);

    // 3. No match, no LLM
    return { intent: "unknown", raw: input };
  }

  private keywordMatch(input: string): RecognizedIntent | null {
    const trimmed = input.trim();
    for (const rule of KEYWORD_RULES) {
      if (rule.pattern.test(trimmed)) {
        // For loop_start, extract optional goal argument (number or name)
        if (rule.intent === "loop_start") {
          const match = trimmed.match(/^\/(run|start)\s+(.+)$/i);
          const goalArg = match ? match[2].trim() : undefined;
          const params: Record<string, string> = goalArg ? { goalArg } : {};
          return {
            intent: rule.intent,
            params: Object.keys(params).length > 0 ? params : undefined,
            raw: input,
          };
        }
        return { intent: rule.intent, raw: input };
      }
    }
    return null;
  }

  private async llmFallback(input: string): Promise<RecognizedIntent> {
    // llmFallback is only called when this.llmClient is defined (see recognize())
    const llmClient = this.llmClient;
    if (!llmClient) return { intent: "unknown", raw: input };
    try {
      const llmResponse = await llmClient.sendMessage(
        [{ role: "user", content: input }],
        { system: SYSTEM_PROMPT, max_tokens: 512, temperature: 0 }
      );

      const parsed = llmClient.parseJSON(llmResponse.content, LLMIntentSchema);

      const params: Record<string, string> = {};
      if (parsed.params?.description) params["description"] = parsed.params.description;
      if (parsed.params?.goalId) params["goalId"] = parsed.params.goalId;
      // For chat intent, also expose response text via params for legacy compatibility
      if (parsed.response) params["response"] = parsed.response;

      return {
        intent: parsed.intent,
        params: Object.keys(params).length > 0 ? params : undefined,
        response: parsed.response,
        raw: input,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[IntentRecognizer] LLM fallback failed: ${msg}`);
      return { intent: "unknown", raw: input };
    }
  }
}
