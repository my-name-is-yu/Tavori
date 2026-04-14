import * as p from "@clack/prompts";
import { spawnSync } from "node:child_process";
import { readCodexOAuthToken } from "../../../../base/llm/provider-config.js";
import { ROOT_PRESETS } from "../presets/root-presets.js";
import type { RootPresetKey } from "../presets/root-presets.js";
import {
  PROVIDERS,
  PROVIDER_LABELS,
  ENV_KEY_NAMES,
  RECOMMENDED_MODELS,
  detectApiKeys,
  getModelsForProvider,
} from "../setup-shared.js";
import type { Provider } from "../setup-shared.js";
import { guardCancel } from "./utils.js";

export async function stepRootPreset(initialPreset?: RootPresetKey): Promise<RootPresetKey> {
  const preset = guardCancel(
    await p.select({
      message: "Select a communication style for your agent:",
      options: [
        {
          value: "default" as const,
          label: "🌿 Default",
          hint: ROOT_PRESETS.default.description,
        },
        {
          value: "professional" as const,
          label: "📋 Professional",
          hint: ROOT_PRESETS.professional.description,
        },
        {
          value: "caveman" as const,
          label: "🪨 Caveman",
          hint: ROOT_PRESETS.caveman.description,
        },
      ],
      initialValue: initialPreset,
    })
  );
  return preset;
}

export async function stepProvider(initialProvider?: Provider): Promise<Provider> {
  const detectedKeys = detectApiKeys();
  const options = PROVIDERS.map((prov) => {
    const hints = [
      detectedKeys[prov] ? `${ENV_KEY_NAMES[prov]} detected` : undefined,
      prov === initialProvider ? "current" : undefined,
    ].filter(Boolean);
    return {
      value: prov,
      label: PROVIDER_LABELS[prov],
      hint: hints.join(", ") || undefined,
    };
  });

  const provider = guardCancel(
    await p.select({
      message: "Select LLM provider:",
      options,
      initialValue: initialProvider,
    })
  );
  return provider;
}

export async function stepModel(provider: Provider, initialModel?: string): Promise<string> {
  const models = getModelsForProvider(provider);
  const recommended = RECOMMENDED_MODELS[provider];

  const options = models.map((model) => ({
    value: model,
    label: model,
    hint: [
      model === recommended ? "recommended" : undefined,
      model === initialModel ? "current" : undefined,
    ].filter(Boolean).join(", ") || undefined,
  }));
  options.push({
    value: "__custom__",
    label: "Custom model name",
    hint: initialModel && !models.includes(initialModel) ? `current: ${initialModel}` : undefined,
  });

  const initialValue = initialModel
    ? models.includes(initialModel)
      ? initialModel
      : "__custom__"
    : undefined;

  const choice = guardCancel(
    await p.select({
      message: "Select model:",
      options,
      initialValue,
    })
  );

  if (choice === "__custom__") {
    const custom = guardCancel(
      await p.text({
        message: "Enter model name:",
        initialValue: initialModel && !models.includes(initialModel) ? initialModel : undefined,
        validate: (value) => {
          if (!value || !value.trim()) return "Model name cannot be empty.";
          return undefined;
        },
      })
    );
    return custom;
  }

  return choice;
}

export async function runCodexOAuthLogin(): Promise<string | undefined> {
  p.log.info("Opening browser for OAuth login...");

  const attempts = [
    ["npx", ["--yes", "@openai/codex", "login"]],
    ["npx", ["--yes", "codex", "login"]],
  ] as [string, string[]][];

  for (const [cmd, args] of attempts) {
    try {
      const result = spawnSync(cmd, args, { stdio: "inherit", shell: false });
      if (result.error) {
        continue;
      }
      if (result.status === 0) {
        const token = await readCodexOAuthToken();
        if (token) {
          p.log.success("OAuth login successful. Token saved.");
          return token;
        }
        p.log.warn("OAuth login completed but no token found at ~/.codex/auth.json.");
        return undefined;
      }
    } catch {
      // Unexpected error — try next
    }
  }

  p.log.error("Codex CLI not found. Install with: npm install -g @openai/codex");
  return undefined;
}

function isLikelyCodexOAuthToken(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return trimmed.startsWith("eyJ") && trimmed.split(".").length >= 3;
}

function requiresOpenAIApiKey(provider: Provider, adapter?: string): boolean {
  return provider === "openai" && adapter !== "openai_codex_cli";
}

export async function stepApiKey(
  provider: Provider,
  detectedKeys: Record<string, boolean>,
  existingApiKey?: string,
  adapter?: string
): Promise<string | undefined> {
  const envKeyName = ENV_KEY_NAMES[provider];
  if (!envKeyName) return undefined;

  if (provider === "openai" && adapter === "openai_codex_cli") {
    const existingToken = await readCodexOAuthToken();
    if (existingToken) {
      p.log.info("Using existing Codex CLI OAuth login. No OpenAI API key will be saved.");
      return undefined;
    }

    const authChoice = guardCancel(
      await p.select({
        message: "Codex CLI authentication:",
        options: [
          {
            value: "login" as const,
            label: "Login with OAuth (opens browser via Codex CLI)",
            hint: "recommended for OpenAI Codex CLI adapter",
          },
          {
            value: "skip" as const,
            label: "Skip for now",
            hint: "run `codex login` before using this adapter",
          },
        ],
        initialValue: "login" as const,
      })
    );

    if (authChoice === "login") {
      await runCodexOAuthLogin();
    }
    return undefined;
  }

  if (detectedKeys[provider]) {
    const envValue = process.env[envKeyName];
    if (requiresOpenAIApiKey(provider, adapter) && isLikelyCodexOAuthToken(envValue)) {
      p.log.warn(`${envKeyName} appears to contain a Codex OAuth token, not an OpenAI API key.`);
    } else {
      p.log.info(`Using ${envKeyName} from environment.`);
      return envValue;
    }
  }

  const canKeepExisting =
    existingApiKey && !(requiresOpenAIApiKey(provider, adapter) && isLikelyCodexOAuthToken(existingApiKey));

  if (canKeepExisting) {
    const keyChoice = guardCancel(
      await p.select({
        message: `${envKeyName} is already configured. What should setup do?`,
        options: [
          {
            value: "keep" as const,
            label: `Keep existing key (${existingApiKey.slice(0, 4)}...${existingApiKey.slice(-4)})`,
            hint: "use current config",
          },
          {
            value: "replace" as const,
            label: "Replace key",
          },
        ],
        initialValue: "keep" as const,
      })
    );
    if (keyChoice === "keep") return existingApiKey;
  } else if (existingApiKey && requiresOpenAIApiKey(provider, adapter)) {
    p.log.warn("Existing OpenAI auth looks like a Codex OAuth token and cannot be used for the OpenAI API adapter.");
  }

  const key = guardCancel(
    await p.password({
      message: `Enter ${envKeyName}:`,
      validate: (value) => {
        if (!value) return "API key is required";
        if (requiresOpenAIApiKey(provider, adapter) && isLikelyCodexOAuthToken(value)) {
          return "Codex OAuth tokens cannot call OpenAI API endpoints. Enter an OpenAI API key instead.";
        }
        return undefined;
      },
    })
  );
  if (!key) {
    p.log.warn(`No API key provided. Set ${envKeyName} before running PulSeed.`);
    return undefined;
  }
  return key;
}
