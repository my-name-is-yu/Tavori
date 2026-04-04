import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../registry.js";
import type { ITool, ToolMetadata, ToolResult, ToolCallContext, PermissionCheckResult } from "../types.js";

// --- Mock Tool Helper ---

function createMockTool(overrides: Partial<ToolMetadata> & { name: string }): ITool {
  const metadata: ToolMetadata = {
    name: overrides.name,
    aliases: overrides.aliases ?? [],
    permissionLevel: overrides.permissionLevel ?? "read_only",
    isReadOnly: overrides.isReadOnly ?? true,
    isDestructive: overrides.isDestructive ?? false,
    shouldDefer: overrides.shouldDefer ?? false,
    alwaysLoad: overrides.alwaysLoad ?? false,
    maxConcurrency: overrides.maxConcurrency ?? 0,
    maxOutputChars: overrides.maxOutputChars ?? 8000,
    tags: overrides.tags ?? [],
  };

  return {
    metadata,
    inputSchema: z.unknown(),
    description: (_ctx?) => `Description of ${metadata.name}`,
    call: async (_input: unknown, _ctx: ToolCallContext): Promise<ToolResult> => ({
      success: true,
      data: null,
      summary: "ok",
      durationMs: 0,
    }),
    checkPermissions: async (_input: unknown, _ctx: ToolCallContext): Promise<PermissionCheckResult> => ({
      status: "allowed",
    }),
    isConcurrencySafe: (_input: unknown) => true,
  };
}

