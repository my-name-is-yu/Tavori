import * as p from "@clack/prompts";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  loadProviderConfig,
  saveProviderConfig,
  validateProviderConfig,
} from "../../../base/llm/provider-config.js";
import type { ProviderConfig } from "../../../base/llm/provider-config.js";
import { clearIdentityCache } from "../../../base/config/identity-loader.js";
import { isDaemonRunning } from "../../../runtime/daemon/client.js";
import { ROOT_PRESETS } from "./presets/root-presets.js";
import { detectApiKeys, getAdaptersForModel, maskKey } from "./setup-shared.js";
import type { Provider } from "./setup-shared.js";
import { getBanner, stepExistingConfig, stepUserName, stepSeedyName } from "./setup/steps-identity.js";
import { stepRootPreset, stepProvider, stepModel, stepApiKey } from "./setup/steps-provider.js";
import { stepAdapter } from "./setup/steps-adapter.js";
import { stepNotification } from "./setup/steps-notification.js";
import { stepDaemon, ensurePulseedDir, writeSeedMd, writeRootMd, writeUserMd } from "./setup/steps-runtime.js";
import { guardCancel } from "./setup/utils.js";
import { applySetupImportSelection } from "./setup/import/apply.js";
import { providerConfigPatchFromImport, stepSetupImport } from "./setup/import/flow.js";

type SetupAnswers = {
  userName: string;
  agentName: string;
  rootPreset: keyof typeof ROOT_PRESETS;
  provider: Provider;
  model: string;
  adapter: string;
  apiKey?: string;
  startDaemon: boolean;
  daemonPort: number;
  notificationConfig: Awaited<ReturnType<typeof stepNotification>>;
};

type IdentityAnswers = Pick<SetupAnswers, "userName" | "agentName" | "rootPreset">;
type ExecutionAnswers = Pick<SetupAnswers, "provider" | "model" | "adapter" | "apiKey">;
type RuntimeAnswers = Pick<SetupAnswers, "startDaemon" | "daemonPort" | "notificationConfig">;
type FullSetupSection = "identity" | "execution" | "runtime" | "review";

function formatSummary(answers: SetupAnswers): string {
  const notificationChannels = answers.notificationConfig
    ? answers.notificationConfig.channels.length === 0
      ? "console only"
      : answers.notificationConfig.channels.map((channel) => channel.type).join(", ")
    : "no";

  return [
    `User:      ${answers.userName}`,
    `Agent:     ${answers.agentName}`,
    `Style:     ${ROOT_PRESETS[answers.rootPreset].name}`,
    `Provider:  ${answers.provider}`,
    `Model:     ${answers.model}`,
    `Adapter:   ${answers.adapter}`,
    `API Key:   ${maskKey(answers.apiKey)}`,
    `Daemon:    ${answers.startDaemon ? `configured (port ${answers.daemonPort})` : "not configured"}`,
    `Notify:    ${notificationChannels}`,
  ].join("\n");
}

function formatExecutionSummary(
  execution: Pick<SetupAnswers, "provider" | "model" | "adapter" | "apiKey">
): string {
  return [
    `Provider:  ${execution.provider}`,
    `Model:     ${execution.model}`,
    `Adapter:   ${execution.adapter}`,
    `API Key:   ${maskKey(execution.apiKey)}`,
  ].join("\n");
}

function buildProviderConfig(
  execution: Pick<SetupAnswers, "provider" | "model" | "adapter" | "apiKey">,
  base?: Partial<ProviderConfig>
): ProviderConfig {
  const config: ProviderConfig = {
    ...(base ?? {}),
    provider: execution.provider,
    model: execution.model,
    adapter: execution.adapter as ProviderConfig["adapter"],
  };

  if (execution.apiKey) {
    config.api_key = execution.apiKey;
  } else {
    delete config.api_key;
  }

  if (base?.provider && base.provider !== execution.provider) {
    delete config.base_url;
    delete config.openclaw;
  }

  return config;
}

async function stepExecutionConfig(
  current?: ExecutionAnswers
): Promise<ExecutionAnswers> {
  const provider = await stepProvider(current?.provider);
  const initialModel = current?.provider === provider ? current.model : undefined;
  const model = await stepModel(provider, initialModel);
  const adaptersForModel = getAdaptersForModel(model, provider);
  const initialAdapter =
    current?.provider === provider && adaptersForModel.includes(current.adapter)
      ? current.adapter
      : undefined;
  const adapter = await stepAdapter(model, provider, initialAdapter);
  if (!adapter) return { provider, model, adapter, apiKey: current?.apiKey };

  const detectedKeys = detectApiKeys();
  const apiKey =
    current?.provider === provider
      ? await stepApiKey(provider, detectedKeys, current.apiKey, adapter)
      : await stepApiKey(provider, detectedKeys, undefined, adapter);
  return { provider, model, adapter, apiKey };
}

async function stepIdentityConfig(current?: Partial<IdentityAnswers>): Promise<IdentityAnswers> {
  return {
    userName: await stepUserName(current?.userName),
    agentName: await stepSeedyName(current?.agentName),
    rootPreset: await stepRootPreset(current?.rootPreset),
  };
}

