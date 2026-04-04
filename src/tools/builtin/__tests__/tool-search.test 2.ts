import { describe, it, expect, beforeEach } from "vitest";
import { ToolSearchTool } from "../tool-search.js";
import { ToolRegistry } from "../../registry.js";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../../types.js";
import { z } from "zod";

// --- Minimal mock tool factory ---

function makeMockTool(overrides: {
  name: string;
  description: string;
  tags: string[];
}): ITool {
  return {
    metadata: {
      name: overrides.name,
      aliases: [],
      permissionLevel: "read_only",
      isReadOnly: true,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: 0,
      maxOutputChars: 8000,
      tags: overrides.tags,
    } as ToolMetadata,
    inputSchema: z.object({}),
    description: () => overrides.description,
    call: async (): Promise<ToolResult> => ({
      success: true,
      data: null,
      summary: "ok",
      durationMs: 0,
    }),
    checkPermissions: async (): Promise<PermissionCheckResult> => ({ status: "allowed" }),
    isConcurrencySafe: () => true,
  };
}

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
});

describe("ToolSearchTool", () => {
  let registry: ToolRegistry;
  let tool: ToolSearchTool;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(makeMockTool({ name: "glob", description: "Find files by glob pattern", tags: ["filesystem", "search"] }));
    registry.register(makeMockTool({ name: "grep", description: "Search file contents with regex", tags: ["filesystem", "search"] }));
    registry.register(makeMockTool({ name: "http_fetch", description: "Fetch URLs over HTTP", tags: ["network", "observation"] }));
    tool = new ToolSearchTool(registry);
  });

  it("returns matching tools by name keyword", async () => {
    const result = await tool.call({ query: "glob" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as Array<{ name: string }>;
    expect(data.some((t) => t.name === "glob")).toBe(true);
  });

  it("returns matching tools by tag", async () => {
    const result = await tool.call({ query: "network" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as Array<{ name: string }>;
    expect(data.some((t) => t.name === "http_fetch")).toBe(true);
  });

  it("returns matching tools by description", async () => {
    const result = await tool.call({ query: "regex" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as Array<{ name: string }>;
    expect(data.some((t) => t.name === "grep")).toBe(true);
  });

  it("filters by category when provided", async () => {
    const result = await tool.call({ query: "search", category: "network" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as Array<{ name: string }>;
    // "grep" has tag "search" but NOT "network", so should be excluded
    expect(data.some((t) => t.name === "grep")).toBe(false);
  });

  it("case-insensitive search", async () => {
    const result = await tool.call({ query: "GLOB" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as Array<{ name: string }>;
    expect(data.some((t) => t.name === "glob")).toBe(true);
  });

  it("returns empty array when no matches", async () => {
    const result = await tool.call({ query: "nonexistent_xyz_tool" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as Array<unknown>;
    expect(data).toHaveLength(0);
    expect(result.summary).toContain("Found 0");
  });

  it("metadata is correct", () => {
    expect(tool.metadata.name).toBe("tool_search");
    expect(tool.metadata.permissionLevel).toBe("read_only");
    expect(tool.metadata.tags).toContain("discovery");
    expect(tool.metadata.tags).toContain("meta");
    expect(tool.metadata.tags).toContain("search");
  });

  it("checkPermissions returns allowed", async () => {
    const result = await tool.checkPermissions({ query: "glob" }, makeContext());
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", () => {
    expect(tool.isConcurrencySafe({ query: "glob" })).toBe(true);
  });
});
