import { z } from "zod";

// ─── MCPToolMapping ───
//
// Maps a dimension name pattern (e.g. "test_*", "coverage") to an MCP tool call.

export const MCPToolMappingSchema = z.object({
  tool_name: z.string(),
  dimension_pattern: z.string(),
  args_template: z.record(z.string(), z.unknown()).optional(),
});
export type MCPToolMapping = z.infer<typeof MCPToolMappingSchema>;

// ─── MCPServerConfig ───
//
// Configuration for a single MCP server connection.

export const MCPServerConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  transport: z.enum(["stdio", "sse"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  tool_mappings: z.array(MCPToolMappingSchema),
  enabled: z.boolean().default(true),
});
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

// ─── MCPServersConfig ───
//
// Top-level config file schema (mcp-servers.json).

export const MCPServersConfigSchema = z.object({
  servers: z.array(MCPServerConfigSchema),
});
export type MCPServersConfig = z.infer<typeof MCPServersConfigSchema>;

// ─── MCPToolCallResult ───
//
// Subset of the MCP tool call result we care about.

export interface MCPToolContent {
  type: string;
  text?: string;
}

export interface MCPToolCallResult {
  content: MCPToolContent[];
}

// ─── IMCPConnection ───
//
// Abstraction over the real MCP Client, injectable for testing.

export interface IMCPConnection {
  connect(): Promise<void>;
  listTools(): Promise<Array<{ name: string }>>;
  callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<MCPToolCallResult>;
  close(): Promise<void>;
  isConnected(): boolean;
}
