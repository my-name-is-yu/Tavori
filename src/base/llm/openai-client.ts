import OpenAI from "openai";
import { BaseLLMClient, DEFAULT_MAX_TOKENS, DEFAULT_LLM_TIMEOUT_MS, MAX_RETRY_ATTEMPTS, RETRY_DELAYS_MS, RATE_LIMIT_RETRY_DELAYS_MS, isRateLimitError, getRateLimitRetryDelay } from "./base-llm-client.js";
import { type ILLMClient, type LLMMessage, type LLMRequestOptions, type LLMResponse, type LLMStreamHandlers, type ToolCallResult } from "./llm-client.js";
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

function shouldFallbackToResponses(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("not a chat model") ||
    msg.includes("v1/chat/completions") ||
    msg.includes("Did you mean to use v1/completions")
  );
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
 * Set PULSEED_LLM_PROVIDER=openai to activate via CLIRunner.
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
   * Retries up to RATE_LIMIT_RETRY_DELAYS_MS.length times on HTTP 429 with extended backoff.
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
      ...(options?.tools?.length
        ? {
            tools: options.tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters as OpenAI.FunctionParameters,
              },
            })),
          }
        : {}),
      ...(isReasoningModel(model) ? {} : { temperature }),
    };

    let lastError: unknown;
    let normalAttempts = 0;
    let rateLimitAttempts = 0;

    while (normalAttempts < MAX_RETRY_ATTEMPTS) {
      try {
        try {
          const response = await this.client.chat.completions.create(createParams, { timeout: DEFAULT_LLM_TIMEOUT_MS });

          const choice = response.choices[0];
          const content = choice?.message.content ?? "";
          const stop_reason = choice?.finish_reason ?? "unknown";
          const tool_calls = mapOpenAIToolCalls(choice?.message.tool_calls);

          return {
            content,
            usage: {
              input_tokens: response.usage?.prompt_tokens ?? 0,
              output_tokens: response.usage?.completion_tokens ?? 0,
            },
            stop_reason,
            ...(tool_calls && tool_calls.length > 0 ? { tool_calls } : {}),
          };
        } catch (err) {
          // Some models (notably Codex-style) are not compatible with the
          // chat completions endpoint. In that case, fall back to Responses API.
          if (!shouldFallbackToResponses(err)) throw err;
          return this.sendViaResponsesApi(model, messages, { max_tokens, temperature, system });
        }
      } catch (err) {
        lastError = err;
        // Rate limit: retry with extended backoff (does not count against normalAttempts)
        if (isRateLimitError(err) && rateLimitAttempts < RATE_LIMIT_RETRY_DELAYS_MS.length) {
          await sleep(getRateLimitRetryDelay(err, rateLimitAttempts));
          rateLimitAttempts++;
          continue;
        }
        // Only retry on network/transient errors, not on HTTP 4xx client errors (excluding 429)
        const isNetworkError =
          err instanceof TypeError ||
          (err instanceof Error &&
            !err.message.startsWith("OpenAILLMClient: HTTP 4"));

        normalAttempts++;
        if (normalAttempts < MAX_RETRY_ATTEMPTS && isNetworkError) {
          await sleep(RETRY_DELAYS_MS[normalAttempts - 1] ?? 1000);
        } else if (!isNetworkError) {
          throw err;
        }
      }
    }

    throw lastError;
  }

  async sendMessageStream(
    messages: LLMMessage[],
    options: LLMRequestOptions | undefined,
    handlers: LLMStreamHandlers
  ): Promise<LLMResponse> {
    const model = this.resolveEffectiveModel(options?.model ?? this.model, options?.model_tier);
    const max_tokens = options?.max_tokens ?? DEFAULT_MAX_TOKENS;
    const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    const system = options?.system;

    const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (system) {
      openAiMessages.push({ role: "developer" as const, content: system });
    }
    for (const msg of messages) {
      openAiMessages.push({ role: msg.role, content: msg.content });
    }

    const createParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model,
      messages: openAiMessages,
      max_completion_tokens: max_tokens,
      stream: true,
      ...(options?.tools?.length
        ? {
            tools: options.tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters as OpenAI.FunctionParameters,
              },
            })),
          }
        : {}),
      ...(isReasoningModel(model) ? {} : { temperature }),
    };

    try {
      const stream = this.client.chat.completions.stream(createParams, { timeout: DEFAULT_LLM_TIMEOUT_MS });
      stream.on("content", (delta: string) => {
        handlers.onTextDelta?.(delta);
      });

      const [completion, message] = await Promise.all([
        stream.finalChatCompletion(),
        stream.finalMessage(),
      ]);

      const tool_calls = mapOpenAIToolCalls(message.tool_calls);

      return {
        content: message.content ?? "",
        usage: {
          input_tokens: completion.usage?.prompt_tokens ?? 0,
          output_tokens: completion.usage?.completion_tokens ?? 0,
        },
        stop_reason: completion.choices[0]?.finish_reason ?? "unknown",
        ...(tool_calls.length > 0 ? { tool_calls } : {}),
      };
    } catch (err) {
      if (!shouldFallbackToResponses(err)) throw err;
      return this.sendViaResponsesApi(model, messages, { max_tokens, temperature, system });
    }
  }

  private async sendViaResponsesApi(
    model: string,
    messages: LLMMessage[],
    options: { max_tokens: number; temperature: number; system?: string }
  ): Promise<LLMResponse> {
    const input = [
      options.system ? `SYSTEM:\n${options.system}` : null,
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
        max_output_tokens: options.max_tokens,
        ...(isReasoningModel(model) ? {} : { temperature: options.temperature }),
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
}

function mapOpenAIToolCalls(
  toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] | undefined
): ToolCallResult[] {
  if (!toolCalls?.length) return [];
  return toolCalls
    .filter((call): call is OpenAI.Chat.ChatCompletionMessageFunctionToolCall =>
      !("type" in call) || call.type === "function"
    )
    .map((call) => ({
      id: call.id,
      type: "function" as const,
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    }));
}
