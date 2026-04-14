// ─── Provider Configuration ───
//
// Pluggable provider configuration system for PulSeed.
// Reads/writes ~/.pulseed/provider.json to configure which LLM provider
// and default adapter to use. Env vars always take precedence over config file.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { getPulseedDirPath } from "../utils/paths.js";
import { writeJsonFileAtomic } from "../utils/json-io.js";

// ─── OAuth Token Helpers ───

/** Check if a JWT access token is expired. Returns true if malformed or expired. */
export function isJwtExpired(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length < 3) return true; // not a JWT
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (typeof payload.exp !== "number") return true;
    return payload.exp < Math.floor(Date.now() / 1000);
  } catch {
    return true; // malformed → treat as expired
  }
}

/** Read the OAuth access_token from ~/.codex/auth.json (written by `codex auth login`). */
export async function readCodexOAuthToken(): Promise<string | undefined> {
  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  try {
    const raw = await fsp.readFile(authPath, "utf-8");
    const auth = JSON.parse(raw);
    const token = auth?.tokens?.access_token;
    if (typeof token !== "string" || !token) return undefined;
    if (isJwtExpired(token)) {
      console.warn("[provider-config] ~/.codex/auth.json token expired. Run `codex` to refresh.");
      return undefined;
    }
    return token;
  } catch {
    return undefined;
  }
}

// ─── Model Registry ───

/**
 * Known models and their compatible providers/adapters.
 * Ollama models are dynamic and not listed here.
 */
export const MODEL_REGISTRY: Record<string, { provider: string; adapters: string[] }> = {
  "gpt-5.4-mini": { provider: "openai", adapters: ["openai_codex_cli", "openai_api", "agent_loop"] },
  "gpt-4.1": { provider: "openai", adapters: ["openai_codex_cli", "openai_api", "agent_loop"] },
  "gpt-4o-mini": { provider: "openai", adapters: ["openai_api", "agent_loop"] },
  "o3-mini": { provider: "openai", adapters: ["openai_api", "agent_loop"] },
  "claude-sonnet-4-6": { provider: "anthropic", adapters: ["claude_code_cli", "claude_api", "agent_loop"] },
  "claude-haiku-4-5": { provider: "anthropic", adapters: ["claude_code_cli", "claude_api", "agent_loop"] },
};

// ─── Types ───

export interface ProviderConfig {
  /** Which provider to use for internal LLM calls */
  provider: "openai" | "anthropic" | "ollama";

  /** Which model to use */
  model: string;

  /** Optional lighter model for routine tasks (observation, verification, reflection).
   *  When not set, all calls use `model`. */
  light_model?: string;

  /** Which adapter to use by default for task execution */
  adapter: "claude_code_cli" | "claude_api" | "openai_codex_cli" | "openai_api" | "agent_loop";

  /** API key (for openai or anthropic) */
  api_key?: string;

  /** Base URL (for ollama or custom endpoints) */
  base_url?: string;

  /** CLI path for openai_codex_cli adapter */
  codex_cli_path?: string;

  /** A2A protocol agent endpoints */
  a2a?: {
    agents?: Record<string, {
      base_url: string;
      auth_token?: string;
      capabilities?: string[];
      prefer_streaming?: boolean;
      poll_interval_ms?: number;
      max_wait_ms?: number;
    }>;
  };

  /** Optional local-only OpenClaw ACP adapter configuration */
  openclaw?: {
    cli_path?: string;
    profile?: string;
    model?: string;
    work_dir?: string;
  };

  /** Native agentloop runtime settings */
  agent_loop?: {
    worktree?: {
      enabled?: boolean;
      base_dir?: string;
      keep_for_debug?: boolean;
      cleanup_policy?: "on_success" | "always" | "never";
    };
  };
}

/** Old nested provider config format (for migration) */
interface LegacyProviderConfig {
  llm_provider: "anthropic" | "openai" | "ollama" | "codex";
  default_adapter: "claude_code_cli" | "claude_api" | "openai_codex_cli" | "openai_api" | "agent_loop";
  anthropic?: { api_key?: string; model?: string };
  openai?: { api_key?: string; model?: string; base_url?: string };
  ollama?: { base_url?: string; model?: string };
  codex?: { cli_path?: string; model?: string };
  a2a?: ProviderConfig["a2a"];
}

// ─── Constants ───

