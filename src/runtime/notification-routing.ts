import * as path from "node:path";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../base/utils/json-io.js";
import { getPulseedDirPath } from "../base/utils/paths.js";
import { NotificationConfigSchema } from "../base/types/notification.js";
import type { NotificationConfig, PluginNotifierRoute } from "../base/types/notification.js";

export interface NotificationRoutingUpdate {
  config: NotificationConfig;
  selected_notifiers: string[];
  report_types: string[];
  mode: "all" | "only" | "none";
  summary: string;
}

interface NotifierAlias {
  id: string;
  labels: string[];
}

const NOTIFIER_ALIASES: NotifierAlias[] = [
  { id: "discord-bot", labels: ["discord", "ディスコード"] },
  { id: "whatsapp-webhook", labels: ["whatsapp", "what's app", "ワッツアップ", "ワッツアップ"] },
  { id: "signal-bridge", labels: ["signal", "シグナル"] },
  { id: "telegram-bot", labels: ["telegram", "テレグラム"] },
  { id: "slack-notifier", labels: ["slack", "スラック"] },
];

const REPORT_TYPE_ALIASES: Array<{ reportTypes: string[]; labels: string[] }> = [
  { reportTypes: ["urgent_alert", "approval_request"], labels: ["urgent", "緊急", "至急", "承認", "approval"] },
  { reportTypes: ["stall_escalation"], labels: ["stall", "stuck", "停滞", "詰まり", "ブロック"] },
  { reportTypes: ["goal_completion"], labels: ["complete", "completion", "完了", "達成"] },
  { reportTypes: ["daily_summary"], labels: ["daily", "日次", "毎日", "朝", "夕方"] },
  { reportTypes: ["weekly_report"], labels: ["weekly", "週次", "毎週"] },
  { reportTypes: ["execution_summary"], labels: ["execution", "実行", "作業"] },
  { reportTypes: ["strategy_change", "capability_escalation"], labels: ["strategy", "戦略", "方針", "capability", "能力"] },
];

export function getNotificationConfigPath(baseDir?: string): string {
  return path.join(baseDir ?? getPulseedDirPath(), "notification.json");
}

export async function loadNotificationConfig(
  configPath = getNotificationConfigPath(),
  options: { invalid?: "default" | "throw" } = {}
): Promise<NotificationConfig> {
  const raw = await readJsonFileOrNull(configPath);
  if (raw === null) {
    return NotificationConfigSchema.parse({});
  }
  const result = NotificationConfigSchema.safeParse(raw);
  if (!result.success) {
    if (options.invalid === "throw") {
      throw new Error(`Invalid notification config: ${result.error.message}`);
    }
    return NotificationConfigSchema.parse({});
  }
  return result.data;
}

export async function saveNotificationConfig(configPath: string, config: NotificationConfig): Promise<void> {
  await writeJsonFileAtomic(configPath, config);
}

export async function applyNaturalLanguageNotificationRouting(
  instruction: string,
  configPath = getNotificationConfigPath()
): Promise<NotificationRoutingUpdate> {
  const config = await loadNotificationConfig(configPath, { invalid: "throw" });
  const update = applyNaturalLanguageNotificationRoutingToConfig(config, instruction);
  await saveNotificationConfig(configPath, update.config);
  return update;
}

export function applyNaturalLanguageNotificationRoutingToConfig(
  config: NotificationConfig,
  instruction: string
): NotificationRoutingUpdate {
  const selected = detectNotifiers(instruction);
  const reportTypes = detectReportTypes(instruction);
  const mode = detectMode(instruction, selected.length);

  const nextConfig = NotificationConfigSchema.parse(config);
  const currentRoutes = nextConfig.plugin_notifiers.routes;

  if (mode === "none") {
    nextConfig.plugin_notifiers = {
      mode: "none",
      routes: currentRoutes,
    };
  } else {
    nextConfig.plugin_notifiers = {
      mode,
      routes: mergeRoutes(currentRoutes, selected, reportTypes, !isDisableInstruction(instruction)),
    };
  }

  return {
    config: NotificationConfigSchema.parse(nextConfig),
    selected_notifiers: selected,
    report_types: reportTypes,
    mode,
    summary: buildSummary(mode, selected, reportTypes, instruction),
  };
}

function mergeRoutes(
  routes: PluginNotifierRoute[],
  selected: string[],
  reportTypes: string[],
  enabled: boolean
): PluginNotifierRoute[] {
  const byId = new Map(routes.map((route) => [route.id, { ...route }]));
  for (const id of selected) {
    const existing = byId.get(id);
    byId.set(id, {
      id,
      enabled,
      report_types: reportTypes.length > 0 ? reportTypes : existing?.report_types ?? [],
    });
  }
  return Array.from(byId.values());
}

function detectNotifiers(instruction: string): string[] {
  const normalized = instruction.toLowerCase();
  const selected: string[] = [];
  for (const alias of NOTIFIER_ALIASES) {
    if (alias.labels.some((label) => normalized.includes(label.toLowerCase()))) {
      selected.push(alias.id);
    }
  }
  return selected;
}

function detectReportTypes(instruction: string): string[] {
  const normalized = instruction.toLowerCase();
  const selected = new Set<string>();
  for (const alias of REPORT_TYPE_ALIASES) {
    if (alias.labels.some((label) => normalized.includes(label.toLowerCase()))) {
      for (const reportType of alias.reportTypes) {
        selected.add(reportType);
      }
    }
  }
  const hasGenericReport = ["report", "レポート", "報告"].some((label) => normalized.includes(label));
  const hasSpecificReport = ["daily_summary", "weekly_report", "execution_summary"]
    .some((reportType) => selected.has(reportType));
  if (hasGenericReport && !hasSpecificReport) {
    selected.add("daily_summary");
    selected.add("weekly_report");
    selected.add("execution_summary");
  }
  return Array.from(selected);
}

function detectMode(instruction: string, selectedCount: number): "all" | "only" | "none" {
  if (isDisableInstruction(instruction) && selectedCount === 0) {
    return "none";
  }
  const normalized = instruction.toLowerCase();
  if (
    normalized.includes("only") ||
    normalized.includes("だけ") ||
    normalized.includes("のみ") ||
    normalized.includes("一本化")
  ) {
    return "only";
  }
  return "all";
}

function isDisableInstruction(instruction: string): boolean {
  const normalized = instruction.toLowerCase();
  return (
    normalized.includes("disable") ||
    normalized.includes("off") ||
    normalized.includes("mute") ||
    normalized.includes("stop") ||
    normalized.includes("送らない") ||
    normalized.includes("送信しない") ||
    normalized.includes("止め") ||
    normalized.includes("無効")
  );
}

function buildSummary(
  mode: "all" | "only" | "none",
  selected: string[],
  reportTypes: string[],
  instruction: string
): string {
  if (mode === "none") {
    return "Plugin notification delivery disabled from instruction: " + instruction;
  }
  const target = selected.length > 0 ? selected.join(", ") : "(no specific plugin notifier)";
  const reportScope = reportTypes.length > 0 ? reportTypes.join(", ") : "all report types";
  return `Plugin notification routing set to ${mode}: ${target} for ${reportScope}`;
}
