import type { ZodSchema } from "zod";
import { LLMError } from "../utils/errors.js";
import { sanitizeLLMJson } from "./json-sanitizer.js";

// ─── Model tier type ───

/** Selects which model to use for a given LLM call. Defaults to 'main'. */
export type ModelTier = "main" | "light";

// ─── Shared constants ───

export const DEFAULT_MAX_TOKENS = 4096;

/** Default LLM request timeout in milliseconds */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

/** Maximum number of retry attempts on transient errors */
export const MAX_RETRY_ATTEMPTS = 3;

/** Exponential backoff delays in milliseconds: 1s, 2s, 4s */
export const RETRY_DELAYS_MS = [1000, 2000, 4000];

// ─── JSON extraction utility ───

/**
 * Extract JSON from a string that may contain markdown code blocks or prose.
 *
 * Strategies (first match wins):
 * 1. Fast path — already valid JSON, return as-is
 * 2. Code fence extraction — ```json ... ``` or ``` ... ```
 * 3. Brace matching — find first { or [ and last matching } or ]
 */
export function extractJSON(text: string): string {
  const trimmed = text.trim();

  // 1. Fast path: already valid JSON
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // not bare JSON, continue
  }

  // 2. Code fence extraction
  const jsonBlock = trimmed.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlock) {
    return jsonBlock[1].trim();
  }
  const genericBlock = trimmed.match(/```\s*([\s\S]*?)```/);
  if (genericBlock) {
    return genericBlock[1].trim();
  }

  // 3. Depth-aware brace matching: scan from first { or [ to its matching close
  const firstBrace = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");
  let start = -1;
  let openChar: "{" | "[";
  let closeChar: "}" | "]";

  if (firstBrace === -1 && firstBracket === -1) {
    return trimmed;
  } else if (firstBrace === -1 || (firstBracket !== -1 && firstBracket < firstBrace)) {
    start = firstBracket;
    openChar = "[";
    closeChar = "]";
  } else {
    start = firstBrace;
    openChar = "{";
    closeChar = "}";
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) { depth++; }
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
  }

  return trimmed;
}

// ─── ParseJSON options ───

export interface ParseJSONMessage {
  role: string;
  content: string;
}

/** Options for parseJSON(). Pass `retry` to enable a single re-prompt on failure. */
export interface ParseJSONOptions {
  retry?: {
    /** Original messages used to produce the first LLM response. */
    messages: ParseJSONMessage[];
    /** Optional system prompt for the retry call. */
    systemPrompt?: string;
  };
}

// ─── BaseLLMClient ───

/**
 * Abstract base for all LLM clients.
 * Provides a shared parseJSON() implementation with safeParse-based validation,
 * and model-tier routing (main vs light model selection).
 */
export abstract class BaseLLMClient {
  /** Optional light model for routine tasks. Set by subclasses via constructor. */
  protected lightModel?: string;

  /**
   * Resolve the effective model name based on model_tier and configured light_model.
   * When model_tier is 'light' and lightModel is set, returns lightModel.
   * Otherwise returns the default model passed in. Ensures backward compatibility
   * when light_model is not configured.
   */
  protected resolveEffectiveModel(defaultModel: string, tier?: ModelTier): string {
    const effectiveModel = (tier === "light" && this.lightModel)
      ? this.lightModel
      : defaultModel;
    return effectiveModel;
  }

  /**
   * Send messages to the LLM and return the response text.
   * Used internally by parseJSON retry logic.
   * Subclasses that support retry must override this method.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async callLLMRaw(_messages: ParseJSONMessage[], _systemPrompt?: string): Promise<string> {
    throw new LLMError("callLLMRaw not implemented — override in subclass to enable parseJSON retry");
  }

  /**
   * Attempt to parse and validate a single content string against the schema.
   * Returns the parsed value on success, or throws LLMError on failure.
   */
  private attemptParse<T>(content: string, schema: ZodSchema<T>): T {
    const jsonText = sanitizeLLMJson(extractJSON(content));
    let raw: unknown;
    try {
      raw = JSON.parse(jsonText);
    } catch (err) {
      const msg = `LLM response JSON parse failed — ${String(err)}`;
      console.warn(`[parseJSON] ${msg} | raw(200): ${content.slice(0, 200)}`);
      throw new LLMError(`${msg}\nContent: ${content}`);
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.message).join(", ");
      const msg = `LLM response validation failed: ${issues}`;
      console.warn(`[parseJSON] ${msg} | raw(200): ${JSON.stringify(raw).slice(0, 200)}`);
      throw new LLMError(`${msg}. Raw: ${JSON.stringify(raw).slice(0, 200)}`);
    }
    return result.data;
  }

  /**
   * Extract JSON from LLM response text (handles markdown code blocks)
   * and validate against the given Zod schema.
   * Throws on parse failure or schema validation failure with detailed messages.
   *
   * When `options.retry` is provided, a single retry is attempted on first failure:
   * the original messages are re-sent with an error feedback message appended.
   */
  async parseJSON<T>(content: string, schema: ZodSchema<T>, options?: ParseJSONOptions): Promise<T>;
  parseJSON<T>(content: string, schema: ZodSchema<T>): T;
  parseJSON<T>(content: string, schema: ZodSchema<T>, options?: ParseJSONOptions): T | Promise<T> {
    if (!options?.retry) {
      return this.attemptParse(content, schema);
    }

    // Async path: retry enabled
    return (async () => {
      let firstError: LLMError;
      try {
        return this.attemptParse(content, schema);
      } catch (err) {
        firstError = err as LLMError;
      }

      console.warn(`[parseJSON] first attempt failed, retrying... Error: ${firstError.message}`);

      const retryMessages: ParseJSONMessage[] = [
        ...options.retry!.messages,
        {
          role: "user",
          content: `Your previous response was not valid JSON. Error: ${firstError.message}. Please respond with ONLY valid JSON matching the required schema, no other text.`,
        },
      ];

      const retryContent = await this.callLLMRaw(retryMessages, options.retry!.systemPrompt);

      try {
        return this.attemptParse(retryContent, schema);
      } catch (err) {
        console.warn(`[parseJSON] retry also failed`);
        throw err as LLMError;
      }
    })();
  }
}
