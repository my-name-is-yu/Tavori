import * as p from "@clack/prompts";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  saveProviderConfig,
  validateProviderConfig,
} from "../../../base/llm/provider-config.js";
import type { ProviderConfig } from "../../../base/llm/provider-config.js";
import { clearIdentityCache } from "../../../base/config/identity-loader.js";
import { ROOT_PRESETS } from "./presets/root-presets.js";
import { detectApiKeys, maskKey } from "./setup-shared.js";
import { getBanner, stepExistingConfig, stepUserName, stepSeedyName } from "./setup/steps-identity.js";
import { stepRootPreset, stepProvider, stepModel, stepApiKey } from "./setup/steps-provider.js";
import { stepAdapter } from "./setup/steps-adapter.js";
import { stepNotification } from "./setup/steps-notification.js";
import { stepDaemon, ensurePulseedDir, writeSeedMd, writeRootMd, writeUserMd } from "./setup/steps-runtime.js";
import { guardCancel } from "./setup/utils.js";

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

  const existingChoice = await stepExistingConfig();
  if (existingChoice === "keep") {
    p.outro("Keeping existing configuration.");
    return 0;
  }

  const userName = await stepUserName();
  const agentName = await stepSeedyName();
  const rootPreset = await stepRootPreset();
  const provider = await stepProvider();
  const model = await stepModel(provider);
  const adapter = await stepAdapter(model, provider);
  if (!adapter) return 1;

  const detectedKeys = detectApiKeys();
  const apiKey = await stepApiKey(provider, detectedKeys);

  const { start: startDaemon, port: daemonPort } = await stepDaemon();
  const notificationConfig = await stepNotification();

  const summaryLines = [
    `User:      ${userName}`,
    `Agent:     ${agentName}`,
    `Style:     ${ROOT_PRESETS[rootPreset].name}`,
    `Provider:  ${provider}`,
    `Model:     ${model}`,
    `Adapter:   ${adapter}`,
    `API Key:   ${maskKey(apiKey)}`,
    `Daemon:    ${startDaemon ? `yes (port ${daemonPort})` : "no"}`,
    `Notify:    ${notificationConfig ? "yes" : "no"}`,
  ];
  if (notificationConfig) {
    const channels =
      notificationConfig.channels.length === 0
        ? "console only"
        : notificationConfig.channels.map((channel) => channel.type).join(", ");
    summaryLines.push(`Notify:    ${channels}`);
  }
  p.note(summaryLines.join("\n"), "Configuration Summary");

  const confirmed = guardCancel(
    await p.confirm({ message: "Save this configuration?", initialValue: true })
  );
  if (!confirmed) {
    p.cancel("Setup cancelled.");
    return 0;
  }

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

  if (notificationConfig) {
    const notifPath = path.join(dir, "notification.json");
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(notifPath, JSON.stringify(notificationConfig, null, 2));
    } catch (err) {
      p.log.warn(`Could not save notification config: ${err}`);
    }
  }

  p.outro("\ud83c\udf31 Seeds planted. Time to grow.");
  return 0;
}
