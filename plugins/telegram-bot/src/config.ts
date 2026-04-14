import * as fs from "node:fs";
import * as path from "node:path";

// ─── Config type ───

export interface TelegramConfig {
  bot_token: string;
  chat_id?: number;
  allowed_user_ids: number[];
  denied_user_ids: number[];
  allowed_chat_ids: number[];
  denied_chat_ids: number[];
  runtime_control_allowed_user_ids: number[];
  chat_goal_map: Record<string, string>;
  user_goal_map: Record<string, string>;
  default_goal_id?: string;
  allow_all: boolean;
  polling_timeout: number;
  identity_key?: string;
}

// ─── Config loader + validator ───

export function loadConfig(pluginDir: string): TelegramConfig {
  const configPath = path.join(pluginDir, "config.json");

  let raw: unknown;
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    raw = JSON.parse(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`telegram-bot: failed to read config.json — ${msg}`);
  }

  return validateConfig(raw);
}

function validateConfig(raw: unknown): TelegramConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("telegram-bot: config must be a JSON object");
  }

  const cfg = raw as Record<string, unknown>;

  if (typeof cfg["bot_token"] !== "string" || cfg["bot_token"].length === 0) {
    throw new Error("telegram-bot: bot_token must be a non-empty string");
  }
  if (cfg["chat_id"] !== undefined && (typeof cfg["chat_id"] !== "number" || !Number.isInteger(cfg["chat_id"]))) {
    throw new Error("telegram-bot: chat_id must be an integer when set");
  }

  const allowedUserIds = cfg["allowed_user_ids"] ?? [];
  if (!Array.isArray(allowedUserIds) || !allowedUserIds.every((id) => Number.isInteger(id))) {
    throw new Error("telegram-bot: allowed_user_ids must be an array of integers");
  }
  const deniedUserIds = cfg["denied_user_ids"] ?? cfg["deny_from"] ?? [];
  const allowedChatIds = cfg["allowed_chat_ids"] ?? [];
  const deniedChatIds = cfg["denied_chat_ids"] ?? [];
  for (const [key, value] of Object.entries({
    denied_user_ids: deniedUserIds,
    allowed_chat_ids: allowedChatIds,
    denied_chat_ids: deniedChatIds,
  })) {
    if (!Array.isArray(value) || !value.every((id) => Number.isInteger(id))) {
      throw new Error(`telegram-bot: ${key} must be an array of integers`);
    }
  }

  const runtimeControlAllowedUserIds = cfg["runtime_control_allowed_user_ids"] ?? [];
  if (
    !Array.isArray(runtimeControlAllowedUserIds) ||
    !runtimeControlAllowedUserIds.every((id) => Number.isInteger(id))
  ) {
    throw new Error("telegram-bot: runtime_control_allowed_user_ids must be an array of integers");
  }

  const allowAll = cfg["allow_all"] ?? false;
  if (typeof allowAll !== "boolean") {
    throw new Error("telegram-bot: allow_all must be a boolean");
  }

  const pollingTimeout = cfg["polling_timeout"] ?? 30;
  if (typeof pollingTimeout !== "number" || !Number.isInteger(pollingTimeout)) {
    throw new Error("telegram-bot: polling_timeout must be an integer");
  }
  if (cfg["identity_key"] !== undefined && (typeof cfg["identity_key"] !== "string" || cfg["identity_key"].trim().length === 0)) {
    throw new Error("telegram-bot: identity_key must be a non-empty string when set");
  }
  const chatGoalMap = cfg["chat_goal_map"] ?? cfg["goal_routes"] ?? {};
  const userGoalMap = cfg["user_goal_map"] ?? {};
  for (const [key, value] of Object.entries({ chat_goal_map: chatGoalMap, user_goal_map: userGoalMap })) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Object.values(value).every((goalId) => typeof goalId === "string" && goalId.length > 0)
    ) {
      throw new Error(`telegram-bot: ${key} must be an object mapping IDs to goal IDs`);
    }
  }
  if (cfg["default_goal_id"] !== undefined && (typeof cfg["default_goal_id"] !== "string" || cfg["default_goal_id"].length === 0)) {
    throw new Error("telegram-bot: default_goal_id must be a non-empty string when set");
  }

  return {
    bot_token: cfg["bot_token"] as string,
    chat_id: cfg["chat_id"] as number | undefined,
    allowed_user_ids: allowedUserIds as number[],
    denied_user_ids: deniedUserIds as number[],
    allowed_chat_ids: allowedChatIds as number[],
    denied_chat_ids: deniedChatIds as number[],
    runtime_control_allowed_user_ids: runtimeControlAllowedUserIds as number[],
    chat_goal_map: chatGoalMap as Record<string, string>,
    user_goal_map: userGoalMap as Record<string, string>,
    default_goal_id: cfg["default_goal_id"] as string | undefined,
    allow_all: allowAll,
    polling_timeout: Math.min(Math.max(pollingTimeout as number, 1), 60),
    identity_key: cfg["identity_key"] as string | undefined,
  };
}
