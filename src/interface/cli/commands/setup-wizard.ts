// ─── pulseed setup — Interactive Clack wizard ───
//
// 9-step guided setup using @clack/prompts.
// Configures provider, identity, and daemon preference.

import * as p from "@clack/prompts";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadProviderConfig,
  saveProviderConfig,
  validateProviderConfig,
  readCodexOAuthToken,
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
import { findAvailablePort, isPortAvailable, DEFAULT_PORT } from "../../../runtime/port-utils.js";
import { SEEDY_PIXEL } from "../../tui/seedy-art.js";

// ─── Guard helper ───

function guardCancel<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return value as T;
}

// ─── Block-character banner ───

function getBanner(): string {
  const green = "\x1b[38;2;76;175;80m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  return `
${green}  ██████╗ ██╗   ██╗██╗     ███████╗███████╗███████╗██████╗
  ██╔══██╗██║   ██║██║     ██╔════╝██╔════╝██╔════╝██╔══██╗
  ██████╔╝██║   ██║██║     ███████╗█████╗  █████╗  ██║  ██║
  ██╔═══╝ ██║   ██║██║     ╚════██║██╔══╝  ██╔══╝  ██║  ██║
  ██║     ╚██████╔╝███████╗███████║███████╗███████╗██████╔╝
  ╚═╝      ╚═════╝ ╚══════╝╚══════╝╚══════╝╚══════╝╚═════╝${reset}

  ${bold}🌱 Welcome to ${green}PulSeed${reset}${bold} setup!${reset}
`;
}

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
      message: "What should I call you?",
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
    SEEDY_PIXEL + "\n\n" +
    "Hi! I'm your new agent companion.",
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

  if (adapters.length === 0) {
    p.log.error(`No compatible adapters found for model "${model}".`);
    return "";
  }

  if (adapters.length <= 1) {
    const adapter = adapters[0];
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

async function runCodexOAuthLogin(): Promise<string | undefined> {
  p.log.info("Opening browser for OAuth login...");

  // Try npx @openai/codex login first, then npx codex --login as fallback
  const attempts = [
    ["npx", ["--yes", "@openai/codex", "login"]],
    ["npx", ["--yes", "codex", "login"]],
  ] as [string, string[]][];

  for (const [cmd, args] of attempts) {
    try {
      const result = spawnSync(cmd, args, { stdio: "inherit", shell: false });
      if (result.error) {
        // Command not found — try next
        continue;
      }
      if (result.status === 0) {
        // Login succeeded — verify token was written
        const token = await readCodexOAuthToken();
        if (token) {
          p.log.success("OAuth login successful. Token saved.");
          return token;
        }
        p.log.warn("OAuth login completed but no token found at ~/.codex/auth.json.");
        return undefined;
      }
      // Non-zero exit — try next
    } catch {
      // Unexpected error — try next
    }
  }

  p.log.error(
    "Codex CLI not found. Install with: npm install -g @openai/codex"
  );
  return undefined;
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

  // OpenAI: offer OAuth login options
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
    ) as "login" | "oauth" | "manual";

    if (authMethod === "login") {
      const token = await runCodexOAuthLogin();
      if (token) return token;
      // OAuth failed — fall through to manual entry
      p.log.info("Falling back to manual API key entry.");
    } else if (authMethod === "oauth" && existingToken) {
      return existingToken;
    }
    // "manual" or fallback: continue to password prompt below
  }

  const key = guardCancel(
    await p.password({
      message: `Enter ${envKeyName}:`,
      validate: (v) => (!v ? 'API key is required' : undefined),
    })
  );
  if (!key) {
    p.log.warn(`No API key provided. Set ${envKeyName} before running PulSeed.`);
    return undefined;
  }
  return key;
}

async function stepDaemon(): Promise<{ start: boolean; port: number }> {
  const start = guardCancel(
    await p.confirm({
      message: "Start PulSeed as a background daemon after setup?",
      initialValue: false,
    })
  );

  if (!start) return { start: false, port: DEFAULT_PORT };

  // Determine suggested port: DEFAULT_PORT if free, otherwise find the next available one.
  let suggestedPort: number;
  const defaultFree = await isPortAvailable(DEFAULT_PORT);
  if (defaultFree) {
    suggestedPort = DEFAULT_PORT;
  } else {
    try {
      suggestedPort = await findAvailablePort(DEFAULT_PORT + 1);
    } catch {
      suggestedPort = DEFAULT_PORT + 1;
    }
  }

  // Always show the port selection — even when DEFAULT_PORT is free.
  const suggestedLabel = defaultFree
    ? `Use port ${DEFAULT_PORT}`
    : `Use port ${suggestedPort} instead (41700 is in use)`;

  const portChoice = guardCancel(
    await p.select({
      message: "Select a port for the daemon:",
      options: [
        {
          value: "suggested" as const,
          label: suggestedLabel,
          hint: defaultFree ? "default port" : "auto-detected available port",
        },
        {
          value: "custom" as const,
          label: "Enter a custom port",
        },
      ],
    })
  );

  if (portChoice === "suggested") {
    return { start: true, port: suggestedPort };
  }

  // Custom port entry: validate range synchronously, then check availability after.
  // p.text validate must be synchronous, so availability is checked in a retry loop.
  let finalPort: number;
  for (;;) {
    const portInput = guardCancel(
      await p.text({
        message: "Enter a port number:",
        placeholder: String(suggestedPort),
        validate: (v) => {
          if (!v) return "Port is required.";
          const n = parseInt(v, 10);
          if (isNaN(n) || !Number.isInteger(n)) return "Port must be a whole number.";
          if (n < 1024 || n > 65535) return "Port must be between 1024 and 65535.";
          return undefined;
        },
      })
    );
    const candidate = parseInt(portInput, 10);
    if (await isPortAvailable(candidate)) {
      finalPort = candidate;
      break;
    }
    p.log.warn(`Port ${candidate} is already in use. Please try another.`);
  }

  return { start: true, port: finalPort };
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
  const content = DEFAULT_SEED.replace(/^#\s+.+$/m, `# ${agentName}`);
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
  const content = DEFAULT_USER.replace(
    /^(#[^\n]*)\n/m,
    `$1\n\nName: ${userName}\n`
  );
  fs.writeFileSync(path.join(dir, "USER.md"), content, "utf-8");
}

// ─── Main wizard ───

export async function runSetupWizard(): Promise<number> {
  // Step 1: Banner
  console.log(getBanner());
  p.intro("PulSeed Setup");

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
  const { start: startDaemon, port: daemonPort } = await stepDaemon();

  // Step 9: Confirm
  const summaryLines = [
    `User:      ${userName}`,
    `Agent:     ${agentName}`,
    `Style:     ${ROOT_PRESETS[rootPreset].name}`,
    `Provider:  ${provider}`,
    `Model:     ${model}`,
    `Adapter:   ${adapter}`,
    `API Key:   ${maskKey(apiKey)}`,
    `Daemon:    ${startDaemon ? `yes (port ${daemonPort})` : "no"}`,
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
    // Persist the chosen port into daemon.json so DaemonRunner picks it up
    const daemonConfigPath = path.join(dir, "daemon.json");
    try {
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(daemonConfigPath)) {
        existing = JSON.parse(fs.readFileSync(daemonConfigPath, "utf-8")) as Record<string, unknown>;
      }
      existing["event_server_port"] = daemonPort;
      fs.writeFileSync(daemonConfigPath, JSON.stringify(existing, null, 2), "utf-8");
    } catch {
      p.log.warn("Could not save daemon port to daemon.json");
    }
    p.log.info("Daemon port " + daemonPort + " saved. Run pulseed to start.");
  }

  p.outro("\ud83c\udf31 Seeds planted. Time to grow.");
  return 0;
}