async function stepRuntimeConfig(): Promise<RuntimeAnswers> {
  const daemonConfig = await stepDaemon();
  return {
    startDaemon: daemonConfig.start,
    daemonPort: daemonConfig.port,
    notificationConfig: await stepNotification(),
  };
}

async function stepSectionNavigation(
  message: string,
  backLabel?: string
): Promise<"continue" | "back" | "edit" | "cancel"> {
  const options: p.Option<"continue" | "back" | "edit" | "cancel">[] = [
    { value: "continue", label: "Continue" },
    { value: "edit", label: "Edit this section" },
  ];

  if (backLabel) {
    options.push({ value: "back", label: backLabel });
  }
  options.push({ value: "cancel", label: "Cancel setup" });

  return guardCancel(
    await p.select({
      message,
      options,
      initialValue: "continue" as const,
    })
  );
}

async function validateAndSaveProviderConfig(config: ProviderConfig): Promise<number | undefined> {
  const validation = validateProviderConfig(config);
  if (!validation.valid) {
    for (const err of validation.errors) {
      p.log.error(err);
    }
    return 1;
  }

  const fileConfig: ProviderConfig = { ...config };
  const apiKey = fileConfig.api_key;
  delete fileConfig.api_key;
  await saveProviderConfig(fileConfig);
  if (apiKey) {
    saveProviderApiKeyToEnv(config.provider, apiKey);
  }
  return undefined;
}

function saveProviderApiKeyToEnv(provider: ProviderConfig["provider"], apiKey: string): void {
  const envKey = provider === "openai"
    ? "OPENAI_API_KEY"
    : provider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : undefined;
  if (!envKey) return;

  const dir = ensurePulseedDir();
  const envPath = path.join(dir, ".env");
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
  } catch {
    lines = [];
  }

  const replacement = `${envKey}=${apiKey}`;
  let replaced = false;
  lines = lines.map((line) => {
    if (line.startsWith(`${envKey}=`)) {
      replaced = true;
      return replacement;
    }
    return line;
  }).filter((line, index, all) => line || index < all.length - 1);
  if (!replaced) lines.push(replacement);
  fs.writeFileSync(envPath, `${lines.join("\n")}\n`, "utf-8");
}

async function startDaemonDetached(baseDir: string): Promise<number | undefined> {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error("Could not determine CLI entrypoint for daemon start.");
  }

  const child = spawn(process.execPath, [scriptPath, "daemon", "start", "--detach"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PULSEED_HOME: baseDir,
    },
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
  return child.pid;
}

