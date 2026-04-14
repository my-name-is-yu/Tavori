import type { SetupImportSourceId } from "./types.js";

export const SOURCE_LABELS: Record<SetupImportSourceId, string> = {
  hermes: "Hermes Agent",
  openclaw: "OpenClaw",
};

export const CONFIG_FILENAMES = [
  "provider.json",
  "config.json",
  "config.yaml",
  "config.yml",
  "settings.json",
  "agent.json",
  "openclaw.json",
  "openclaw.config.json",
  "clawdbot.json",
  "moltbot.json",
  "hermes.config.json",
] as const;

export const MCP_FILENAMES = [
  "mcp-servers.json",
  "mcp.json",
  "mcpServers.json",
  "servers.json",
] as const;