// --- Tests ---

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe("Registration", () => {
    it("registers a tool successfully", () => {
      const tool = createMockTool({ name: "glob" });
      registry.register(tool);
      expect(registry.get("glob")).toBe(tool);
    });

    it("throws on duplicate name registration", () => {
      registry.register(createMockTool({ name: "glob" }));
      expect(() => registry.register(createMockTool({ name: "glob" }))).toThrow(
        'Tool "glob" is already registered'
      );
    });

    it("looks up a tool by alias", () => {
      const tool = createMockTool({ name: "glob", aliases: ["g", "file-search"] });
      registry.register(tool);
      expect(registry.get("g")).toBe(tool);
      expect(registry.get("file-search")).toBe(tool);
    });

    it("throws when alias conflicts with an existing tool name", () => {
      registry.register(createMockTool({ name: "grep" }));
      expect(() =>
        registry.register(createMockTool({ name: "glob", aliases: ["grep"] }))
      ).toThrow('Alias "grep" conflicts with existing tool or alias');
    });

    it("throws when alias conflicts with an existing alias", () => {
      registry.register(createMockTool({ name: "glob", aliases: ["g"] }));
      expect(() =>
        registry.register(createMockTool({ name: "grep", aliases: ["g"] }))
      ).toThrow('Alias "g" conflicts with existing tool or alias');
    });

    it("listAll returns all registered tools", () => {
      registry.register(createMockTool({ name: "glob" }));
      registry.register(createMockTool({ name: "grep" }));
      expect(registry.listAll()).toHaveLength(2);
    });
  });

  describe("Unregister", () => {
    it("unregisters a tool and its aliases", () => {
      registry.register(createMockTool({ name: "glob", aliases: ["g"] }));
      expect(registry.unregister("glob")).toBe(true);
      expect(registry.get("glob")).toBeUndefined();
      expect(registry.get("g")).toBeUndefined();
    });

    it("returns false when unregistering an unknown tool", () => {
      expect(registry.unregister("nonexistent")).toBe(false);
    });

    it("allows re-registration after unregister", () => {
      registry.register(createMockTool({ name: "glob", aliases: ["g"] }));
      registry.unregister("glob");
      const newTool = createMockTool({ name: "glob" });
      expect(() => registry.register(newTool)).not.toThrow();
    });
  });

  describe("Tier 2: filterByContext", () => {
    it("always includes read-only tools regardless of trustBalance", () => {
      registry.register(
        createMockTool({ name: "read", isReadOnly: true, permissionLevel: "read_only" })
      );
      const result = registry.filterByContext({ trustBalance: -100 });
      expect(result).toHaveLength(1);
    });

    it("includes read_metrics tools when trustBalance >= -50", () => {
      registry.register(
        createMockTool({
          name: "metrics",
          isReadOnly: false,
          permissionLevel: "read_metrics",
        })
      );
      expect(registry.filterByContext({ trustBalance: -50 })).toHaveLength(1);
      expect(registry.filterByContext({ trustBalance: 0 })).toHaveLength(1);
    });

    it("excludes read_metrics tools when trustBalance < -50", () => {
      registry.register(
        createMockTool({
          name: "metrics",
          isReadOnly: false,
          permissionLevel: "read_metrics",
        })
      );
      expect(registry.filterByContext({ trustBalance: -51 })).toHaveLength(0);
      expect(registry.filterByContext({ trustBalance: -100 })).toHaveLength(0);
    });

    it("excludes deferred tools by default", () => {
      registry.register(createMockTool({ name: "rare", shouldDefer: true }));
      expect(registry.filterByContext({ trustBalance: 0 })).toHaveLength(0);
    });

    it("includes deferred tools when includeDeferred=true", () => {
      registry.register(createMockTool({ name: "rare", shouldDefer: true }));
      expect(
        registry.filterByContext({ trustBalance: 0, includeDeferred: true })
      ).toHaveLength(1);
    });

    it("filters by requiredTags (at least one must match)", () => {
      registry.register(createMockTool({ name: "file-tool", tags: ["file", "search"] }));
      registry.register(createMockTool({ name: "net-tool", tags: ["network"] }));
      registry.register(createMockTool({ name: "untagged" }));

      const result = registry.filterByContext({
        trustBalance: 0,
        requiredTags: ["file"],
      });
      expect(result.map((t) => t.metadata.name)).toContain("file-tool");
      expect(result.map((t) => t.metadata.name)).not.toContain("net-tool");
      expect(result.map((t) => t.metadata.name)).not.toContain("untagged");
    });

    it("returns all non-deferred tools when requiredTags is empty", () => {
      registry.register(createMockTool({ name: "a", tags: ["x"] }));
      registry.register(createMockTool({ name: "b", tags: [] }));
      expect(registry.filterByContext({ trustBalance: 0, requiredTags: [] })).toHaveLength(2);
    });
  });

  describe("Tier 3: assemble", () => {
    it("always includes alwaysLoad tools regardless of budget", () => {
      registry.register(createMockTool({ name: "core", alwaysLoad: true }));
      const pool = registry.assemble({ trustBalance: 0 }, 0);
      expect(pool.included.map((t) => t.metadata.name)).toContain("core");
    });

    it("fills optional tools within remaining budget", () => {
      registry.register(createMockTool({ name: "tool-a" }));
      registry.register(createMockTool({ name: "tool-b" }));
      const pool = registry.assemble({ trustBalance: 0 }, 10000);
      expect(pool.included).toHaveLength(2);
      expect(pool.deferred).toHaveLength(0);
    });

    it("defers tools that exceed budget", () => {
      registry.register(createMockTool({ name: "tool-a" }));
      registry.register(createMockTool({ name: "tool-b" }));
      // Budget of 0 means no optional tools can fit
      const pool = registry.assemble({ trustBalance: 0 }, 0);
      expect(pool.deferred).toHaveLength(2);
      expect(pool.included).toHaveLength(0);
    });

    it("usedTokens is a positive number when tools are included", () => {
      registry.register(createMockTool({ name: "glob", alwaysLoad: true }));
      const pool = registry.assemble({ trustBalance: 0 }, 10000);
      expect(pool.usedTokens).toBeGreaterThan(0);
    });

    it("usedTokens is 0 when no tools are included", () => {
      registry.register(createMockTool({ name: "rare", shouldDefer: true }));
      const pool = registry.assemble({ trustBalance: 0 }, 0);
      expect(pool.usedTokens).toBe(0);
    });

    it("higher-relevance tools (tag match) are included before lower-relevance", () => {
      // Two tools: one matches the tag, one does not
      registry.register(createMockTool({ name: "match", tags: ["file"] }));
      registry.register(createMockTool({ name: "no-match", tags: ["network"] }));

      // Budget just fits one tool (estimate ~70 tokens per tool: name + desc / 4 + 50)
      // "match" description = "Description of match" (19 chars), name = 5 chars => (5+19)/4 + 50 = 56
      // Use budget of 60 to allow only one tool
      const pool = registry.assemble(
        { trustBalance: 0, requiredTags: ["file"] },
        60
      );
      // Only the matching tool should be included
      expect(pool.included.map((t) => t.metadata.name)).toContain("match");
    });
  });
});
