// ─── pulseed setup — Shared constants, types, and helpers ───
//
// Extracted from commands/setup.ts for reuse by current and future setup wizards.

export { MODEL_REGISTRY } from "../../../base/llm/provider-config.js";
import { MODEL_REGISTRY } from "../../../base/llm/provider-config.js";

// ─── Provider / Model / Adapter lists ───

export const PROVIDERS = ["openai", "anthropic", "ollama"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama (local)",
};

export const ENV_KEY_NAMES: Partial<Record<Provider, string>> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export const RECOMMENDED_MODELS: Record<string, string> = {
  openai: "gpt-5.4-mini",
  anthropic: "claude-sonnet-4-6",
  ollama: "qwen3:4b",
};

export const RECOMMENDED_ADAPTERS: Partial<Record<Provider, string>> = {
  openai: "agent_loop",
  anthropic: "agent_loop",
  ollama: "agent_loop",
};

// ─── Shared helper functions ───

/**
 * Checks which provider API keys are present in the environment.
 */
export function detectApiKeys(): Record<string, boolean> {
  return {
    openai: !!process.env["OPENAI_API_KEY"],
    anthropic: !!process.env["ANTHROPIC_API_KEY"],
  };
}

/**
 * Returns all model names in MODEL_REGISTRY that belong to the given provider.
 */
export function getModelsForProvider(provider: string): string[] {
  return Object.entries(MODEL_REGISTRY)
    .filter(([, info]) => info.provider === provider)
    .map(([name]) => name);
}

/**
 * Returns compatible adapters for a given model and provider.
 * Falls back to provider-level defaults for custom/unknown models.
 */
export function getAdaptersForModel(model: string, provider: string): string[] {
  const entry = MODEL_REGISTRY[model];
  if (entry) return entry.adapters;
  // For unknown/custom models, return all adapters for the provider
  if (provider === "openai") return ["agent_loop", "openai_codex_cli", "openai_api"];
  if (provider === "anthropic") return ["agent_loop", "claude_code_cli", "claude_api"];
  if (provider === "ollama") return ["agent_loop", "openai_api"];
  return [];
}

/**
 * Masks an API key for display, showing only the first and last 4 characters.
 */
export function maskKey(key: string | undefined): string {
  if (!key) return "(not set)";
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "..." + key.slice(-4);
}
