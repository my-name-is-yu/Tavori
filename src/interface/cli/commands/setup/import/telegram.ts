import * as path from "node:path";
import { SOURCE_LABELS } from "./constants.js";
import { pathExists, readJson, safeImportName } from "./fs-utils.js";
import { collectRecords, isRecord, nestedRecord, stringValue } from "./parse.js";
import type { SetupImportItem, SetupImportSourceId, SetupImportTelegramSettings } from "./types.js";

function secretString(value: unknown, env: Record<string, string>): string | undefined {
  if (typeof value === "string" && value.trim()) {
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim());
    if (match) return env[match[1]!];
    return value.trim();
  }
  if (!isRecord(value)) return undefined;
  if (value["source"] === "env" && typeof value["id"] === "string") {
    return env[value["id"]];
  }
  return undefined;
}

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.flatMap((item) => {
    if (typeof item === "number" && Number.isInteger(item)) return [item];
    if (typeof item === "string") {
      const parsed = parseInt(item, 10);
      return Number.isInteger(parsed) ? [parsed] : [];
    }
    return [];
  });
  return numbers.length > 0 ? numbers : undefined;
}

function findTelegramRecord(records: Record<string, unknown>[]): Record<string, unknown> | undefined {
  for (const record of records) {
    const channels = nestedRecord(record, "channels");
    const telegram = channels ? nestedRecord(channels, "telegram") : undefined;
    if (telegram) return telegram;

    const messaging = nestedRecord(record, "messaging");
    const messagingTelegram = messaging ? nestedRecord(messaging, "telegram") : undefined;
    if (messagingTelegram) return messagingTelegram;
  }
  return undefined;
}

function findDefaultAccount(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const accounts = record ? nestedRecord(record, "accounts") : undefined;
  return accounts ? nestedRecord(accounts, "default") : undefined;
}

export function extractTelegramSettings(
  raw: unknown,
  env: Record<string, string>
): SetupImportTelegramSettings | undefined {
  const records = collectRecords(raw);
  if (records.length === 0) return undefined;
  const telegram = findTelegramRecord(records);
  const account = findDefaultAccount(telegram);
  const searchable = [account, telegram].filter((item): item is Record<string, unknown> => Boolean(item));
  const botToken = searchable
    .map((record) => secretString(record["botToken"] ?? record["bot_token"] ?? record["token"], env))
    .find(Boolean);
  const allowedUserIds = searchable
    .map((record) => numberArray(record["allowFrom"] ?? record["allowedUserIds"] ?? record["allowed_user_ids"]))
    .find(Boolean);
  if (!botToken && !allowedUserIds) return undefined;
  return {
    ...(botToken ? { botToken } : {}),
    ...(allowedUserIds ? { allowedUserIds } : {}),
  };
}

export function telegramCredentialItems(
  source: SetupImportSourceId,
  rootDir: string
): SetupImportItem[] {
  const credentialPaths = [
    path.join(rootDir, "credentials", "telegram-default-allowFrom.json"),
  ].filter(pathExists);
  return credentialPaths.flatMap((credentialPath) => {
    const raw = readJson(credentialPath);
    const allowedUserIds = isRecord(raw) ? numberArray(raw["allowFrom"] ?? raw["allowed_user_ids"]) : numberArray(raw);
    if (!allowedUserIds) return [];
    return [{
      id: `${source}:telegram:${safeImportName(path.basename(credentialPath))}`,
      source,
      sourceLabel: SOURCE_LABELS[source],
      kind: "telegram" as const,
      label: "telegram allowed users",
      sourcePath: credentialPath,
      decision: "import" as const,
      reason: "Telegram allowed user IDs",
      telegramSettings: { allowedUserIds },
    }];
  });
}

export function buildTelegramItem(
  source: SetupImportSourceId,
  configPath: string,
  settings: SetupImportTelegramSettings
): SetupImportItem {
  const label = [
    settings.botToken ? "bot token" : undefined,
    settings.allowedUserIds?.length ? `${settings.allowedUserIds.length} allowed user(s)` : undefined,
  ].filter(Boolean).join(" / ");
  return {
    id: `${source}:telegram:${path.basename(configPath)}`,
    source,
    sourceLabel: SOURCE_LABELS[source],
    kind: "telegram",
    label: label || "telegram settings",
    sourcePath: configPath,
    decision: "import",
    reason: "Telegram bot and allowed-user defaults",
    telegramSettings: settings,
  };
}
