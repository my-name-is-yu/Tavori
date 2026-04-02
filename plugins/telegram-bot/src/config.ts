import * as fs from "node:fs";
import * as path from "node:path";

// ─── Config type ───

export interface TelegramConfig {
  bot_token: string;
  chat_id: number;
  allowed_user_ids: number[];
  polling_timeout: number;
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
  if (typeof cfg["chat_id"] !== "number" || !Number.isInteger(cfg["chat_id"])) {
    throw new Error("telegram-bot: chat_id must be an integer");
  }

  const allowedUserIds = cfg["allowed_user_ids"] ?? [];
  if (!Array.isArray(allowedUserIds) || !allowedUserIds.every((id) => Number.isInteger(id))) {
    throw new Error("telegram-bot: allowed_user_ids must be an array of integers");
  }

  const pollingTimeout = cfg["polling_timeout"] ?? 30;
  if (typeof pollingTimeout !== "number" || !Number.isInteger(pollingTimeout)) {
    throw new Error("telegram-bot: polling_timeout must be an integer");
  }

  return {
    bot_token: cfg["bot_token"] as string,
    chat_id: cfg["chat_id"] as number,
    allowed_user_ids: allowedUserIds as number[],
    polling_timeout: Math.min(Math.max(pollingTimeout as number, 1), 60),
  };
}