const PROVIDER_CONFIG_PATH = path.join(getPulseedDirPath(), "provider.json");
const PROVIDER_ENV_PATH = path.join(getPulseedDirPath(), ".env");

const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  provider: "openai",
  model: "gpt-5.4-mini",
  adapter: "openai_codex_cli",
};

// Track whether we've already warned about provider config issues in this process
let _warnedOnce = false;

// ─── Helpers ───

/** Default model for a given provider. Single source of truth. */
function defaultModelForProvider(provider: ProviderConfig["provider"]): string {
  switch (provider) {
    case "anthropic": return "claude-sonnet-4-6";
    case "ollama": return "qwen3:4b";
    default: return "gpt-5.4-mini";
  }
}

// ─── Migration ───

/**
 * Detect whether a config object is in the old nested format.
 */
function isLegacyConfig(config: Record<string, unknown>): boolean {
  return "llm_provider" in config || "default_adapter" in config;
}

/**
 * Migrate old nested format to new flat format.
 */
export function migrateProviderConfig(old: LegacyProviderConfig): ProviderConfig {
  const provider: ProviderConfig["provider"] =
    old.llm_provider === "codex" ? "openai" : (old.llm_provider ?? "openai");

  // Resolve model from the provider-specific section
  let model: string;
  switch (old.llm_provider) {
    case "codex":
      model = old.codex?.model ?? old.openai?.model ?? defaultModelForProvider(provider);
      break;
    case "openai":
      model = old.openai?.model ?? defaultModelForProvider(provider);
      break;
    case "anthropic":
      model = old.anthropic?.model ?? defaultModelForProvider(provider);
      break;
    case "ollama":
      model = old.ollama?.model ?? defaultModelForProvider(provider);
      break;
    default:
      model = defaultModelForProvider(provider);
  }

  const adapter: ProviderConfig["adapter"] = old.default_adapter ?? "openai_codex_cli";

  // Resolve api_key from the active provider section
  const api_key = old.llm_provider === "anthropic"
    ? old.anthropic?.api_key
    : (old.openai?.api_key);

  // Resolve base_url
  const base_url = old.llm_provider === "ollama"
    ? old.ollama?.base_url
    : old.openai?.base_url;

  const result: ProviderConfig = { provider, model, adapter };
  if (api_key !== undefined) result.api_key = api_key;
  if (base_url !== undefined) result.base_url = base_url;
  if (old.codex?.cli_path !== undefined) result.codex_cli_path = old.codex.cli_path;
  if (old.a2a !== undefined) result.a2a = old.a2a;

  return result;
}

// ─── Validation ───

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate provider config for model/adapter compatibility and required fields.
 * Logs warnings but does not throw — allows unknown models for flexibility.
 */
export function validateProviderConfig(config: ProviderConfig): ValidationResult {
  const errors: string[] = [];

  // Check model-adapter compatibility (skip for ollama or unknown models)
  const registryEntry = MODEL_REGISTRY[config.model];
  if (registryEntry) {
    if (registryEntry.provider !== config.provider) {
      errors.push(
        `Model "${config.model}" requires provider "${registryEntry.provider}" but got "${config.provider}"`
      );
    }
    if (!registryEntry.adapters.includes(config.adapter)) {
      errors.push(
        `Model "${config.model}" is not compatible with adapter "${config.adapter}". Compatible: ${registryEntry.adapters.join(", ")}`
      );
    }
  }

  // Check required api_key
  const requiresOpenAiApiKey =
    config.provider === "openai" && config.adapter !== "openai_codex_cli";
  const requiresAnthropicApiKey = config.provider === "anthropic";
  const requiresAdapterApiKey = config.adapter === "openai_api";
  const requiresApiKey = requiresOpenAiApiKey || requiresAnthropicApiKey || requiresAdapterApiKey;
  if (!config.api_key && requiresApiKey) {
    const envName = requiresAdapterApiKey || requiresOpenAiApiKey ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    const providerLabel = requiresAdapterApiKey ? 'adapter "openai_api"' : `provider "${config.provider}"`;
    errors.push(`API key required for ${providerLabel}. Set ${envName} or add api_key to config.`);
  }

  return { valid: errors.length === 0, errors };
}

// ─── Env Var Resolution ───

