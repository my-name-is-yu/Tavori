import * as fs from "node:fs";
import * as path from "node:path";

export interface DiscordBotConfig {
  application_id: string;
  public_key_hex?: string;
  bot_token: string;
  channel_id: string;
  identity_key: string;
  allowed_sender_ids: string[];
  denied_sender_ids: string[];
  allowed_conversation_ids: string[];
  denied_conversation_ids: string[];
  runtime_control_allowed_sender_ids: string[];
  conversation_goal_map: Record<string, string>;
  sender_goal_map: Record<string, string>;
  default_goal_id?: string;
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
  const allowedSenderIds = cfg["allowed_sender_ids"] ?? cfg["allow_from"] ?? [];
  const deniedSenderIds = cfg["denied_sender_ids"] ?? cfg["deny_from"] ?? [];
  const allowedConversationIds = cfg["allowed_conversation_ids"] ?? [];
  const deniedConversationIds = cfg["denied_conversation_ids"] ?? [];
  const conversationGoalMap = cfg["conversation_goal_map"] ?? cfg["goal_routes"] ?? {};
  const senderGoalMap = cfg["sender_goal_map"] ?? {};

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
  for (const [key, value] of Object.entries({
    allowed_sender_ids: allowedSenderIds,
    denied_sender_ids: deniedSenderIds,
    allowed_conversation_ids: allowedConversationIds,
    denied_conversation_ids: deniedConversationIds,
  })) {
    if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0)) {
      throw new Error(`discord-bot: ${key} must be an array of non-empty strings`);
    }
  }
  for (const [key, value] of Object.entries({
    conversation_goal_map: conversationGoalMap,
    sender_goal_map: senderGoalMap,
  })) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Object.values(value).every((goalId) => typeof goalId === "string" && goalId.length > 0)
    ) {
      throw new Error(`discord-bot: ${key} must be an object mapping IDs to goal IDs`);
    }
  }
  if (cfg["default_goal_id"] !== undefined && (typeof cfg["default_goal_id"] !== "string" || cfg["default_goal_id"].length === 0)) {
    throw new Error("discord-bot: default_goal_id must be a non-empty string when set");
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
    allowed_sender_ids: allowedSenderIds as string[],
    denied_sender_ids: deniedSenderIds as string[],
    allowed_conversation_ids: allowedConversationIds as string[],
    denied_conversation_ids: deniedConversationIds as string[],
    runtime_control_allowed_sender_ids: runtimeControlAllowedSenderIds as string[],
    conversation_goal_map: conversationGoalMap as Record<string, string>,
    sender_goal_map: senderGoalMap as Record<string, string>,
    default_goal_id: cfg["default_goal_id"] as string | undefined,
    command_name: commandName,
    host,
    port,
    ephemeral,
  };
}
