// ─── pulseed setup — Interactive setup wizard ───
//
// Guides the user through first-time configuration of their LLM provider,
// model, and execution adapter. Saves the result to ~/.pulseed/provider.json.

import * as readline from "node:readline";
import { parseArgs } from "node:util";
import {
  loadProviderConfig,
  saveProviderConfig,
  validateProviderConfig,
  MODEL_REGISTRY,
} from "../../llm/provider-config.js";
import type { ProviderConfig } from "../../llm/provider-config.js";
import { getPulseedDirPath } from "../../utils/paths.js";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

// ─── Readline helpers ───

function createInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

// ─── Provider / Model / Adapter lists ───

const PROVIDERS = ["openai", "anthropic", "ollama"] as const;
type Provider = (typeof PROVIDERS)[number];

const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama (local)",
};

const ENV_KEY_NAMES: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

function detectApiKeys(): Record<string, boolean> {
  return {
    openai: !!process.env["OPENAI_API_KEY"],
    anthropic: !!process.env["ANTHROPIC_API_KEY"],
  };
}

function getModelsForProvider(provider: string): string[] {
  return Object.entries(MODEL_REGISTRY)
    .filter(([, info]) => info.provider === provider)
    .map(([name]) => name);
}

function getAdaptersForModel(model: string, provider: string): string[] {
  const entry = MODEL_REGISTRY[model];
  if (entry) return entry.adapters;
  // For unknown/custom models, return all adapters for the provider
  if (provider === "openai") return ["openai_codex_cli", "openai_api"];
  if (provider === "anthropic") return ["claude_code_cli", "claude_api"];
  if (provider === "ollama") return ["openai_api"];
  return [];
}

const RECOMMENDED_MODELS: Record<string, string> = {
  openai: "gpt-5.4-mini",
  anthropic: "claude-sonnet-4-6",
  ollama: "qwen3:4b",
};

const RECOMMENDED_ADAPTERS: Record<string, string> = {
  openai: "openai_codex_cli",
  anthropic: "claude_code_cli",
};

// ─── Config file check ───

async function configFileExists(): Promise<boolean> {
  const configPath = path.join(getPulseedDirPath(), "provider.json");
  try {
    await fsp.access(configPath);
    return true;
  } catch {
    return false;
  }
}

function maskKey(key: string | undefined): string {
  if (!key) return "(not set)";
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

// ─── Non-interactive mode ───

async function runNonInteractive(argv: string[]): Promise<number> {
  let values: { provider?: string; model?: string; adapter?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        provider: { type: "string" },
        model: { type: "string" },
        adapter: { type: "string" },
      },
      strict: false,
    }) as { values: { provider?: string; model?: string; adapter?: string } });
  } catch {
    console.error("Error: failed to parse setup arguments.");
    return 1;
  }

  if (!values.provider) {
    console.error("Error: --provider is required in non-interactive mode.");
    return 1;
  }

  if (!PROVIDERS.includes(values.provider as Provider)) {
    console.error(
      `Error: invalid provider "${values.provider}". Valid: ${PROVIDERS.join(", ")}`
    );
    return 1;
  }

  const provider = values.provider as ProviderConfig["provider"];
  const model = values.model ?? RECOMMENDED_MODELS[provider] ?? "gpt-5.4-mini";

  // Validate model-provider compatibility
  const registryEntry = MODEL_REGISTRY[model];
  if (registryEntry && registryEntry.provider !== provider) {
    console.error(
      `Error: model "${model}" is not compatible with provider "${provider}". ` +
        `It requires provider "${registryEntry.provider}".`
    );
    return 1;
  }

  const adapters = getAdaptersForModel(model, provider);
  const adapter = values.adapter ?? RECOMMENDED_ADAPTERS[provider] ?? adapters[0];

  if (!adapter) {
    console.error(`Error: no compatible adapter found for model "${model}".`);
    return 1;
  }

  // Validate adapter compatibility
  if (registryEntry && !registryEntry.adapters.includes(adapter)) {
    console.error(
      `Error: adapter "${adapter}" is not compatible with model "${model}". ` +
        `Compatible: ${registryEntry.adapters.join(", ")}`
    );
    return 1;
  }

  const config: ProviderConfig = {
    provider,
    model,
    adapter: adapter as ProviderConfig["adapter"],
  };

  // Pick up API key from env
  const envKey = ENV_KEY_NAMES[provider];
  if (envKey && process.env[envKey]) {
    config.api_key = process.env[envKey];
  }

  const validation = validateProviderConfig(config);
  if (!validation.valid) {
    for (const err of validation.errors) {
      console.error(`Error: ${err}`);
    }
    return 1;
  }

  await saveProviderConfig(config);
  console.log("Setup complete! Configuration saved to ~/.pulseed/provider.json");
  console.log(`  Provider: ${config.provider}`);
  console.log(`  Model:    ${config.model}`);
  console.log(`  Adapter:  ${config.adapter}`);
  return 0;
}

// ─── Interactive mode ───

