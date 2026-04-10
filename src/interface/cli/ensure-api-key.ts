// ─── API Key Guard ───
//
// Shared helper used by CLI/TUI entry points to validate that the active
// LLM provider has the required API key configured before starting work.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as tty from "node:tty";
import { loadProviderConfig, type ProviderConfig } from "../../base/llm/provider-config.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function inspectProviderConfig(configPath: string): Promise<
  | { exists: false }
  | { exists: true; validJson: true }
  | { exists: true; validJson: false }
> {
  try {
    await fsp.access(configPath);
  } catch {
    return { exists: false };
  }

  try {
    const raw = await fsp.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return { exists: true, validJson: isPlainObject(parsed) };
  } catch {
    return { exists: true, validJson: false };
  }
}

function formatMissingConfigError(configPath: string): string {
  return (
    `Error: no provider configuration found at ${configPath}. ` +
    "Run `pulseed setup` from an interactive terminal to create it."
  );
}

function formatInvalidConfigError(configPath: string): string {
  return (
    `Error: provider configuration at ${configPath} is invalid JSON. ` +
    "Run `pulseed setup` from an interactive terminal to regenerate it, " +
    "or fix/remove the file."
  );
}

async function runSetupWizardOrThrow(message: string): Promise<void> {
  console.log(message);
  const { cmdSetup } = await import("./commands/setup.js");
  const result = await cmdSetup([]);
  if (result !== 0) {
    throw new Error(
      "Setup wizard failed. Run `pulseed setup` manually to configure your provider."
    );
  }
}

export interface EnsureProviderConfigOptions {
  requireInteractiveSetup?: boolean;
}

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
export async function ensureProviderConfig(
  options: EnsureProviderConfigOptions = {}
): Promise<ProviderConfig> {
  const configPath = path.join(getPulseedDirPath(), "provider.json");
  const configState = await inspectProviderConfig(configPath);
  const stdinIsTty = tty.isatty(0);

  if (!configState.exists) {
    if (stdinIsTty) {
      await runSetupWizardOrThrow(
        "No provider configuration found. Starting setup wizard...\n"
      );
    } else if (options.requireInteractiveSetup) {
      throw new Error(formatMissingConfigError(configPath));
    }
  } else if (!configState.validJson && options.requireInteractiveSetup) {
    if (stdinIsTty) {
      await runSetupWizardOrThrow(
        "Provider configuration is invalid. Starting setup wizard...\n"
      );
    } else {
      throw new Error(formatInvalidConfigError(configPath));
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
