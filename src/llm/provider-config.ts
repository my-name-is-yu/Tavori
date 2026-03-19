// ─── Provider Configuration ───
//
// Pluggable provider configuration system for Motiva.
// Reads/writes ~/.motiva/provider.json to configure which LLM provider
// and default adapter to use. Env vars always take precedence over config file.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getMotivaDirPath } from "../utils/paths.js";

// ─── Types ───

export interface ProviderConfig {
  /** Which provider to use for internal LLM calls (thinking/analysis) */
  llm_provider: "anthropic" | "openai" | "ollama" | "codex";

  /** Which adapter to use by default for task execution */
  default_adapter: "claude_code_cli" | "claude_api" | "openai_codex_cli" | "openai_api";

  /** Provider-specific settings (optional; env vars take precedence) */
  anthropic?: {
    api_key?: string;
    model?: string;
  };
  openai?: {
    api_key?: string;
    model?: string;
    base_url?: string;
  };
  ollama?: {
    base_url?: string;
    model?: string;
  };
  codex?: {
    cli_path?: string;
    model?: string;
  };
}

// ─── Constants ───

const PROVIDER_CONFIG_PATH = path.join(getMotivaDirPath(), "provider.json");

const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  llm_provider: "codex",
  default_adapter: "openai_codex_cli",
};

// ─── Helpers ───

/**
 * Determine LLM provider, with env var taking precedence over config file.
 */
function resolveProvider(
  fileProvider: ProviderConfig["llm_provider"] | undefined
): ProviderConfig["llm_provider"] {
  const envProvider = process.env["MOTIVA_LLM_PROVIDER"];
  if (envProvider === "anthropic" || envProvider === "openai" || envProvider === "ollama" || envProvider === "codex") {
    return envProvider;
  }
  return fileProvider ?? "codex";
}

/**
 * Determine default adapter, with env var taking precedence over config file.
 */
function resolveAdapter(
  fileAdapter: ProviderConfig["default_adapter"] | undefined
): ProviderConfig["default_adapter"] {
  const envAdapter = process.env["MOTIVA_DEFAULT_ADAPTER"];
  if (
    envAdapter === "claude_code_cli" ||
    envAdapter === "claude_api" ||
    envAdapter === "openai_codex_cli" ||
    envAdapter === "openai_api"
  ) {
    return envAdapter;
  }
  return fileAdapter ?? "openai_codex_cli";
}

// ─── Public API ───

/**
 * Load provider configuration.
 *
 * Priority (highest to lowest):
 *   1. Environment variables (MOTIVA_LLM_PROVIDER, MOTIVA_DEFAULT_ADAPTER, etc.)
 *   2. ~/.motiva/provider.json
 *   3. Defaults (codex + openai_codex_cli)
 *
 * If no provider.json exists, falls back to env vars and defaults (current behavior).
 */
export async function loadProviderConfig(): Promise<ProviderConfig> {
  let fileConfig: Partial<ProviderConfig> = {};

  try {
    await fsp.access(PROVIDER_CONFIG_PATH);
    try {
      const raw = await fsp.readFile(PROVIDER_CONFIG_PATH, "utf-8");
      fileConfig = JSON.parse(raw) as Partial<ProviderConfig>;
    } catch {
      // If the file is malformed, treat it as empty (fall back to env/defaults)
      fileConfig = {};
    }
  } catch {
    // File does not exist — use env/defaults
  }

  // Build merged config: file values as base, env vars override
  const config: ProviderConfig = {
    llm_provider: resolveProvider(fileConfig.llm_provider),
    default_adapter: resolveAdapter(fileConfig.default_adapter),
  };

  // Merge anthropic section — env vars override file values
  const anthropicApiKey = process.env["ANTHROPIC_API_KEY"] ?? fileConfig.anthropic?.api_key;
  const anthropicModel = process.env["ANTHROPIC_MODEL"] ?? fileConfig.anthropic?.model;
  if (anthropicApiKey !== undefined || anthropicModel !== undefined) {
    config.anthropic = {
      ...(fileConfig.anthropic ?? {}),
      ...(anthropicApiKey !== undefined ? { api_key: anthropicApiKey } : {}),
      ...(anthropicModel !== undefined ? { model: anthropicModel } : {}),
    };
  } else if (fileConfig.anthropic) {
    config.anthropic = fileConfig.anthropic;
  }

  // Merge openai section — env vars override file values
  const openaiApiKey = process.env["OPENAI_API_KEY"] ?? fileConfig.openai?.api_key;
  const openaiModel = process.env["OPENAI_MODEL"] ?? fileConfig.openai?.model;
  const openaiBaseUrl = process.env["OPENAI_BASE_URL"] ?? fileConfig.openai?.base_url;
  if (openaiApiKey !== undefined || openaiModel !== undefined || openaiBaseUrl !== undefined) {
    config.openai = {
      ...(fileConfig.openai ?? {}),
      ...(openaiApiKey !== undefined ? { api_key: openaiApiKey } : {}),
      ...(openaiModel !== undefined ? { model: openaiModel } : {}),
      ...(openaiBaseUrl !== undefined ? { base_url: openaiBaseUrl } : {}),
    };
  } else if (fileConfig.openai) {
    config.openai = fileConfig.openai;
  }

  // Merge ollama section — env vars override file values
  const ollamaBaseUrl = process.env["OLLAMA_BASE_URL"] ?? fileConfig.ollama?.base_url;
  const ollamaModel = process.env["OLLAMA_MODEL"] ?? fileConfig.ollama?.model;
  if (ollamaBaseUrl !== undefined || ollamaModel !== undefined) {
    config.ollama = {
      ...(fileConfig.ollama ?? {}),
      ...(ollamaBaseUrl !== undefined ? { base_url: ollamaBaseUrl } : {}),
      ...(ollamaModel !== undefined ? { model: ollamaModel } : {}),
    };
  } else if (fileConfig.ollama) {
    config.ollama = fileConfig.ollama;
  }

  // Merge codex section — env vars override file values
  const codexModel = process.env["OPENAI_MODEL"] ?? fileConfig.codex?.model;
  if (fileConfig.codex || codexModel !== undefined) {
    config.codex = {
      ...(fileConfig.codex ?? {}),
      ...(codexModel !== undefined ? { model: codexModel } : {}),
    };
  }

  return config;
}

/**
 * Save provider configuration to ~/.motiva/provider.json.
 * Creates the ~/.motiva directory if it does not exist.
 */
export async function saveProviderConfig(config: ProviderConfig): Promise<void> {
  const motivaDir = getMotivaDirPath();
  await fsp.mkdir(motivaDir, { recursive: true });
  await fsp.writeFile(PROVIDER_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// Re-export default for tests that need it
export { DEFAULT_PROVIDER_CONFIG };
