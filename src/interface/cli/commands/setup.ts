// ─── pulseed setup — Setup command entry point ───
//
// Routes to either non-interactive (flag-based) mode or the @clack wizard.

import { parseArgs } from "node:util";
import {
  saveProviderConfig,
  validateProviderConfig,
} from "../../../base/llm/provider-config.js";
import type { ProviderConfig } from "../../../base/llm/provider-config.js";
import {
  PROVIDERS,
  ENV_KEY_NAMES,
  RECOMMENDED_MODELS,
  RECOMMENDED_ADAPTERS,
  MODEL_REGISTRY,
  getAdaptersForModel,
} from "./setup-shared.js";
import type { Provider } from "./setup-shared.js";
import { runSetupWizard } from "./setup-wizard.js";

// ─── Non-interactive mode ───

async function runNonInteractive(argv: string[]): Promise<number> {
  let values: {
    provider?: string;
    model?: string;
    adapter?: string;
    "agentloop-worktree"?: string;
    "agentloop-worktree-base-dir"?: string;
    "agentloop-worktree-keep-debug"?: string;
    "agentloop-worktree-cleanup"?: string;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        provider: { type: "string" },
        model: { type: "string" },
        adapter: { type: "string" },
        "agentloop-worktree": { type: "string" },
        "agentloop-worktree-base-dir": { type: "string" },
        "agentloop-worktree-keep-debug": { type: "string" },
        "agentloop-worktree-cleanup": { type: "string" },
      },
      strict: false,
    }) as {
      values: {
        provider?: string;
        model?: string;
        adapter?: string;
        "agentloop-worktree"?: string;
        "agentloop-worktree-base-dir"?: string;
        "agentloop-worktree-keep-debug"?: string;
        "agentloop-worktree-cleanup"?: string;
      };
    });
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

  if (values["agentloop-worktree"] && !["on", "off"].includes(values["agentloop-worktree"])) {
    console.error('Error: --agentloop-worktree must be "on" or "off".');
    return 1;
  }
  if (values["agentloop-worktree-keep-debug"] && !["true", "false"].includes(values["agentloop-worktree-keep-debug"])) {
    console.error('Error: --agentloop-worktree-keep-debug must be "true" or "false".');
    return 1;
  }
  if (values["agentloop-worktree-cleanup"] && !["on_success", "always", "never"].includes(values["agentloop-worktree-cleanup"])) {
    console.error('Error: --agentloop-worktree-cleanup must be one of "on_success", "always", "never".');
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
  if (
    values["agentloop-worktree"]
    || values["agentloop-worktree-base-dir"] !== undefined
    || values["agentloop-worktree-keep-debug"]
    || values["agentloop-worktree-cleanup"]
  ) {
    config.agent_loop = {
      worktree: {
        ...(values["agentloop-worktree"] ? { enabled: values["agentloop-worktree"] === "on" } : {}),
        ...(values["agentloop-worktree-base-dir"] !== undefined ? { base_dir: values["agentloop-worktree-base-dir"] } : {}),
        ...(values["agentloop-worktree-keep-debug"] ? { keep_for_debug: values["agentloop-worktree-keep-debug"] === "true" } : {}),
        ...(values["agentloop-worktree-cleanup"] ? { cleanup_policy: values["agentloop-worktree-cleanup"] as "on_success" | "always" | "never" } : {}),
      },
    };
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

// ─── Help text ───

const HELP_TEXT = `Usage: pulseed setup [options]

Interactive setup wizard for provider configuration.

Options:
  --provider <name>   LLM provider (openai, anthropic, ollama)
  --model <name>      Model name (e.g., gpt-5.4-mini)
  --adapter <name>    Execution adapter (agent_loop, openai_codex_cli, claude_code_cli, etc.)
  --agentloop-worktree <on|off>
                      Enable isolated git worktrees for native task agentloop
  --agentloop-worktree-base-dir <path>
                      Base directory for isolated worktrees
  --agentloop-worktree-keep-debug <true|false>
                      Keep worktrees after execution for debugging
  --agentloop-worktree-cleanup <on_success|always|never>
                      Cleanup policy for isolated worktrees
  --help, -h          Show this help

Note: Non-interactive mode only configures provider settings. Identity files
(SEED.md, ROOT.md, USER.md) are only configured in interactive mode.
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

  // Interactive mode: delegate to @clack wizard
  return runSetupWizard();
}
