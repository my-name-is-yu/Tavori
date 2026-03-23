import Anthropic from "@anthropic-ai/sdk";
import type { ZodSchema } from "zod";
import { sleep } from "../utils/sleep.js";
import { BaseLLMClient, DEFAULT_MAX_TOKENS, extractJSON } from "./base-llm-client.js";
import { LLMError } from "../utils/errors.js";
import { GuardrailRunner } from "../guardrail-runner.js";

// ─── Inline Types ───

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMRequestOptions {
  model?: string;
  max_tokens?: number;
  system?: string;
  temperature?: number;
}

export interface LLMResponse {
  content: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  stop_reason: string;
}

// ─── Interface ───

export interface ILLMClient {
  sendMessage(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse>;
  parseJSON<T>(content: string, schema: ZodSchema<T>): T;
}

// ─── Constants ───

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_TEMPERATURE = 0;
const MAX_RETRY_ATTEMPTS = 3;

/** Exponential backoff delays in milliseconds: 1s, 2s, 4s */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

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

  constructor(apiKey: string, guardrailRunner?: GuardrailRunner) {
    super();
    if (!apiKey) {
      throw new LLMError(
        "LLMClient: no API key provided. Pass apiKey to constructor."
      );
    }
    this.client = new Anthropic({ apiKey });
    this.guardrailRunner = guardrailRunner;
  }

  /**
   * Send a message to the Anthropic API with retry logic.
   * Retries up to MAX_RETRY_ATTEMPTS times with exponential backoff.
   */
  async sendMessage(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const model = options?.model ?? DEFAULT_MODEL;
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

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const response = await this.client.messages.create({
          model,
          max_tokens,
          temperature,
          ...(system ? { system } : {}),
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        });

        const block = response.content[0];
        const content = block && block.type === "text" ? block.text : "";

        result = {
          content,
          usage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
          },
          stop_reason: response.stop_reason ?? "unknown",
        };
        break;
      } catch (err) {
        if (
          err instanceof Error &&
          "status" in err &&
          typeof err.status === "number" &&
          err.status >= 400 &&
          err.status < 500
        ) {
          throw err; // client error, no retry
        }
        lastError = err;
        if (attempt < MAX_RETRY_ATTEMPTS - 1) {
          await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
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
}

// ─── MockLLMClient ───

/**
 * Mock implementation for testing.
 * Returns provided responses in order, tracking call count.
 */
export class MockLLMClient extends BaseLLMClient implements ILLMClient {
  private readonly responses: string[];
  private _callCount: number = 0;

  constructor(responses: string[]) {
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

    const content = this.responses[index]!;

    return {
      content,
      usage: {
        input_tokens: 10,
        output_tokens: content.length,
      },
      stop_reason: "end_turn",
    };
  }
}
