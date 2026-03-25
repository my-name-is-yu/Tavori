import OpenAI from "openai";
import { BaseLLMClient, DEFAULT_MAX_TOKENS, DEFAULT_LLM_TIMEOUT_MS, MAX_RETRY_ATTEMPTS, RETRY_DELAYS_MS } from "./base-llm-client.js";
import { type ILLMClient, type LLMMessage, type LLMRequestOptions, type LLMResponse } from "./llm-client.js";
import { sleep } from "../utils/sleep.js";
import { LLMError } from "../utils/errors.js";

// ─── Constants ───

const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_TEMPERATURE = 0.2;

/** Model prefixes that do not support the temperature parameter */
const REASONING_MODEL_PREFIXES = ["o1", "o3", "o4"];

function isReasoningModel(model: string): boolean {
  return REASONING_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

// ─── OpenAILLMClient ───

export interface OpenAIClientConfig {
  /** API key for OpenAI. Required. */
  apiKey?: string;
  /** Default: "gpt-4o" */
  model?: string;
  /** Optional base URL for Azure OpenAI or proxy endpoints */
  baseURL?: string;
  /** Optional lighter model for routine tasks (observation, verification, etc.) */
  lightModel?: string;
}

/**
 * LLM client for OpenAI.
 *
 * Primary path: Chat Completions API.
 * Fallback: Responses API when the selected model is not compatible with
 * /v1/chat/completions (e.g., some Codex-style models).
 *
 * Set SEEDPULSE_LLM_PROVIDER=openai to activate via CLIRunner.
 * Optionally set OPENAI_API_KEY, OPENAI_MODEL, and OPENAI_BASE_URL to configure.
 */
export class OpenAILLMClient extends BaseLLMClient implements ILLMClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: OpenAIClientConfig = {}) {
    super();
    if (!config.apiKey) {
      throw new LLMError(
        "OpenAILLMClient: no API key provided. Pass apiKey to constructor."
      );
    }
    this.model = config.model ?? DEFAULT_MODEL;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
    this.lightModel = config.lightModel;
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
    const model = this.resolveEffectiveModel(options?.model ?? this.model, options?.model_tier);
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
      max_completion_tokens: max_tokens,
      ...(isReasoningModel(model) ? {} : { temperature }),
    };

    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        try {
          const response = await this.client.chat.completions.create(createParams, { timeout: DEFAULT_LLM_TIMEOUT_MS });

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
          // Some models (notably Codex-style) are not compatible with the
          // chat completions endpoint. In that case, fall back to Responses API.
          const msg = err instanceof Error ? err.message : String(err);
          const shouldFallback =
            msg.includes("not a chat model") ||
            msg.includes("v1/chat/completions") ||
            msg.includes("Did you mean to use v1/completions");

          if (!shouldFallback) throw err;

          const input = [
            system ? `SYSTEM:\n${system}` : null,
            ...messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`),
          ]
            .filter(Boolean)
            .join("\n\n");

          // Use Responses API (SDK supports this as of openai v4+).
          // The TypeScript types for the Responses API are not yet in the openai
          // package typings, so we cast through unknown to access this endpoint.
          const responsesApi = (this.client as unknown as { responses: { create: (params: Record<string, unknown>) => Promise<unknown> } }).responses;
          let timer: ReturnType<typeof setTimeout>;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new LLMError(`OpenAILLMClient: Responses API timed out after ${DEFAULT_LLM_TIMEOUT_MS}ms`)),
              DEFAULT_LLM_TIMEOUT_MS
            );
          });
          const resp = await Promise.race([
            responsesApi.create({
              model,
              input,
              max_output_tokens: max_tokens,
              ...(isReasoningModel(model) ? {} : { temperature }),
            }),
            timeout,
          ]) as Record<string, unknown>;
          clearTimeout(timer!);

          const content =
            typeof resp["output_text"] === "string"
              ? resp["output_text"]
              : "";

          const usage = resp["usage"] as Record<string, unknown> | undefined;
          return {
            content,
            usage: {
              input_tokens: typeof usage?.["input_tokens"] === "number" ? usage["input_tokens"] : 0,
              output_tokens: typeof usage?.["output_tokens"] === "number" ? usage["output_tokens"] : 0,
            },
            stop_reason: typeof resp["status"] === "string" ? resp["status"] : "unknown",
          };
        }
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
}
