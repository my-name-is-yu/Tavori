// ─── API Key Guard ───
//
// Shared helper used by CLI/TUI entry points to validate that the active
// LLM provider has the required API key configured before starting work.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as tty from "node:tty";
import { loadProviderConfig, type ProviderConfig } from "../llm/provider-config.js";
import { getPulseedDirPath } from "../utils/paths.js";

/**
 * Load provider config and verify that the required API key is present for
 * the configured provider. Throws if a required key is missing.
 *
 * If no ~/.pulseed/provider.json exists and stdin is a TTY, automatically
 * runs the interactive setup wizard. If not a TTY, uses defaults silently.
 *
 * Ollama provider is not checked here — it needs no API key.
 * OpenAI provider is validated by buildLLMClient() when the client is constructed.
 * Only the Anthropic provider requires an early check because historical
 * CLI code read ANTHROPIC_API_KEY before constructing any client.
 *
 * Returns the loaded ProviderConfig so callers don't need to load it again.
 */
export async function ensureProviderConfig(): Promise<ProviderConfig> {
  // Check if config file exists — if not and TTY, run setup wizard
  const configPath = path.join(getPulseedDirPath(), "provider.json");
  let configExists = false;
  try {
    await fsp.access(configPath);
    configExists = true;
  } catch {
    // File does not exist
  }

  if (!configExists && tty.isatty(0)) {
    console.log("No provider configuration found. Starting setup wizard...\n");
    const { cmdSetup } = await import("./commands/setup.js");
    const result = await cmdSetup([]);
    if (result !== 0) {
      throw new Error(
        "Setup wizard failed. Run `pulseed setup` manually to configure your provider."
      );
    }
  }

  const config = await loadProviderConfig();

  // For the anthropic provider, api_key must be set.
  // Other providers handle their own key validation inside buildLLMClient().
  if (config.provider === "anthropic" && !config.api_key) {
    throw new Error(
      "No API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable, " +
        "or run: pulseed setup"
    );
  }

  return config;
}
