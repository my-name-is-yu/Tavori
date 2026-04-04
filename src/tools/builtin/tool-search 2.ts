import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../types.js";
import type { ToolRegistry } from "../registry.js";

export interface ToolSearchInput {
  query: string;
  category?: string;
}

export interface ToolSearchResult {
  name: string;
  description: string;
  category: string;
  tags: string[];
}

export const ToolSearchInputSchema = z.object({
  query: z.string().min(1),
  category: z.string().optional(),
});

export class ToolSearchTool implements ITool<ToolSearchInput, ToolSearchResult[]> {
  readonly metadata: ToolMetadata = {
    name: "tool_search",
    aliases: [],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 10,
    maxOutputChars: 8000,
    tags: ["discovery", "meta", "search"],
  };

  readonly inputSchema = ToolSearchInputSchema;

  constructor(private readonly registry: ToolRegistry) {}

  description(): string {
    return "Search available tools by keyword or category. Returns tool names and descriptions for discovery.";
  }

  async call(input: ToolSearchInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const results = this.registry.searchTools(input.query, input.category);
    return {
      success: true,
      data: results,
      summary: `Found ${results.length} tools matching "${input.query}"`,
      durationMs: Date.now() - startTime,
    };
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
