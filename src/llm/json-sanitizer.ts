/**
 * json-sanitizer.ts — Shared LLM JSON response sanitization utilities.
 *
 * Centralizes all sanitization logic so it can be applied consistently
 * before JSON.parse() and Zod validation.
 */

// ─── Threshold type sanitizer ───

const THRESHOLD_TYPE_MAP: Record<string, string> = {
  exact: "match",
  scale: "min",
  qualitative: "min",
  boolean: "present",
  percentage: "min",
  count: "min",
};

const VALID_THRESHOLD_TYPES = new Set(["min", "max", "range", "present", "match"]);

/**
 * Sanitizes LLM-returned threshold_type strings to valid enum values.
 * Handles the union of all known non-standard values from both
 * GoalRefiner (leaf test) and GoalTreeManager (subgoal decomposition).
 *
 * Uses regex replacement so it works on raw JSON strings before parsing.
 */
export function sanitizeThresholdTypes(raw: string): string {
  return raw.replace(
    /"threshold_type"\s*:\s*"([^"]+)"/g,
    (_match: string, val: string) => {
      if (VALID_THRESHOLD_TYPES.has(val)) return `"threshold_type": "${val}"`;
      const mapped = THRESHOLD_TYPE_MAP[val] ?? "min";
      return `"threshold_type": "${mapped}"`;
    }
  );
}

/**
 * Sanitizes LLM-returned threshold_value when threshold_type is "present".
 * When the LLM returns an object (e.g. `{"type":"present"}`) as the value for
 * a present threshold, replace it with null so downstream Zod schemas accept it.
 *
 * Operates on the raw JSON string before parsing to avoid any type-safety issues
 * with the un-parsed LLM output.
 */
export function sanitizeThresholdValues(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    const sanitized = sanitizePresentThresholdValues(parsed);
    return JSON.stringify(sanitized);
  } catch (err) {
    // JSON is not yet valid — syntactic fixups haven't fully resolved. This is expected
    // when sanitizeThresholdValues runs as part of the sanitizeLLMJson pipeline.
    console.debug("[sanitizeThresholdValues] JSON not yet parseable, skipping threshold cleanup");
    void err;
    return raw;
  }
}

function sanitizePresentThresholdValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizePresentThresholdValues);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      result[k] = sanitizePresentThresholdValues(v);
    }
    // If this object has threshold_type === "present" and threshold_value is an object, null it out.
    if (
      result["threshold_type"] === "present" &&
      typeof result["threshold_value"] === "object" &&
      result["threshold_value"] !== null
    ) {
      result["threshold_value"] = null;
    }
    return result;
  }
  return value;
}

// ─── Common LLM drift pattern sanitizers ───

/**
 * Removes trailing commas before `}` or `]` — a common LLM formatting mistake.
 * e.g. `{"a": 1,}` → `{"a": 1}`
 */
function removeTrailingCommas(raw: string): string {
  return raw.replace(/,\s*([}\]])/g, "$1");
}

/**
 * Replaces JSON-invalid numeric literals produced by LLMs with null.
 * Handles: NaN, Infinity, -Infinity (all unquoted).
 */
function replaceInvalidNumbers(raw: string): string {
  return raw
    .replace(/\bNaN\b/g, "null")
    .replace(/-Infinity\b/g, "null")
    .replace(/\bInfinity\b/g, "null");
}

// ─── Main entry point ───

/**
 * Applies all LLM JSON sanitizers in sequence.
 *
 * Order:
 *   1. Remove trailing commas (syntactic fix — must come before JSON.parse attempts)
 *   2. Replace NaN/Infinity with null (syntactic fix)
 *   3. Sanitize threshold_type enum values (domain-specific string replacement)
 *   4. Sanitize threshold_value for "present" thresholds (requires parse+reserialize)
 */
export function sanitizeLLMJson(raw: string): string {
  let result = raw;
  result = removeTrailingCommas(result);
  result = replaceInvalidNumbers(result);
  result = sanitizeThresholdTypes(result);
  result = sanitizeThresholdValues(result);
  return result;
}
