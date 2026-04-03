import Anthropic from "@anthropic-ai/sdk";
import type { ZodSchema } from "zod";
import { sleep } from "../utils/sleep.js";
import { BaseLLMClient, DEFAULT_MAX_TOKENS, DEFAULT_LLM_TIMEOUT_MS, MAX_RETRY_ATTEMPTS, RETRY_DELAYS_MS, RATE_LIMIT_RETRY_DELAYS_MS, isRateLimitError, getRateLimitRetryDelay, extractJSON } from "./base-llm-client.js";
import type { ModelTier, ParseJSONMessage, ParseJSONOptions } from "./base-llm-client.js";
import { LLMError } from "../utils/errors.js";
import { GuardrailRunner } from "../traits/guardrail-runner.js";

// ─── Inline Types ───

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export type { ModelTier };

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCallResult {
  id: string;
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface LLMRequestOptions {
  model?: string;
  max_tokens?: number;
  system?: string;
  temperature?: number;
  /** Route to light model when configured. Defaults to 'main' for backward compat. */
  model_tier?: ModelTier;
  /** Tool definitions for function calling (tool use). */
  tools?: ToolDefinition[];
}

export interface LLMResponse {
  content: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  stop_reason: string;
  /** Tool call results when the model invokes tools. */
  tool_calls?: ToolCallResult[];
}

// ─── Interface ───

export interface ILLMClient {
  sendMessage(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse>;
  parseJSON<T>(content: string, schema: ZodSchema<T>): T;
  parseJSON<T>(content: string, schema: ZodSchema<T>, options: ParseJSONOptions): Promise<T>;
}

// ─── Constants ───

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_TEMPERATURE = 0;

// Re-export shared utilities for consumers that import from this module
export { extractJSON, DEFAULT_MAX_TOKENS };

// ─── LLMClient ───

/**
 * Thin wrapper around the Anthropic SDK.
 * Provides retry logic and JSON extraction/validation.
 *
 * Constructor throws if no API key is provided.
 */
export class LLMClient extends BaseLLMClient implements ILLMClient {
  private readonly client: Anthropic;
  private guardrailRunner?: GuardrailRunner;
  private readonly defaultModel: string;

  constructor(apiKey: string, guardrailRunner?: GuardrailRunner, lightModel?: string, model?: string) {
    super();
    if (!apiKey) {
      throw new LLMError(
        "LLMClient: no API key provided. Pass apiKey to constructor."
      );
    }
    this.client = new Anthropic({ apiKey });
    this.guardrailRunner = guardrailRunner;
    this.lightModel = lightModel;
    this.defaultModel = model ?? DEFAULT_MODEL;
  }

  /**
   * Send a message to the Anthropic API with retry logic.
   * Retries up to MAX_RETRY_ATTEMPTS times with exponential backoff.
   * Retries up to RATE_LIMIT_RETRY_DELAYS_MS.length times on HTTP 429 with extended backoff.
   */
  async sendMessage(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const model = this.resolveEffectiveModel(options?.model ?? this.defaultModel, options?.model_tier);
    const max_tokens = options?.max_tokens ?? DEFAULT_MAX_TOKENS;
    const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    let system = options?.system;

    // before_model guardrail
    if (this.guardrailRunner) {
      const beforeResult = await this.guardrailRunner.run("before_model", {
        checkpoint: "before_model",
        input: { messages, options },
        metadata: {},
      });
      if (!beforeResult.allowed) {
        throw new Error(
          `Guardrail rejected: ${beforeResult.results.map((r) => r.reason).filter(Boolean).join("; ")}`
        );
      }
      if (beforeResult.modified_input) {
        const modified = beforeResult.modified_input as { messages?: LLMMessage[]; system?: string; options?: LLMRequestOptions };
        if (modified.messages) messages = modified.messages;
        if (modified.system) system = modified.system;
        if (modified.options) options = { ...options, ...modified.options };
      }
    }

    let lastError: unknown;
    let result: LLMResponse | undefined;
    let normalAttempts = 0;
    let rateLimitAttempts = 0;

    while (normalAttempts < MAX_RETRY_ATTEMPTS) {
      try {
        // Convert ToolDefinition[] to Anthropic SDK tool format
        const anthropicTools = options?.tools?.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: {
            type: "object" as const,
            ...t.function.parameters,
          },
        }));

        const response = await this.client.messages.create(
          {
            model,
            max_tokens,
            temperature,
            ...(system ? { system } : {}),
            ...(anthropicTools?.length ? { tools: anthropicTools } : {}),
            messages: messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
          },
          { timeout: DEFAULT_LLM_TIMEOUT_MS }
        );

        // Extract text content from response
        const textBlock = response.content.find((b) => b.type === "text");
        const content = textBlock && "text" in textBlock ? textBlock.text : "";

        // Extract tool_use blocks into ToolCallResult[]
        const toolUseBlocks = response.content.filter(
          (b) => b.type === "tool_use" && "id" in b && "name" in b && "input" in b
        );
        const tool_calls: ToolCallResult[] | undefined =
          toolUseBlocks.length > 0
            ? toolUseBlocks.map((b) => ({
                id: (b as { id: string }).id,
                function: {
                  name: (b as { name: string }).name,
                  arguments: JSON.stringify((b as { input: unknown }).input),
                },
              }))
            : undefined;

        result = {
          content,
          usage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
          },
          stop_reason: response.stop_reason ?? "unknown",
          ...(tool_calls ? { tool_calls } : {}),
        };
        break;
      } catch (err) {
        lastError = err;
        // Rate limit: retry with extended backoff (does not count against normalAttempts)
        if (isRateLimitError(err) && rateLimitAttempts < RATE_LIMIT_RETRY_DELAYS_MS.length) {
          await sleep(getRateLimitRetryDelay(err, rateLimitAttempts));
          rateLimitAttempts++;
          continue;
        }
        // Other 4xx client errors: throw immediately
        if (
          err instanceof Error &&
          "status" in err &&
          typeof err.status === "number" &&
          err.status >= 400 &&
          err.status < 500
        ) {
          throw err;
        }
        normalAttempts++;
        if (normalAttempts < MAX_RETRY_ATTEMPTS) {
          await sleep(RETRY_DELAYS_MS[normalAttempts - 1] ?? 1000);
        }
      }
    }

    if (result === undefined) {
      throw lastError;
    }

    // after_model guardrail
    if (this.guardrailRunner) {
      const afterResult = await this.guardrailRunner.run("after_model", {
        checkpoint: "after_model",
        input: { response: result, messages, options },
        metadata: {},
      });
      if (!afterResult.allowed) {
        throw new Error(
          `Guardrail rejected response: ${afterResult.results.map((r) => r.reason).filter(Boolean).join("; ")}`
        );
      }
      if (afterResult.modified_input !== undefined) {
        result = afterResult.modified_input as LLMResponse;
      }
    }

    return result;
  }

  /**
   * Low-level LLM call used by parseJSON retry logic.
   * Sends messages and returns the raw response text.
   */
  protected async callLLMRaw(messages: ParseJSONMessage[], systemPrompt?: string): Promise<string> {
    const llmMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    const response = await this.sendMessage(llmMessages, systemPrompt ? { system: systemPrompt } : undefined);
    return response.content;
  }
}

// ─── MockLLMClient ───

/**
 * Mock implementation for testing.
 * Returns provided responses in order, tracking call count.
 */
export class MockLLMClient extends BaseLLMClient implements ILLMClient {
  private readonly responses: (string | LLMResponse)[];
  private _callCount: number = 0;

  constructor(responses: (string | LLMResponse)[]) {
    super();
    this.responses = responses;
  }

  get callCount(): number {
    return this._callCount;
  }

  async sendMessage(
    _messages: LLMMessage[],
    _options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const index = this._callCount;
    this._callCount++;

    if (index >= this.responses.length) {
      throw new Error(
        `MockLLMClient: no response at index ${index} (only ${this.responses.length} responses configured)`
      );
    }

    const entry = this.responses[index]!;

    // If the entry is already an LLMResponse, return it directly
    if (typeof entry === "object") {
      return entry;
    }

    return {
      content: entry,
      usage: {
        input_tokens: 10,
        output_tokens: entry.length,
      },
      stop_reason: "end_turn",
    };
  }

  protected async callLLMRaw(_messages: ParseJSONMessage[], _systemPrompt?: string): Promise<string> {
    const response = await this.sendMessage([]);
    return response.content;
  }
}