async function runInteractive(): Promise<number> {
  // Check for existing config
  if (await configFileExists()) {
    const current = await loadProviderConfig();
    console.log("\nExisting configuration found:");
    console.log(`  Provider: ${current.provider}`);
    console.log(`  Model:    ${current.model}`);
    console.log(`  Adapter:  ${current.adapter}`);
    console.log(`  API Key:  ${maskKey(current.api_key)}`);

    const rl = createInterface();
    const answer = await ask(rl, "\nReconfigure? (y/N) ");
    rl.close();

    if (answer.toLowerCase() !== "y") {
      console.log("Setup cancelled. Keeping existing configuration.");
      return 0;
    }
  }

  const detectedKeys = detectApiKeys();
  const rl = createInterface();

  try {
    // Step 1: Select provider
    console.log("\n? Select LLM provider:");
    for (let i = 0; i < PROVIDERS.length; i++) {
      const p = PROVIDERS[i];
      const detected = detectedKeys[p] ? ` (${ENV_KEY_NAMES[p]} detected)` : "";
      console.log(`  ${i + 1}) ${PROVIDER_LABELS[p]}${detected}`);
    }

    const providerChoice = await ask(rl, "> ");
    const providerIndex = parseInt(providerChoice, 10) - 1;
    if (isNaN(providerIndex) || providerIndex < 0 || providerIndex >= PROVIDERS.length) {
      console.error("Error: invalid selection.");
      return 1;
    }
    const provider = PROVIDERS[providerIndex];

    // Step 2: Select model
    const models = getModelsForProvider(provider);
    const recommended = RECOMMENDED_MODELS[provider];

    console.log("\n? Select model:");
    for (let i = 0; i < models.length; i++) {
      const rec = models[i] === recommended ? " (recommended)" : "";
      console.log(`  ${i + 1}) ${models[i]}${rec}`);
    }
    const customIndex = models.length + 1;
    if (provider === "ollama" || models.length === 0) {
      console.log(`  ${customIndex}) Enter custom model name`);
    } else {
      console.log(`  ${customIndex}) Custom (enter model name)`);
    }

    const modelChoice = await ask(rl, "> ");
    const modelIndex = parseInt(modelChoice, 10) - 1;
    let model: string;

    if (modelIndex === models.length) {
      // Custom model
      model = await ask(rl, "Enter model name: ");
      if (!model) {
        console.error("Error: model name cannot be empty.");
        return 1;
      }
    } else if (modelIndex >= 0 && modelIndex < models.length) {
      model = models[modelIndex];
    } else {
      console.error("Error: invalid selection.");
      return 1;
    }

    // Step 3: Select adapter
    const adapters = getAdaptersForModel(model, provider);
    const recommendedAdapter = RECOMMENDED_ADAPTERS[provider];

    if (adapters.length === 0 && provider !== "ollama") {
      console.error(`Error: no compatible adapters found for model "${model}".`);
      return 1;
    }

    let adapter: string;
    if (adapters.length === 1) {
      adapter = adapters[0];
      console.log(`\nAdapter: ${adapter} (only compatible option)`);
    } else if (adapters.length > 1) {
      console.log("\n? Select execution adapter:");
      for (let i = 0; i < adapters.length; i++) {
        const rec = adapters[i] === recommendedAdapter ? " (recommended)" : "";
        console.log(`  ${i + 1}) ${adapters[i]}${rec}`);
      }

      const adapterChoice = await ask(rl, "> ");
      const adapterIndex = parseInt(adapterChoice, 10) - 1;
      if (isNaN(adapterIndex) || adapterIndex < 0 || adapterIndex >= adapters.length) {
        console.error("Error: invalid selection.");
        return 1;
      }
      adapter = adapters[adapterIndex];
    } else {
      // Ollama with no registry adapters — skip adapter selection
      adapter = "openai_api"; // Default for ollama
      console.log(`\nAdapter: ${adapter} (default for ollama)`);
    }

    // Step 4: API key
    const config: ProviderConfig = {
      provider,
      model,
      adapter: adapter as ProviderConfig["adapter"],
    };

    const envKeyName = ENV_KEY_NAMES[provider];
    if (envKeyName) {
      if (detectedKeys[provider]) {
        config.api_key = process.env[envKeyName];
        console.log(`\nAPI key: using ${envKeyName} from environment`);
      } else {
        const key = await ask(rl, `\nEnter ${envKeyName}: `);
        if (key) {
          config.api_key = key;
        } else {
          console.error(`Warning: no API key provided. Set ${envKeyName} before running PulSeed.`);
        }
      }
    }

    // Step 5: Summary and confirm
    console.log("\n--- Configuration Summary ---");
    console.log(`  Provider: ${config.provider}`);
    console.log(`  Model:    ${config.model}`);
    console.log(`  Adapter:  ${config.adapter}`);
    console.log(`  API Key:  ${maskKey(config.api_key)}`);

    const confirm = await ask(rl, "\nSave this configuration? (Y/n) ");
    if (confirm.toLowerCase() === "n") {
      console.log("Setup cancelled.");
      return 0;
    }

    await saveProviderConfig(config);
    console.log("\nSetup complete! Configuration saved to ~/.pulseed/provider.json");
    return 0;
  } finally {
    rl.close();
  }
}

// ─── Help text ───

const HELP_TEXT = `Usage: pulseed setup [options]

Interactive setup wizard for provider configuration.

Options:
  --provider <name>   LLM provider (openai, anthropic, ollama)
  --model <name>      Model name (e.g., gpt-5.4-mini)
  --adapter <name>    Execution adapter (openai_codex_cli, claude_code_cli, etc.)
  --help, -h          Show this help
`;

// ─── Public entry point ───

export async function cmdSetup(argv: string[]): Promise<number> {
  // Check for help flag before anything else
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP_TEXT);
    return 0;
  }

  // If any flags are provided, use non-interactive mode
  const hasFlags = argv.some((a) => a.startsWith("--"));
  if (hasFlags) {
    return runNonInteractive(argv);
  }
  return runInteractive();
}
