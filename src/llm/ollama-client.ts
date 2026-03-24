import { BaseLLMClient, DEFAULT_MAX_TOKENS, DEFAULT_LLM_TIMEOUT_MS, MAX_RETRY_ATTEMPTS, RETRY_DELAYS_MS } from "./base-llm-client.js";
import { type ILLMClient, type LLMMessage, type LLMRequestOptions, type LLMResponse } from "./llm-client.js";
import { sleep } from "../utils/sleep.js";
import { LLMError } from "../utils/errors.js";

// ─── Constants ───

const DEFAULT_MODEL = "qwen3:4b";
const DEFAULT_TEMPERATURE = 0;

// ─── OllamaLLMClient ───

export interface OllamaClientConfig {
  baseUrl: string;
  model?: string;
  /** Optional lighter model for routine tasks */
  lightModel?: string;
}

/**
 * LLM client for Ollama's OpenAI-compatible API.
 * Uses native fetch (Node 18+) — no extra dependencies.
 *
 * Set TAVORI_LLM_PROVIDER=ollama to activate via CLIRunner.
 * Optionally set OLLAMA_BASE_URL and OLLAMA_MODEL to configure.
 */
export class OllamaLLMClient extends BaseLLMClient implements ILLMClient {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(config: OllamaClientConfig) {
    super();
    this.baseUrl = config.baseUrl.replace(/\/$/, ""); // strip trailing slash
    this.model = config.model ?? DEFAULT_MODEL;
    this.lightModel = config.lightModel;
  }

  /**
   * Send a message to Ollama's OpenAI-compatible chat completions endpoint.
   * Retries up to MAX_RETRY_ATTEMPTS times with exponential backoff on network errors.
   */
  async sendMessage(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const model = this.resolveEffectiveModel(options?.model ?? this.model, options?.model_tier);
    const max_tokens = options?.max_tokens ?? DEFAULT_MAX_TOKENS;
    const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    const system = options?.system;

    // Build OpenAI-format messages array
    const openAiMessages: Array<{ role: string; content: string }> = [];
    if (system) {
      openAiMessages.push({ role: "system", content: system });
    }
    for (const msg of messages) {
      openAiMessages.push({ role: msg.role, content: msg.content });
    }

    const body = JSON.stringify({
      model,
      messages: openAiMessages,
      max_tokens,
      temperature,
      stream: false,
    });

    const url = `${this.baseUrl}/v1/chat/completions`;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), DEFAULT_LLM_TIMEOUT_MS);
        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => "(no body)");
          throw new LLMError(
            `OllamaLLMClient: HTTP ${response.status} ${response.statusText} — ${errorText}`
          );
        }

        const data = (await response.json()) as {
          choices?: Array<{
            message?: { content?: string };
            finish_reason?: string;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
          };
        };

        const choice = data.choices?.[0];
        const content = choice?.message?.content ?? "";
        const stop_reason = choice?.finish_reason ?? "unknown";

        return {
          content,
          usage: {
            input_tokens: data.usage?.prompt_tokens ?? 0,
            output_tokens: data.usage?.completion_tokens ?? 0,
          },
          stop_reason,
        };
      } catch (err) {
        lastError = err;
        // Only retry on network/fetch errors, not on HTTP 4xx client errors
        const isNetworkError =
          err instanceof TypeError ||
          (err instanceof Error &&
            !err.message.startsWith("OllamaLLMClient: HTTP 4"));

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
