import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../registry.js";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../types.js";
import { z } from "zod";

function makeTool(opts: { name: string; description: string; tags: string[] }): ITool {
  return {
    metadata: {
      name: opts.name,
      aliases: [],
      permissionLevel: "read_only",
      isReadOnly: true,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: 0,
      maxOutputChars: 8000,
      tags: opts.tags,
    } as ToolMetadata,
    inputSchema: z.object({}),
    description: () => opts.description,
    call: async (): Promise<ToolResult> => ({ success: true, data: null, summary: "ok", durationMs: 0 }),
    checkPermissions: async (): Promise<PermissionCheckResult> => ({ status: "allowed" }),
    isConcurrencySafe: () => true,
  };
}

describe("ToolRegistry.searchTools()", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(makeTool({ name: "glob", description: "Find files by glob pattern", tags: ["filesystem", "search"] }));
    registry.register(makeTool({ name: "grep", description: "Search file contents with regex", tags: ["filesystem", "search"] }));
    registry.register(makeTool({ name: "http_fetch", description: "Fetch URLs over HTTP", tags: ["network", "observation"] }));
    registry.register(makeTool({ name: "shell", description: "Execute shell commands", tags: ["execution", "system"] }));
  });

  it("finds tools by name keyword", () => {
    const results = registry.searchTools("glob");
    expect(results.some((r) => r.name === "glob")).toBe(true);
    expect(results.some((r) => r.name === "grep")).toBe(false);
  });

  it("finds tools by tag", () => {
    const results = registry.searchTools("network");
    expect(results.some((r) => r.name === "http_fetch")).toBe(true);
    expect(results.some((r) => r.name === "glob")).toBe(false);
  });

  it("finds tools by description", () => {
    const results = registry.searchTools("regex");
    expect(results.some((r) => r.name === "grep")).toBe(true);
    expect(results.some((r) => r.name === "glob")).toBe(false);
  });

  it("filters by category (uses tag as category)", () => {
    // category "network" filters to tools that have "network" tag
    const results = registry.searchTools("fetch", "network");
    expect(results.some((r) => r.name === "http_fetch")).toBe(true);
    // grep has "search" in description but no "network" tag
    registry.register(makeTool({ name: "grep2", description: "fetch something", tags: ["filesystem"] }));
    const filtered = registry.searchTools("fetch", "network");
    expect(filtered.every((r) => r.tags.includes("network"))).toBe(true);
  });

  it("case-insensitive matching", () => {
    const results = registry.searchTools("GLOB");
    expect(results.some((r) => r.name === "glob")).toBe(true);
  });

  it("returns empty for no matches", () => {
    const results = registry.searchTools("zzz_nonexistent_xyz");
    expect(results).toHaveLength(0);
  });

  it("matches any keyword (OR logic)", () => {
    // "glob network" should match glob (by name) and http_fetch (by tag)
    const results = registry.searchTools("glob network");
    expect(results.some((r) => r.name === "glob")).toBe(true);
    expect(results.some((r) => r.name === "http_fetch")).toBe(true);
    // shell has neither glob nor network
    expect(results.some((r) => r.name === "shell")).toBe(false);
  });
});