function resolveProvider(
  fileProvider: ProviderConfig["provider"] | undefined
): ProviderConfig["provider"] {
  const envProvider = process.env["PULSEED_PROVIDER"] ?? process.env["PULSEED_LLM_PROVIDER"];
  if (envProvider === "anthropic" || envProvider === "openai" || envProvider === "ollama") {
    return envProvider;
  }
  // "codex" env var maps to "openai"
  if (envProvider === "codex") {
    return "openai";
  }
  return fileProvider ?? "openai";
}

function resolveAdapter(
  fileAdapter: ProviderConfig["adapter"] | undefined
): ProviderConfig["adapter"] {
  const envAdapter = process.env["PULSEED_ADAPTER"] ?? process.env["PULSEED_DEFAULT_ADAPTER"];
  if (
    envAdapter === "claude_code_cli" ||
    envAdapter === "claude_api" ||
    envAdapter === "openai_codex_cli" ||
    envAdapter === "openai_api" ||
    envAdapter === "agent_loop"
  ) {
    return envAdapter;
  }
  return fileAdapter ?? "openai_codex_cli";
}

function resolveModel(
  fileModel: string | undefined,
  provider: ProviderConfig["provider"]
): string {
  const envModel = process.env["PULSEED_MODEL"];
  if (envModel) return envModel;

  // provider.json explicit value takes priority over generic env vars
  if (fileModel) return fileModel;

  // Provider-specific env vars apply only as fallback when model is not set in provider.json
  if (provider === "openai") {
    const m = process.env["OPENAI_MODEL"];
    if (m) return m;
  } else if (provider === "anthropic") {
    const m = process.env["ANTHROPIC_MODEL"];
    if (m) return m;
  } else if (provider === "ollama") {
    const m = process.env["OLLAMA_MODEL"];
    if (m) return m;
  }

  return defaultModelForProvider(provider);
}

function resolveApiKey(
  fileKey: string | undefined,
  provider: ProviderConfig["provider"],
  adapter: ProviderConfig["adapter"],
  envFile: Record<string, string>
): string | undefined {
  if (adapter === "openai_api") {
    return process.env["OPENAI_API_KEY"] ?? envFile["OPENAI_API_KEY"] ?? fileKey;
  }
  if (provider === "anthropic") {
    return process.env["ANTHROPIC_API_KEY"] ?? envFile["ANTHROPIC_API_KEY"] ?? fileKey;
  }
  // openai (and codex) both use OPENAI_API_KEY
  if (provider === "openai") {
    return process.env["OPENAI_API_KEY"] ?? envFile["OPENAI_API_KEY"] ?? fileKey;
  }
  return fileKey;
}

function resolveBaseUrl(
  fileUrl: string | undefined,
  provider: ProviderConfig["provider"],
  envFile: Record<string, string>
): string | undefined {
  if (provider === "ollama") {
    return process.env["OLLAMA_BASE_URL"] ?? envFile["OLLAMA_BASE_URL"] ?? fileUrl;
  }
  if (provider === "openai") {
    return process.env["OPENAI_BASE_URL"] ?? envFile["OPENAI_BASE_URL"] ?? fileUrl;
  }
  return fileUrl;
}

function parseEnvFile(raw: string): Record<string, string> {
  const entries = raw
    .split(/\r?\n/)
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return [];
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match) return [];
      const value = match[2]!.trim().replace(/^['"]|['"]$/g, "");
      return [[match[1]!, value] as const];
    });
  return Object.fromEntries(entries);
}

async function readProviderEnvFile(): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await fsp.readFile(PROVIDER_ENV_PATH, "utf-8"));
  } catch {
    return {};
  }
}

// ─── Public API ───

/**
 * Load provider configuration.
 *
 * Priority (highest to lowest):
 *   1. Environment variables (PULSEED_PROVIDER, PULSEED_ADAPTER, PULSEED_MODEL, etc.)
 *   2. ~/.pulseed/provider.json
 *   3. Defaults (openai + gpt-5.4-mini + openai_codex_cli)
 *
 * Auto-migrates old nested format to new flat format.
 */
