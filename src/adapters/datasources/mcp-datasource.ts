// ─── MCPDataSourceAdapter ───
//
// IDataSourceAdapter implementation that delegates observation to an MCP server
// via the Model Context Protocol. Each dimension is mapped to an MCP tool call
// defined in MCPServerConfig.tool_mappings.
//
// The MCP connection is injected (IMCPConnection) so that unit tests can mock
// the protocol layer without spawning real processes.

import type { IDataSourceAdapter } from "../../platform/observation/data-source-adapter.js";
import type {
  DataSourceType,
  DataSourceConfig,
  DataSourceQuery,
  DataSourceResult,
} from "../../base/types/data-source.js";
import type {
  MCPServerConfig,
  MCPToolMapping,
  IMCPConnection,
} from "../../base/types/mcp.js";

// ─── Glob pattern matcher ───

function matchesPattern(dimension: string, pattern: string): boolean {
  // Convert glob-style pattern ("test_*", "coverage") to a regex
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(dimension);
}

// ─── MCPDataSourceAdapter ───

export class MCPDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType: DataSourceType = "mcp";
  readonly config: DataSourceConfig;

  private readonly serverConfig: MCPServerConfig;
  private readonly connection: IMCPConnection;
  private connected = false;

  constructor(serverConfig: MCPServerConfig, connection: IMCPConnection) {
    this.serverConfig = serverConfig;
    this.connection = connection;
    this.sourceId = serverConfig.id;

    // Synthesize a minimal DataSourceConfig to satisfy the interface
    this.config = {
      id: serverConfig.id,
      name: serverConfig.name,
      type: "mcp",
      connection: serverConfig.url ? { url: serverConfig.url } : {},
      enabled: serverConfig.enabled,
      created_at: new Date().toISOString(),
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.connection.connect();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.connection.close();
    this.connected = false;
  }

  async healthCheck(): Promise<boolean> {
    return this.connection.isConnected();
  }

  getSupportedDimensions(): string[] {
    return this.serverConfig.tool_mappings.map((m) => m.dimension_pattern);
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    const mapping = this.findMapping(params.dimension_name);

    if (!mapping) {
      return {
        value: null,
        raw: null,
        timestamp: new Date().toISOString(),
        source_id: this.sourceId,
        metadata: { reason: `No tool mapping for dimension: ${params.dimension_name}` },
      };
    }

    const args: Record<string, unknown> = {
      ...(mapping.args_template ?? {}),
      dimension_name: params.dimension_name,
    };

    let raw: unknown;
    let value: number | string | boolean | null = null;

    try {
      const result = await this.connection.callTool(mapping.tool_name, args);
      raw = result;

      // Extract text content from the first content item
      const firstContent = result.content.find((c) => c.type === "text" && c.text !== undefined);
      if (firstContent?.text !== undefined) {
        const parsed = this.parseTextValue(firstContent.text);
        value = parsed;
      }
    } catch (err) {
      return {
        value: null,
        raw: null,
        timestamp: new Date().toISOString(),
        source_id: this.sourceId,
        metadata: { error: String(err) },
      };
    }

    return {
      value,
      raw,
      timestamp: new Date().toISOString(),
      source_id: this.sourceId,
    };
  }

  // ─── Private helpers ───

  private findMapping(dimensionName: string): MCPToolMapping | undefined {
    return this.serverConfig.tool_mappings.find((m) =>
      matchesPattern(dimensionName, m.dimension_pattern)
    );
  }

  private parseTextValue(text: string): number | string | boolean | null {
    const trimmed = text.trim();
    if (trimmed === "null") return null;
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    const num = Number(trimmed);
    if (!isNaN(num) && trimmed !== "") return num;
    return trimmed;
  }
}
