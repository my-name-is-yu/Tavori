import type { ProviderConfig } from "../../../../../base/llm/provider-config.js";
import type { MCPServerConfig } from "../../../../../base/types/mcp.js";

export type SetupImportSourceId = "hermes" | "openclaw";

export type SetupImportItemKind = "provider" | "skill" | "mcp" | "plugin" | "telegram";

export type SetupImportDecision = "import" | "copy_disabled" | "skip";

export interface SetupImportProviderSettings {
  provider?: ProviderConfig["provider"];
  model?: string;
  adapter?: ProviderConfig["adapter"];
  apiKey?: string;
  baseUrl?: string;
  codexCliPath?: string;
  openclaw?: ProviderConfig["openclaw"];
}

export interface SetupImportTelegramSettings {
  botToken?: string;
  allowedUserIds?: number[];
}

export interface SetupImportItem {
  id: string;
  source: SetupImportSourceId;
  sourceLabel: string;
  kind: SetupImportItemKind;
  label: string;
  sourcePath?: string;
  decision: SetupImportDecision;
  reason: string;
  providerSettings?: SetupImportProviderSettings;
  telegramSettings?: SetupImportTelegramSettings;
  mcpServer?: MCPServerConfig;
}

export interface SetupImportSource {
  id: SetupImportSourceId;
  label: string;
  rootDir: string;
  items: SetupImportItem[];
}

export interface SetupImportSelection {
  sources: SetupImportSource[];
  items: SetupImportItem[];
  providerSettings?: SetupImportProviderSettings;
}

export interface SetupImportAppliedItem {
  id: string;
  source: SetupImportSourceId;
  kind: SetupImportItemKind;
  label: string;
  decision: SetupImportDecision;
  status: "applied" | "skipped" | "failed";
  targetPath?: string;
  reason?: string;
}

export interface SetupImportReport {
  created_at: string;
  sources: Array<Pick<SetupImportSource, "id" | "label" | "rootDir">>;
  items: SetupImportAppliedItem[];
}
