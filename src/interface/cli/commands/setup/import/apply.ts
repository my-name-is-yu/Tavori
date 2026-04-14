import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../../../../base/utils/json-io.js";
import type { MCPServerConfig, MCPServersConfig } from "../../../../../base/types/mcp.js";
import { copyDirectoryNoSymlinks, safeImportName, uniqueImportPath } from "./fs-utils.js";
import type {
  SetupImportAppliedItem,
  SetupImportItem,
  SetupImportReport,
  SetupImportSelection,
} from "./types.js";

interface TelegramPluginConfig {
  bot_token?: string;
  chat_id?: number;
  allowed_user_ids?: number[];
  runtime_control_allowed_user_ids?: number[];
  allow_all?: boolean;
  polling_timeout?: number;
  identity_key?: string;
}

function nextMcpId(existing: Set<string>, requested: string): string {
  const base = safeImportName(requested);
  if (!existing.has(base)) return base;
  let suffix = 2;
  for (;;) {
    const candidate = `${base}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
    suffix += 1;
  }
}

async function mergeMcpServers(baseDir: string, servers: MCPServerConfig[]): Promise<string | undefined> {
  if (servers.length === 0) return undefined;
  const configPath = path.join(baseDir, "mcp-servers.json");
  const current = await readJsonFileOrNull<MCPServersConfig>(configPath);
  const existingServers = Array.isArray(current?.servers) ? current.servers : [];
  const existingIds = new Set<string>(existingServers.map((server) => server.id));
  const imported = servers.map((server) => {
    const id = nextMcpId(existingIds, server.id);
    existingIds.add(id);
    return { ...server, id, enabled: false };
  });

  await writeJsonFileAtomic(configPath, { servers: [...existingServers, ...imported] });
  return configPath;
}

async function applyFileItem(baseDir: string, item: SetupImportItem): Promise<SetupImportAppliedItem> {
  if (!item.sourcePath) {
    return {
      id: item.id,
      source: item.source,
      kind: item.kind,
      label: item.label,
      decision: item.decision,
      status: "skipped",
      reason: "no source path",
    };
  }

  if (item.kind === "skill") {
    const parentDir = path.join(baseDir, "skills", "imported", item.source);
    const targetPath = await uniqueImportPath(parentDir, item.label);
    await copyDirectoryNoSymlinks(item.sourcePath, targetPath);
    return {
      id: item.id,
      source: item.source,
      kind: item.kind,
      label: item.label,
      decision: item.decision,
      status: "applied",
      targetPath,
    };
  }

  if (item.kind === "plugin") {
    const parentDir = path.join(baseDir, "plugins-imported-disabled", item.source);
    const targetPath = await uniqueImportPath(parentDir, item.label);
    await copyDirectoryNoSymlinks(item.sourcePath, targetPath);
    return {
      id: item.id,
      source: item.source,
      kind: item.kind,
      label: item.label,
      decision: item.decision,
      status: "applied",
      targetPath,
    };
  }

  return {
    id: item.id,
    source: item.source,
    kind: item.kind,
    label: item.label,
    decision: item.decision,
    status: "skipped",
    reason: "not a file copy item",
  };
}

function reportItem(item: SetupImportItem, status: SetupImportAppliedItem["status"], reason?: string): SetupImportAppliedItem {
  return {
    id: item.id,
    source: item.source,
    kind: item.kind,
    label: item.label,
    decision: item.decision,
    status,
    ...(reason ? { reason } : {}),
  };
}

async function copyTelegramPluginYaml(pluginDir: string): Promise<void> {
  const destYaml = path.join(pluginDir, "plugin.yaml");
  const minimal = [
    "name: telegram-bot",
    "version: 1.0.0",
    "type: notifier",
    "capabilities:",
    "  - telegram_notification",
    "  - bidirectional_chat",
    "description: \"Telegram bot plugin for PulSeed\"",
    "config_schema:",
    "  bot_token:",
    "    type: string",
    "    required: true",
    "  chat_id:",
    "    type: number",
    "    required: false",
    "entry_point: \"dist/index.js\"",
    "permissions:",
    "  network: true",
  ].join("\n") + "\n";
  await fsp.mkdir(pluginDir, { recursive: true });
  try {
    await fsp.access(destYaml);
  } catch {
    await fsp.writeFile(destYaml, minimal, "utf-8");
  }
}

async function applyTelegramConfig(baseDir: string, items: SetupImportItem[]): Promise<string | undefined> {
  const selected = items.filter((item) => item.kind === "telegram" && item.telegramSettings);
  if (selected.length === 0) return undefined;
  const pluginDir = path.join(baseDir, "plugins", "telegram-bot");
  const configPath = path.join(pluginDir, "config.json");
  const current = await readJsonFileOrNull<TelegramPluginConfig>(configPath);
  const allowed = new Set<number>(current?.allowed_user_ids ?? []);
  const runtimeAllowed = new Set<number>(current?.runtime_control_allowed_user_ids ?? []);
  let botToken = current?.bot_token;

  for (const item of selected) {
    if (item.telegramSettings?.botToken) botToken = item.telegramSettings.botToken;
    for (const id of item.telegramSettings?.allowedUserIds ?? []) {
      allowed.add(id);
      runtimeAllowed.add(id);
    }
  }

  const config: TelegramPluginConfig = {
    ...(current ?? {}),
    ...(botToken ? { bot_token: botToken } : {}),
    allowed_user_ids: [...allowed],
    runtime_control_allowed_user_ids: [...runtimeAllowed],
    allow_all: current?.allow_all ?? false,
    polling_timeout: current?.polling_timeout ?? 30,
  };
  await writeJsonFileAtomic(configPath, config);
  await copyTelegramPluginYaml(pluginDir);
  return configPath;
}

export async function applySetupImportSelection(
  baseDir: string,
  selection: SetupImportSelection
): Promise<SetupImportReport> {
  const applied: SetupImportAppliedItem[] = [];
  const selectedItems = selection.items.filter((item) => item.decision !== "skip");

  for (const item of selectedItems) {
    try {
      if (item.kind === "provider") {
        applied.push(reportItem(item, "applied", "provider settings seeded into setup answers"));
      } else if (item.kind === "telegram") {
        applied.push(reportItem(item, "applied", "telegram settings seeded into plugin config"));
      } else if (item.kind === "skill" || item.kind === "plugin") {
        applied.push(await applyFileItem(baseDir, item));
      }
    } catch (err) {
      applied.push(reportItem(item, "failed", err instanceof Error ? err.message : String(err)));
    }
  }

  try {
    const targetPath = await applyTelegramConfig(baseDir, selectedItems);
    if (targetPath) {
      for (const item of selectedItems.filter((candidate) => candidate.kind === "telegram")) {
        const existing = applied.find((appliedItem) => appliedItem.id === item.id);
        if (existing) existing.targetPath = targetPath;
      }
    }
  } catch (err) {
    for (const item of selectedItems.filter((candidate) => candidate.kind === "telegram")) {
      const existing = applied.find((appliedItem) => appliedItem.id === item.id);
      const reason = err instanceof Error ? err.message : String(err);
      if (existing) {
        existing.status = "failed";
        existing.reason = reason;
      } else {
        applied.push(reportItem(item, "failed", reason));
      }
    }
  }

  const mcpItems = selectedItems.filter((item) => item.kind === "mcp" && item.mcpServer);
  try {
    const targetPath = await mergeMcpServers(
      baseDir,
      mcpItems.map((item) => item.mcpServer as MCPServerConfig)
    );
    for (const item of mcpItems) {
      applied.push({
        id: item.id,
        source: item.source,
        kind: item.kind,
        label: item.label,
        decision: item.decision,
        status: targetPath ? "applied" : "skipped",
        ...(targetPath ? { targetPath } : { reason: "no MCP server config" }),
      });
    }
  } catch (err) {
    for (const item of mcpItems) {
      applied.push(reportItem(item, "failed", err instanceof Error ? err.message : String(err)));
    }
  }

  const createdAt = new Date().toISOString();
  const report: SetupImportReport = {
    created_at: createdAt,
    sources: selection.sources.map(({ id, label, rootDir }) => ({ id, label, rootDir })),
    items: applied,
  };

  const reportName = createdAt.replace(/[:.]/g, "-");
  const sourceName = selection.sources.map((source) => source.id).join("-") || "import";
  const reportPath = path.join(baseDir, "imports", sourceName, reportName, "report.json");
  await writeJsonFileAtomic(reportPath, report);

  return report;
}
