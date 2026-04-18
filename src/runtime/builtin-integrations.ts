import type { BuiltinIntegrationDescriptor } from "./types/builtin-integration.js";
import { loadGlobalConfigSync } from "../base/config/global-config.js";

export const BUILTIN_INTEGRATIONS: BuiltinIntegrationDescriptor[] = [
  {
    id: "soil-display",
    kind: "display",
    title: "Soil Display Bridge",
    description: "Materializes typed Soil content into publishable Markdown snapshots.",
    source: "builtin",
    status: "available",
    capabilities: [
      "soil_projection_materialize",
      "obsidian_markdown_bridge",
      "notion_snapshot_publish",
    ],
  },
  {
    id: "mcp-bridge",
    kind: "bridge",
    title: "MCP Bridge",
    description: "Imports MCP servers and keeps them disabled until reviewed.",
    source: "builtin",
    status: "available",
    capabilities: [
      "mcp_server_import",
      "disabled_registration",
      "stdio_transport_bridge",
    ],
  },
  {
    id: "foreign-plugin-bridge",
    kind: "bridge",
    title: "Foreign Plugin Bridge",
    description: "Classifies Hermes and OpenClaw plugins before they are copied into quarantine.",
    source: "builtin",
    status: "available",
    capabilities: [
      "foreign_manifest_analysis",
      "compatibility_report",
      "quarantined_copy",
    ],
  },
  {
    id: "interactive-automation",
    kind: "automation",
    title: "Interactive Automation",
    description: "Routes desktop, browser, and research workflows through configured automation providers.",
    source: "builtin",
    status: "available",
    capabilities: [
      "desktop_app_state_inspection",
      "desktop_input_control",
      "browser_workflow_execution",
      "web_research_with_sources",
      "provider_capability_routing",
    ],
  },
];

export function listBuiltinIntegrations(): BuiltinIntegrationDescriptor[] {
  const config = loadGlobalConfigSync();
  return BUILTIN_INTEGRATIONS.map((integration) =>
    integration.id === "interactive-automation"
      ? {
          ...integration,
          status: config.interactive_automation.enabled ? "available" : "disabled",
        }
      : { ...integration }
  );
}
