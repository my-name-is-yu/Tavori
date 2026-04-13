import * as fs from "node:fs";
import * as path from "node:path";

export interface DiscordBotConfig {
  application_id: string;
  public_key_hex?: string;
  bot_token: string;
  channel_id: string;
  identity_key: string;
  runtime_control_allowed_sender_ids: string[];
  command_name: string;
  host: string;
  port: number;
  ephemeral: boolean;
}

export function loadConfig(pluginDir: string): DiscordBotConfig {
  const configPath = path.join(pluginDir, "config.json");
  let raw: unknown;

  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`discord-bot: failed to read config.json — ${msg}`);
  }

  return validateConfig(raw);
}

function validateConfig(raw: unknown): DiscordBotConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("discord-bot: config must be a JSON object");
  }

  const cfg = raw as Record<string, unknown>;
  const commandName = cfg["command_name"] ?? "pulseed";
  const host = cfg["host"] ?? "127.0.0.1";
  const port = cfg["port"] ?? 8787;
  const ephemeral = cfg["ephemeral"] ?? false;
  const runtimeControlAllowedSenderIds = cfg["runtime_control_allowed_sender_ids"] ?? [];

  if (typeof cfg["application_id"] !== "string" || cfg["application_id"].length === 0) {
    throw new Error("discord-bot: application_id must be a non-empty string");
  }
  if (typeof cfg["bot_token"] !== "string" || cfg["bot_token"].length === 0) {
    throw new Error("discord-bot: bot_token must be a non-empty string");
  }
  if (typeof cfg["channel_id"] !== "string" || cfg["channel_id"].length === 0) {
    throw new Error("discord-bot: channel_id must be a non-empty string");
  }
  if (typeof cfg["identity_key"] !== "string" || cfg["identity_key"].length === 0) {
    throw new Error("discord-bot: identity_key must be a non-empty string");
  }
  if (typeof commandName !== "string" || commandName.length === 0) {
    throw new Error("discord-bot: command_name must be a non-empty string");
  }
  if (typeof host !== "string" || host.length === 0) {
    throw new Error("discord-bot: host must be a non-empty string");
  }
  if (typeof port !== "number" || !Number.isInteger(port)) {
    throw new Error("discord-bot: port must be an integer");
  }
  if (typeof ephemeral !== "boolean") {
    throw new Error("discord-bot: ephemeral must be a boolean");
  }
  if (
    !Array.isArray(runtimeControlAllowedSenderIds) ||
    !runtimeControlAllowedSenderIds.every((id) => typeof id === "string" && id.length > 0)
  ) {
    throw new Error("discord-bot: runtime_control_allowed_sender_ids must be an array of non-empty strings");
  }
  if (cfg["public_key_hex"] !== undefined && typeof cfg["public_key_hex"] !== "string") {
    throw new Error("discord-bot: public_key_hex must be a string when set");
  }

  return {
    application_id: cfg["application_id"] as string,
    public_key_hex: cfg["public_key_hex"] as string | undefined,
    bot_token: cfg["bot_token"] as string,
    channel_id: cfg["channel_id"] as string,
    identity_key: cfg["identity_key"] as string,
    runtime_control_allowed_sender_ids: runtimeControlAllowedSenderIds as string[],
    command_name: commandName,
    host,
    port,
    ephemeral,
  };
}
