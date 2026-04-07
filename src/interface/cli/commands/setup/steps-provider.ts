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

export async function stepRootPreset(): Promise<RootPresetKey> {
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
    })
  );
  return preset;
}

export async function stepProvider(): Promise<Provider> {
  const detectedKeys = detectApiKeys();
  const options = PROVIDERS.map((prov) => {
    const detected = detectedKeys[prov] ? ` (${ENV_KEY_NAMES[prov]} detected)` : "";
    return { value: prov, label: `${PROVIDER_LABELS[prov]}${detected}` };
  });

  const provider = guardCancel(await p.select({ message: "Select LLM provider:", options }));
  return provider;
}

export async function stepModel(provider: Provider): Promise<string> {
  const models = getModelsForProvider(provider);
  const recommended = RECOMMENDED_MODELS[provider];

  const options = models.map((model) => ({
    value: model,
    label: model,
    hint: model === recommended ? "recommended" : undefined,
  }));
  options.push({ value: "__custom__", label: "Custom model name", hint: undefined });

  const choice = guardCancel(await p.select({ message: "Select model:", options }));

  if (choice === "__custom__") {
    const custom = guardCancel(
      await p.text({
        message: "Enter model name:",
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

export async function stepApiKey(
  provider: Provider,
  detectedKeys: Record<string, boolean>
): Promise<string | undefined> {
  const envKeyName = ENV_KEY_NAMES[provider];
  if (!envKeyName) return undefined;

  if (detectedKeys[provider]) {
    p.log.info(`Using ${envKeyName} from environment.`);
    return process.env[envKeyName];
  }

  if (provider === "openai") {
    const existingToken = await readCodexOAuthToken();

    type OAuthMethod = "login" | "oauth" | "manual";
    const oauthOptions: p.Option<OAuthMethod>[] = [
      {
        value: "login" as const,
        label: "Login with OAuth (opens browser via Codex CLI)",
        hint: "runs npx @openai/codex login",
      },
    ];

    if (existingToken) {
      oauthOptions.push({
        value: "oauth" as const,
        label: "Use existing OAuth token",
        hint: "from previous Codex CLI login",
      });
    }

    oauthOptions.push({
      value: "manual" as const,
      label: "Enter API key manually",
    });

    const authMethod = guardCancel(
      await p.select({
        message: "Select authentication method:",
        options: oauthOptions,
      })
    ) as OAuthMethod;

    if (authMethod === "login") {
      const token = await runCodexOAuthLogin();
      if (token) return token;
      p.log.info("Falling back to manual API key entry.");
    } else if (authMethod === "oauth" && existingToken) {
      return existingToken;
    }
  }

  const key = guardCancel(
    await p.password({
      message: `Enter ${envKeyName}:`,
      validate: (value) => (!value ? "API key is required" : undefined),
    })
  );
  if (!key) {
    p.log.warn(`No API key provided. Set ${envKeyName} before running PulSeed.`);
    return undefined;
  }
  return key;
}
