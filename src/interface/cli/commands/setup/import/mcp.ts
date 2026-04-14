import type { MCPServerConfig } from "../../../../../base/types/mcp.js";
import { safeImportName } from "./fs-utils.js";
import { isRecord, stringArray, stringValue } from "./parse.js";
import type { SetupImportSourceId } from "./types.js";

function normalizeToolMappings(value: unknown): MCPServerConfig["tool_mappings"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const toolName = stringValue(item["tool_name"]);
    const dimensionPattern = stringValue(item["dimension_pattern"]);
    if (!toolName || !dimensionPattern) return [];
    const argsTemplate = isRecord(item["args_template"]) ? item["args_template"] : undefined;
    return [{
      tool_name: toolName,
      dimension_pattern: dimensionPattern,
      ...(argsTemplate ? { args_template: argsTemplate } : {}),
    }];
  });
}

function normalizeMcpServer(
  id: string,
  raw: Record<string, unknown>,
  source: SetupImportSourceId
): MCPServerConfig | undefined {
  const command = stringValue(raw["command"]);
  const args = stringArray(raw["args"]) ?? [];
  const env = isRecord(raw["env"])
    ? Object.fromEntries(
        Object.entries(raw["env"]).filter(([, value]) => typeof value === "string")
      ) as Record<string, string>
    : undefined;
  const url = stringValue(raw["url"]);
  const transport = stringValue(raw["transport"]);
  const resolvedTransport = transport === "sse" || url ? "sse" : "stdio";

  if (resolvedTransport === "stdio" && !command) return undefined;
  if (resolvedTransport === "sse" && !url) return undefined;

  return {
    id: safeImportName(`${source}-${id}`),
    name: stringValue(raw["name"]) ?? id,
    transport: resolvedTransport,
    ...(command ? { command } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...(url ? { url } : {}),
    tool_mappings: normalizeToolMappings(raw["tool_mappings"]),
    enabled: false,
  };
}

export function extractMcpServers(raw: unknown, source: SetupImportSourceId): MCPServerConfig[] {
  if (!isRecord(raw)) return [];
  const serversValue = raw["servers"];
  if (Array.isArray(serversValue)) {
    return serversValue.flatMap((item, index) => {
      if (!isRecord(item)) return [];
      const id = stringValue(item["id"]) ?? stringValue(item["name"]) ?? `server-${index + 1}`;
      const normalized = normalizeMcpServer(id, item, source);
      return normalized ? [normalized] : [];
    });
  }

  const mapValue = isRecord(raw["mcpServers"])
    ? raw["mcpServers"]
    : isRecord(raw["mcp_servers"])
      ? raw["mcp_servers"]
      : isRecord(raw["mcp"]) && isRecord(raw["mcp"]["servers"])
        ? raw["mcp"]["servers"]
      : raw;

  return Object.entries(mapValue).flatMap(([id, value]) => {
    if (!isRecord(value)) return [];
    const normalized = normalizeMcpServer(id, value, source);
    return normalized ? [normalized] : [];
  });
}
