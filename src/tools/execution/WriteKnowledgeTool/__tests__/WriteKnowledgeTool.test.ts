import { describe, it, expect, vi, beforeEach } from "vitest";
import { WriteKnowledgeTool } from "../WriteKnowledgeTool.js";
import type { KnowledgeManager } from "../../../../platform/knowledge/knowledge-manager.js";
import type { ToolCallContext } from "../../../types.js";

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
  sessionId: "session-1",
});

function makeMockKM(overrides: Partial<KnowledgeManager> = {}): KnowledgeManager {
  return {
    saveKnowledge: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as KnowledgeManager;
}

describe("WriteKnowledgeTool", () => {
  let km: KnowledgeManager;
  let tool: WriteKnowledgeTool;

  beforeEach(() => {
    km = makeMockKM();
    tool = new WriteKnowledgeTool(km);
  });

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("write-knowledge");
    });

    it("is not read-only", () => {
      expect(tool.metadata.isReadOnly).toBe(false);
    });

    it("is not destructive", () => {
      expect(tool.metadata.isDestructive).toBe(false);
    });

    it("has write_local permission", () => {
      expect(tool.metadata.permissionLevel).toBe("write_local");
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns false", () => {
      expect(tool.isConcurrencySafe({ key: "k", content: "c" })).toBe(false);
    });
  });

  describe("checkPermissions", () => {
    it("always returns allowed", async () => {
      const result = await tool.checkPermissions({ key: "k", content: "c" }, makeContext());
      expect(result.status).toBe("allowed");
    });
  });

  describe("description", () => {
    it("returns non-empty string", () => {
      expect(tool.description()).toBeTruthy();
    });
  });

  describe("successful execution", () => {
    it("calls saveKnowledge and returns entryId", async () => {
      const result = await tool.call({ key: "my-key", content: "my-content" }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { entryId: string; key: string };
      expect(data.key).toBe("my-key");
      expect(typeof data.entryId).toBe("string");
      expect(vi.mocked(km.saveKnowledge)).toHaveBeenCalledWith(
        "goal-1",
        expect.objectContaining({ question: "my-key", answer: "my-content" })
      );
    });

    it("uses tags when provided", async () => {
      await tool.call({ key: "k", content: "c", tags: ["tag1", "tag2"] }, makeContext());
      expect(vi.mocked(km.saveKnowledge)).toHaveBeenCalledWith(
        "goal-1",
        expect.objectContaining({ tags: ["tag1", "tag2"] })
      );
    });

    it("uses category as tag when no tags provided", async () => {
      await tool.call({ key: "k", content: "c", category: "infra" }, makeContext());
      expect(vi.mocked(km.saveKnowledge)).toHaveBeenCalledWith(
        "goal-1",
        expect.objectContaining({ tags: ["infra"] })
      );
    });
  });

  describe("Zod validation — missing required params", () => {
    it("rejects empty key", () => {
      const result = tool.inputSchema.safeParse({ key: "", content: "c" });
      expect(result.success).toBe(false);
    });

    it("rejects missing content", () => {
      const result = tool.inputSchema.safeParse({ key: "k" });
      expect(result.success).toBe(false);
    });
  });

  describe("error handling", () => {
    it("returns failure when saveKnowledge throws", async () => {
      vi.mocked(km.saveKnowledge).mockRejectedValue(new Error("disk full"));
      const result = await tool.call({ key: "k", content: "c" }, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain("disk full");
    });
  });
});
