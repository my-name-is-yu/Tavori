import OpenAI from "openai";
import type { ZodSchema } from "zod";
import { extractJSON, type ILLMClient, type LLMMessage, type LLMRequestOptions, type LLMResponse } from "./llm-client.js";

// ─── Constants ───

const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;
const MAX_RETRY_ATTEMPTS = 3;

/** Exponential backoff delays in milliseconds: 1s, 2s, 4s */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

/** Model prefixes that do not support the temperature parameter */
const REASONING_MODEL_PREFIXES = ["o1", "o3", "o4"];

// ─── Helpers ───

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isReasoningModel(model: string): boolean {
  return REASONING_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

// ─── OpenAILLMClient ───

export interface OpenAIClientConfig {
  /** Falls back to OPENAI_API_KEY env var if not provided */
  apiKey?: string;
  /** Default: "gpt-4o" */
  model?: string;
  /** Optional base URL for Azure OpenAI or proxy endpoints */
  baseURL?: string;
}

/**
 * LLM client for OpenAI's chat completions API.
 * Uses the official `openai` npm SDK.
 *
 * Set MOTIVA_LLM_PROVIDER=openai to activate via CLIRunner.
 * Optionally set OPENAI_API_KEY, OPENAI_MODEL, and OPENAI_BASE_URL to configure.
 */
export class OpenAILLMClient implements ILLMClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: OpenAIClientConfig = {}) {
    const apiKey = config.apiKey ?? process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "OpenAILLMClient: no API key provided. Pass apiKey to constructor or set OPENAI_API_KEY env var."
      );
    }
    this.model = config.model ?? DEFAULT_MODEL;
    this.client = new OpenAI({
      apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
  }

  /**
   * Send a message to the OpenAI chat completions API with retry logic.
   * Retries up to MAX_RETRY_ATTEMPTS times with exponential backoff on network errors.
   *
   * For reasoning models (o1, o3, o4), temperature is omitted as it is not supported.
   * System prompt is sent as a "developer" role message, prepended to the messages array.
   */
  async sendMessage(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const model = options?.model ?? this.model;
    const max_tokens = options?.max_tokens ?? DEFAULT_MAX_TOKENS;
    const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    const system = options?.system;

    // Build OpenAI messages array
    const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (system) {
      openAiMessages.push({ role: "developer" as const, content: system });
    }
    for (const msg of messages) {
      openAiMessages.push({ role: msg.role, content: msg.content });
    }

    // Reasoning models do not accept the temperature parameter
    const createParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages: openAiMessages,
      max_tokens,
      ...(isReasoningModel(model) ? {} : { temperature }),
    };

    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const response = await this.client.chat.completions.create(createParams);

        const choice = response.choices[0];
        const content = choice?.message.content ?? "";
        const stop_reason = choice?.finish_reason ?? "unknown";

        return {
          content,
          usage: {
            input_tokens: response.usage?.prompt_tokens ?? 0,
            output_tokens: response.usage?.completion_tokens ?? 0,
          },
          stop_reason,
        };
      } catch (err) {
        lastError = err;
        // Only retry on network/transient errors, not on HTTP 4xx client errors
        const isNetworkError =
          err instanceof TypeError ||
          (err instanceof Error &&
            !err.message.startsWith("OpenAILLMClient: HTTP 4"));

        if (attempt < MAX_RETRY_ATTEMPTS - 1 && isNetworkError) {
          await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
        } else if (!isNetworkError) {
          throw err;
        }
      }
    }

    throw lastError;
  }

  /**
   * Extract JSON from LLM response text (handles markdown code blocks)
   * and validate against the given Zod schema.
   * Throws on parse failure or schema validation failure.
   */
  parseJSON<T>(content: string, schema: ZodSchema<T>): T {
    const jsonText = extractJSON(content);
    let raw: unknown;
    try {
      raw = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(
        `OpenAILLMClient.parseJSON: failed to parse JSON — ${String(err)}\nContent: ${content}`
      );
    }
    return schema.parse(raw);
  }
}
