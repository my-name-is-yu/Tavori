// ─── pulseed setup — Interactive Clack wizard ───
//
// 9-step guided setup using @clack/prompts.
// Configures provider, identity, and daemon preference.

import * as p from "@clack/prompts";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadProviderConfig,
  saveProviderConfig,
  validateProviderConfig,
} from "../../../base/llm/provider-config.js";
import type { ProviderConfig } from "../../../base/llm/provider-config.js";
import { getPulseedDirPath } from "../../../base/utils/paths.js";
import { clearIdentityCache, DEFAULT_SEED, DEFAULT_USER } from "../../../base/config/identity-loader.js";
import { ROOT_PRESETS } from "./presets/root-presets.js";
import type { RootPresetKey } from "./presets/root-presets.js";
import {
  PROVIDERS,
  PROVIDER_LABELS,
  ENV_KEY_NAMES,
  RECOMMENDED_MODELS,
  RECOMMENDED_ADAPTERS,
  detectApiKeys,
  getModelsForProvider,
  getAdaptersForModel,
  maskKey,
} from "./setup-shared.js";
import type { Provider } from "./setup-shared.js";

// ─── Guard helper ───

function guardCancel<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return value as T;
}

// ─── ASCII banner ───

const BANNER = `
  ____  _   _ _     ____  _____ _____ ____  
 |  _ \\| | | | |   / ___|| ____| ____|  _ \\ 
 | |_) | | | | |   \\___ \\|  _| |  _| | | | |
 |  __/| |_| | |___ ___) | |___| |___| |_| |
 |_|    \\___/|_____|____/|_____|_____|____/ 
`;

// ─── Step implementations ───

async function stepExistingConfig(): Promise<"keep" | "modify" | "reset" | null> {
  const configPath = path.join(getPulseedDirPath(), "provider.json");
  if (!fs.existsSync(configPath)) return null;

  const current = await loadProviderConfig();
  p.note(
    [
      `Provider: ${current.provider}`,
      `Model:    ${current.model}`,
      `Adapter:  ${current.adapter}`,
      `API Key:  ${maskKey(current.api_key)}`,
    ].join("\n"),
    "Existing configuration found"
  );

  const choice = guardCancel(
    await p.select({
      message: "What would you like to do?",
      options: [
        { value: "keep" as const, label: "Keep current config", hint: "exit wizard" },
        { value: "modify" as const, label: "Modify", hint: "continue with current values as defaults" },
        { value: "reset" as const, label: "Reset", hint: "start fresh" },
      ],
    })
  );
  return choice;
}

async function stepUserName(): Promise<string> {
  const name = guardCancel(
    await p.text({
      message: "What should we call you?",
      placeholder: "Your name",
      validate: (v) => {
        if (!v || !v.trim()) return "Name cannot be empty.";
        return undefined;
      },
    })
  );
  return name;
}

async function stepSeedyName(): Promise<string> {
  p.note(
    "Your agent has a pixel art avatar at assets/seedy.png\n\n" +
      "  \ud83c\udf31\n /|\\\n  |",
    "Meet your agent"
  );

  const name = guardCancel(
    await p.text({
      message: "What should your agent be called?",
      placeholder: "Seedy",
      defaultValue: "Seedy",
    })
  );
  return name;
}

async function stepRootPreset(): Promise<RootPresetKey> {
  const preset = guardCancel(
    await p.select({
      message: "Select a communication style for your agent:",
      options: [
        {
          value: "default" as const,
          label: "\ud83c\udf3f Default",
          hint: ROOT_PRESETS.default.description,
        },
        {
          value: "professional" as const,
          label: "\ud83d\udccb Professional",
          hint: ROOT_PRESETS.professional.description,
        },
        {
          value: "caveman" as const,
          label: "\ud83e\udea8 Caveman",
          hint: ROOT_PRESETS.caveman.description,
        },
      ],
    })
  );
  return preset;
}

async function stepProvider(): Promise<Provider> {
  const detectedKeys = detectApiKeys();
  const options = PROVIDERS.map((prov) => {
    const detected = detectedKeys[prov] ? ` (${ENV_KEY_NAMES[prov]} detected)` : "";
    return { value: prov, label: `${PROVIDER_LABELS[prov]}${detected}` };
  });

  const provider = guardCancel(
    await p.select({ message: "Select LLM provider:", options })
  );
  return provider;
}

async function stepModel(provider: Provider): Promise<string> {
  const models = getModelsForProvider(provider);
  const recommended = RECOMMENDED_MODELS[provider];

  const options = models.map((m) => ({
    value: m,
    label: m,
    hint: m === recommended ? "recommended" : undefined,
  }));
  options.push({ value: "__custom__", label: "Custom model name", hint: undefined });

  const choice = guardCancel(
    await p.select({ message: "Select model:", options })
  );

  if (choice === "__custom__") {
    const custom = guardCancel(
      await p.text({
        message: "Enter model name:",
        validate: (v) => {
          if (!v || !v.trim()) return "Model name cannot be empty.";
          return undefined;
        },
      })
    );
    return custom;
  }
  return choice;
}

