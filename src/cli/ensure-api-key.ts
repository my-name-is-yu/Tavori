// ─── API Key Guard ───
//
// Shared helper used by CLI/TUI entry points to validate that the active
// LLM provider has the required API key configured before starting work.

import { loadProviderConfig, type ProviderConfig } from "../llm/provider-config.js";

/**
 * Load provider config and verify that the required API key is present for
 * the configured provider. Throws if a required key is missing.
 *
 * Ollama, OpenAI, and Codex providers are not checked here — they are
 * validated by buildLLMClient() when the client is actually constructed.
 * Only the Anthropic provider requires an early check because historical
 * CLI code read ANTHROPIC_API_KEY before constructing any client.
 *
 * Returns the loaded ProviderConfig so callers don't need to load it again.
 */
export async function ensureProviderConfig(): Promise<ProviderConfig> {
  const config = await loadProviderConfig();
  const provider = config.llm_provider;

  // For the anthropic provider, ANTHROPIC_API_KEY (or config file key) must be set.
  // Other providers handle their own key validation inside buildLLMClient().
  if (provider === "anthropic" && !config.anthropic?.api_key) {
    throw new Error(
      "No API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable, " +
        "or run: conatus config --provider <anthropic|openai>"
    );
  }

  return config;
}
