import type { ZodSchema } from "zod";
import { LLMError } from "../utils/errors.js";

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
 * Extract JSON from a string that may contain markdown code blocks.
 * Tries ```json ... ``` first, then ``` ... ```, then bare JSON.
 */
export function extractJSON(text: string): string {
  const jsonBlock = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlock) {
    return jsonBlock[1].trim();
  }
  const genericBlock = text.match(/```\s*([\s\S]*?)```/);
  if (genericBlock) {
    return genericBlock[1].trim();
  }
  return text.trim();
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
  * Extract JSON from LLM response text (handles markdown code blocks)
  * and validate against the given Zod schema.
  * Throws on parse failure or schema validation failure with detailed messages.
  */
  parseJSON<T>(content: string, schema: ZodSchema<T>): T {
    const jsonText = extractJSON(content);
    let raw: unknown;
    try {
      raw = JSON.parse(jsonText);
    } catch (err) {
      throw new LLMError(
        `LLM response JSON parse failed — ${String(err)}\nContent: ${content}`
      );
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new LLMError(
        `LLM response validation failed: ${result.error.issues.map((i) => i.message).join(", ")}. ` +
          `Raw: ${JSON.stringify(raw).slice(0, 200)}`
      );
    }
    return result.data;
  }
}