async function stepAdapter(model: string, provider: Provider): Promise<string> {
  const adapters = getAdaptersForModel(model, provider);
  const recommendedAdapter = RECOMMENDED_ADAPTERS[provider];

  if (adapters.length === 0 && provider !== "ollama") {
    p.log.error(`No compatible adapters found for model "${model}".`);
    return "";
  }

  if (adapters.length <= 1) {
    const adapter = adapters[0] ?? "openai_api";
    p.log.info(`Adapter: ${adapter} (auto-selected)`);
    return adapter;
  }

  const options = adapters.map((a) => ({
    value: a,
    label: a,
    hint: a === recommendedAdapter ? "recommended" : undefined,
  }));

  const adapter = guardCancel(
    await p.select({ message: "Select execution adapter:", options })
  );
  return adapter;
}

async function stepApiKey(
  provider: Provider,
  detectedKeys: Record<string, boolean>
): Promise<string | undefined> {
  const envKeyName = ENV_KEY_NAMES[provider];
  if (!envKeyName) return undefined; // ollama — no key needed

  if (detectedKeys[provider]) {
    p.log.info(`Using ${envKeyName} from environment.`);
    return process.env[envKeyName];
  }

  const key = guardCancel(
    await p.password({
      message: `Enter ${envKeyName}:`,
    })
  );
  if (!key) {
    p.log.warn(`No API key provided. Set ${envKeyName} before running PulSeed.`);
    return undefined;
  }
  return key;
}

async function stepDaemon(): Promise<boolean> {
  const daemon = guardCancel(
    await p.confirm({
      message: "Start PulSeed as a background daemon after setup?",
      initialValue: false,
    })
  );
  return daemon;
}

// ─── Config writers ───

function ensurePulseedDir(): string {
  const dir = getPulseedDirPath();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function writeSeedMd(dir: string, agentName: string): void {
  const content = DEFAULT_SEED.replace(/^# Seedy/m, `# ${agentName}`);
  fs.writeFileSync(path.join(dir, "SEED.md"), content, "utf-8");
}

function writeRootMd(dir: string, presetKey: RootPresetKey): void {
  fs.writeFileSync(
    path.join(dir, "ROOT.md"),
    ROOT_PRESETS[presetKey].content,
    "utf-8"
  );
}

function writeUserMd(dir: string, userName: string): void {
  const content = `# About You\n\nName: ${userName}\n\n<!-- Seedy will remember things about you here -->\n`;
  fs.writeFileSync(path.join(dir, "USER.md"), content, "utf-8");
}

// ─── Main wizard ───

export async function runSetupWizard(): Promise<number> {
  // Step 1: Banner
  p.intro(BANNER);

  // Step 2: Experimental disclaimer
  const accepted = guardCancel(
    await p.confirm({
      message:
        "PulSeed is experimental software. It autonomously orchestrates AI agents " +
        "that may incur API costs, modify files, and execute commands. " +
        "Do you accept the risks and wish to continue?",
      initialValue: true,
    })
  );
  if (!accepted) {
    p.cancel("Setup cancelled.");
    return 0;
  }

  // Step 3: Existing config detection
  const existingChoice = await stepExistingConfig();
  if (existingChoice === "keep") {
    p.outro("Keeping existing configuration.");
    return 0;
  }

  // Step 4: User name
  const userName = await stepUserName();

  // Step 5: Seedy name + pixel art
  const agentName = await stepSeedyName();

  // Step 6: ROOT.md preset
  const rootPreset = await stepRootPreset();

  // Step 7: Provider setup
  const provider = await stepProvider();
  const model = await stepModel(provider);
  const adapter = await stepAdapter(model, provider);
  if (!adapter) return 1;

  const detectedKeys = detectApiKeys();
  const apiKey = await stepApiKey(provider, detectedKeys);

  // Step 8: Daemon
  const startDaemon = await stepDaemon();

  // Step 9: Confirm
  const summaryLines = [
    `User:      ${userName}`,
    `Agent:     ${agentName}`,
    `Style:     ${ROOT_PRESETS[rootPreset].name}`,
    `Provider:  ${provider}`,
    `Model:     ${model}`,
    `Adapter:   ${adapter}`,
    `API Key:   ${maskKey(apiKey)}`,
    `Daemon:    ${startDaemon ? "yes" : "no"}`,
  ];
  p.note(summaryLines.join("\n"), "Configuration Summary");

  const confirmed = guardCancel(
    await p.confirm({ message: "Save this configuration?", initialValue: true })
  );
  if (!confirmed) {
    p.cancel("Setup cancelled.");
    return 0;
  }

  // Write all configs
  const dir = ensurePulseedDir();

  const config: ProviderConfig = {
    provider,
    model,
    adapter: adapter as ProviderConfig["adapter"],
  };
  if (apiKey) config.api_key = apiKey;

  const validation = validateProviderConfig(config);
  if (!validation.valid) {
    for (const err of validation.errors) {
      p.log.error(err);
    }
    return 1;
  }

  await saveProviderConfig(config);
  writeSeedMd(dir, agentName);
  writeRootMd(dir, rootPreset);
  writeUserMd(dir, userName);
  clearIdentityCache();

  if (startDaemon) {
    p.log.info("To start the daemon, run: pulseed start --goal <goal-id> --detach");
  }

  p.outro("\ud83c\udf31 Seeds planted. Time to grow.");
  return 0;
}