export async function loadProviderConfig(): Promise<ProviderConfig> {
  let fileConfig: Partial<ProviderConfig> = {};
  let needsMigrationSave = false;
  const envFile = await readProviderEnvFile();

  try {
    await fsp.access(PROVIDER_CONFIG_PATH);
    try {
      const raw = await fsp.readFile(PROVIDER_CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      if (isLegacyConfig(parsed)) {
        fileConfig = migrateProviderConfig(parsed as unknown as LegacyProviderConfig);
        needsMigrationSave = true;
      } else {
        fileConfig = parsed as Partial<ProviderConfig>;
      }
    } catch {
      fileConfig = {};
    }
  } catch {
    // File does not exist
  }

  const provider = resolveProvider(fileConfig.provider);
  let model = resolveModel(fileConfig.model, provider);
  const adapter = resolveAdapter(fileConfig.adapter);

  // Auto-correct model-adapter incompatibility (e.g. OPENAI_MODEL=gpt-4o-mini with openai_codex_cli)
  const registryEntry = MODEL_REGISTRY[model];
  if (registryEntry && !registryEntry.adapters.includes(adapter)) {
    const fallback = defaultModelForProvider(provider);
    console.warn(
      `[provider-config] Model "${model}" is not compatible with adapter "${adapter}". Falling back to "${fallback}".`
    );
    model = fallback;
  }

  let api_key = resolveApiKey(fileConfig.api_key, provider, adapter, envFile);

  // Fallback: read OAuth token from ~/.codex/auth.json when no API key is configured
  if (!api_key && provider === "openai" && adapter === "openai_codex_cli") {
    api_key = await readCodexOAuthToken();
  }

  const base_url = resolveBaseUrl(fileConfig.base_url, provider, envFile);

  const config: ProviderConfig = { provider, model, adapter };
  if (api_key !== undefined) config.api_key = api_key;
  if (base_url !== undefined) config.base_url = base_url;
  if (fileConfig.codex_cli_path !== undefined) config.codex_cli_path = fileConfig.codex_cli_path;
  if (fileConfig.a2a !== undefined) config.a2a = fileConfig.a2a;
  if (fileConfig.light_model !== undefined) config.light_model = fileConfig.light_model;
  if (fileConfig.openclaw !== undefined) config.openclaw = fileConfig.openclaw;
  if (fileConfig.agent_loop !== undefined) config.agent_loop = fileConfig.agent_loop;

  // Validate and log warnings (only once per process)
  const validation = validateProviderConfig(config);
  if (!validation.valid && !_warnedOnce) {
    for (const err of validation.errors) {
      console.warn(`[provider-config] Warning: ${err}`);
    }
    _warnedOnce = true;
  }

  // Auto-save migrated config (save file-only values, not env-var-resolved ones)
  if (needsMigrationSave) {
    try {
      const fileOnly: ProviderConfig = {
        provider: fileConfig.provider ?? "openai",
        model: fileConfig.model ?? "gpt-5.4-mini",
        adapter: fileConfig.adapter ?? "openai_codex_cli",
      };
      if (fileConfig.api_key !== undefined) fileOnly.api_key = fileConfig.api_key;
      if (fileConfig.base_url !== undefined) fileOnly.base_url = fileConfig.base_url;
      if (fileConfig.codex_cli_path !== undefined) fileOnly.codex_cli_path = fileConfig.codex_cli_path;
      if (fileConfig.a2a !== undefined) fileOnly.a2a = fileConfig.a2a;
      if (fileConfig.agent_loop !== undefined) fileOnly.agent_loop = fileConfig.agent_loop;
      await saveProviderConfig(fileOnly);
    } catch {
      // Best-effort — don't fail if we can't save
    }
  }

  return config;
}

export async function getProviderRuntimeFingerprint(): Promise<string> {
  const config = await loadProviderConfig();
  const fingerprintSource = {
    provider: config.provider,
    model: config.model,
    adapter: config.adapter,
    light_model: config.light_model ?? null,
    base_url: config.base_url ?? null,
    codex_cli_path: config.codex_cli_path ?? null,
    api_key_hash: config.api_key
      ? createHash("sha256").update(config.api_key).digest("hex")
      : null,
    a2a: config.a2a ?? null,
    openclaw: config.openclaw ?? null,
    agent_loop: config.agent_loop ?? null,
  };

  return JSON.stringify(fingerprintSource);
}

/**
 * Save provider configuration to ~/.pulseed/provider.json.
 * Creates the ~/.pulseed directory if it does not exist.
 */
export async function saveProviderConfig(config: ProviderConfig): Promise<void> {
  await writeJsonFileAtomic(PROVIDER_CONFIG_PATH, config);
}

// Re-export default for tests that need it
export { DEFAULT_PROVIDER_CONFIG };