async function waitForDaemonReady(
  baseDir: string,
  expectedPort: number,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { running, port } = await isDaemonRunning(baseDir);
    if (running && port === expectedPort) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Daemon did not respond on port ${expectedPort} within ${timeoutMs}ms.`);
}

async function startDaemonAfterSetup(baseDir: string, port: number): Promise<void> {
  p.log.info(`Starting daemon and gateway on port ${port}...`);
  const pid = await startDaemonDetached(baseDir);
  await waitForDaemonReady(baseDir, port);
  p.log.success(`Daemon and gateway started${pid ? ` (PID: ${pid})` : ""} on port ${port}.`);
}

export async function runSetupWizard(): Promise<number> {
  console.log(getBanner());
  p.intro("PulSeed Setup");

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

  const importSelection = await stepSetupImport();
  const importedProviderPatch = providerConfigPatchFromImport(importSelection?.providerSettings);

  if (!importSelection) {
    const existingChoice = await stepExistingConfig();
    if (existingChoice === "keep") {
      p.outro("Keeping existing configuration.");
      return 0;
    }

    if (existingChoice === "modify") {
      const existingConfig = await loadProviderConfig();
      let execution = await stepExecutionConfig({
        provider: existingConfig.provider,
        model: existingConfig.model,
        adapter: existingConfig.adapter,
        apiKey: existingConfig.api_key,
      });
      if (!execution.adapter) return 1;

      for (;;) {
        p.note(formatExecutionSummary(execution), "Review provider settings");

        const action = guardCancel(
          await p.select({
            message: "Save these provider settings?",
            options: [
              { value: "save" as const, label: "Save provider settings" },
              { value: "edit" as const, label: "Edit provider, model, adapter" },
              { value: "cancel" as const, label: "Cancel setup" },
            ],
            initialValue: "save" as const,
          })
        );

        if (action === "save") break;
        if (action === "cancel") {
          p.cancel("Setup cancelled.");
          return 0;
        }
        execution = await stepExecutionConfig(execution);
        if (!execution.adapter) return 1;
      }

      const saveResult = await validateAndSaveProviderConfig(buildProviderConfig(execution, existingConfig));
      if (saveResult !== undefined) return saveResult;
      p.outro("Provider settings updated.");
      return 0;
    }
  }

  let answers: SetupAnswers = {
    userName: "",
    agentName: "Seedy",
    rootPreset: "default",
    provider: importedProviderPatch?.provider ?? "openai",
    model: importedProviderPatch?.model ?? "",
    adapter: importedProviderPatch?.adapter ?? "",
    apiKey: importedProviderPatch?.api_key,
    startDaemon: false,
    daemonPort: 0,
    notificationConfig: null,
  };
  let section: FullSetupSection = "identity";
  let finalAnswers: SetupAnswers | undefined;

  while (!finalAnswers) {
    if (section === "identity") {
      Object.assign(answers, await stepIdentityConfig(answers.userName ? answers : undefined));
      const next = await stepSectionNavigation("Identity settings complete.");
      if (next === "cancel") {
        p.cancel("Setup cancelled.");
        return 0;
      }
      if (next === "continue") {
        section = "execution";
      }
      continue;
    }

    if (section === "execution") {
      Object.assign(answers, await stepExecutionConfig(importSelection || answers.adapter ? answers : undefined));
      if (!answers.adapter) return 1;
      const next = await stepSectionNavigation(
        "Provider settings complete.",
        "Back to identity settings"
      );
      if (next === "cancel") {
        p.cancel("Setup cancelled.");
        return 0;
      }
      if (next === "back") {
        section = "identity";
      } else if (next === "continue") {
        section = "runtime";
      }
      continue;
    }

    if (section === "runtime") {
      Object.assign(answers, await stepRuntimeConfig());
      const next = await stepSectionNavigation(
        "Daemon and notification settings complete.",
        "Back to provider settings"
      );
      if (next === "cancel") {
        p.cancel("Setup cancelled.");
        return 0;
      }
      if (next === "back") {
        section = "execution";
      } else if (next === "continue") {
        section = "review";
      }
      continue;
    }

    if (section === "review") {
      p.note(formatSummary(answers), "Review configuration");

      const action = guardCancel(
        await p.select({
          message: "Save this configuration?",
          options: [
            { value: "save" as const, label: "Save configuration", hint: "write files and finish" },
            { value: "edit-execution" as const, label: "Edit provider, model, adapter" },
            { value: "edit-identity" as const, label: "Edit user, agent, style" },
            { value: "edit-runtime" as const, label: "Edit daemon and notifications" },
            { value: "cancel" as const, label: "Cancel setup" },
          ],
          initialValue: "save" as const,
        })
      );

      if (action === "save") {
        finalAnswers = answers;
      } else if (action === "cancel") {
        p.cancel("Setup cancelled.");
        return 0;
      } else if (action === "edit-execution") {
        section = "execution";
      } else if (action === "edit-identity") {
        section = "identity";
      } else if (action === "edit-runtime") {
        section = "runtime";
      }
    }
  }

  const dir = ensurePulseedDir();

  const saveResult = await validateAndSaveProviderConfig(buildProviderConfig(finalAnswers, importedProviderPatch));
  if (saveResult !== undefined) return saveResult;
  writeSeedMd(dir, finalAnswers.agentName);
  writeRootMd(dir, finalAnswers.rootPreset);
  writeUserMd(dir, finalAnswers.userName);
  clearIdentityCache();

  if (finalAnswers.startDaemon) {
    const daemonConfigPath = path.join(dir, "daemon.json");
    try {
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(daemonConfigPath)) {
        existing = JSON.parse(fs.readFileSync(daemonConfigPath, "utf-8")) as Record<string, unknown>;
      }
      existing["event_server_port"] = finalAnswers.daemonPort;
      fs.writeFileSync(daemonConfigPath, JSON.stringify(existing, null, 2), "utf-8");
    } catch {
      p.log.warn("Could not save daemon port to daemon.json");
    }
    p.log.info("Daemon port " + finalAnswers.daemonPort + " saved. Start it later with pulseed daemon start or pulseed start --goal <goal-id>.");
  }

  if (finalAnswers.notificationConfig) {
    const notifPath = path.join(dir, "notification.json");
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(notifPath, JSON.stringify(finalAnswers.notificationConfig, null, 2));
    } catch (err) {
      p.log.warn(`Could not save notification config: ${err}`);
    }
  }

  if (importSelection) {
    try {
      const report = await applySetupImportSelection(dir, importSelection);
      const appliedCount = report.items.filter((item) => item.status === "applied").length;
      const failedCount = report.items.filter((item) => item.status === "failed").length;
      p.log.info(
        `Imported ${appliedCount} item${appliedCount === 1 ? "" : "s"}` +
          (failedCount > 0 ? ` (${failedCount} failed; see import report).` : ".")
      );
    } catch (err) {
      p.log.warn(`Configuration saved, but import side effects failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (finalAnswers.startDaemon) {
    try {
      await startDaemonAfterSetup(dir, finalAnswers.daemonPort);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.warn(
        `Configuration saved, but daemon/gateway did not start: ${message}. ` +
          "Run `pulseed daemon start --detach` to try again."
      );
    }
  }

  p.outro("\ud83c\udf31 Seeds planted. Time to grow.");
  return 0;
}
