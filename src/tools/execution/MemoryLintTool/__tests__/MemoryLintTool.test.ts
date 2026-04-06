import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KnowledgeManager } from "../../../../platform/knowledge/knowledge-manager.js";
import type { ToolCallContext } from "../../../types.js";
import type { LintFinding } from "../../../../platform/knowledge/types/agent-memory.js";

vi.mock("../../../../platform/knowledge/knowledge-manager-lint.js", () => ({
  lintAgentMemory: vi.fn(),
}));

import { lintAgentMemory } from "../../../../platform/knowledge/knowledge-manager-lint.js";
import { MemoryLintTool } from "../MemoryLintTool.js";

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
  sessionId: "session-1",
});

function makeFinding(type: LintFinding["type"]): LintFinding {
  return {
    type,
    entry_ids: [crypto.randomUUID()],
    description: `A ${type} issue`,
    confidence: 0.8,
    suggested_action: "flag_review",
  };
}

function makeMockKM(): KnowledgeManager {
  return {} as unknown as KnowledgeManager;
}

describe("MemoryLintTool", () => {
  let km: KnowledgeManager;
  let llmCall: (prompt: string) => Promise<string>;
  let tool: MemoryLintTool;

  beforeEach(() => {
    vi.clearAllMocks();
    km = makeMockKM();
    llmCall = vi.fn().mockResolvedValue("{}");
    tool = new MemoryLintTool(km, llmCall);
  });

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("memory_lint");
    });

    it("has lint_memory alias", () => {
      expect(tool.metadata.aliases).toContain("lint_memory");
    });

    it("has write_local permission level", () => {
      expect(tool.metadata.permissionLevel).toBe("write_local");
    });

    it("has memory, lint, and quality tags", () => {
      expect(tool.metadata.tags).toContain("memory");
      expect(tool.metadata.tags).toContain("lint");
      expect(tool.metadata.tags).toContain("quality");
    });

    it("is not read-only", () => {
      expect(tool.metadata.isReadOnly).toBe(false);
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns false", () => {
      expect(tool.isConcurrencySafe({})).toBe(false);
    });
  });

  describe("checkPermissions", () => {
    it("always returns allowed", async () => {
      const result = await tool.checkPermissions({}, makeContext());
      expect(result.status).toBe("allowed");
    });
  });

  describe("description", () => {
    it("returns non-empty string", () => {
      expect(tool.description()).toBeTruthy();
    });
  });

  describe("execute() calls lintAgentMemory with correct args", () => {
    it("passes km and llmCall to lintAgentMemory", async () => {
      vi.mocked(lintAgentMemory).mockResolvedValue({
        findings: [],
        repairs_applied: 0,
        entries_flagged: 0,
      });

      await tool.call({ auto_repair: true, categories: ["infra"] }, makeContext());

      expect(vi.mocked(lintAgentMemory)).toHaveBeenCalledWith(
        expect.objectContaining({
          km,
          llmCall,
          autoRepair: true,
          categories: ["infra"],
        })
      );
    });

    it("defaults auto_repair to undefined (falsy) when not provided", async () => {
      vi.mocked(lintAgentMemory).mockResolvedValue({
        findings: [],
        repairs_applied: 0,
        entries_flagged: 0,
      });

      await tool.call({}, makeContext());

      expect(vi.mocked(lintAgentMemory)).toHaveBeenCalledWith(
        expect.objectContaining({ autoRepair: undefined })
      );
    });
  });

  describe("execute() returns formatted output with summary", () => {
    it("returns success with findings and summary when issues found", async () => {
      const findings: LintFinding[] = [
        makeFinding("contradiction"),
        makeFinding("staleness"),
        makeFinding("redundancy"),
      ];
      vi.mocked(lintAgentMemory).mockResolvedValue({
        findings,
        repairs_applied: 2,
        entries_flagged: 3,
      });

      const result = await tool.call({}, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { findings: LintFinding[]; repairs_applied: number; entries_flagged: number; summary: string };
      expect(data.findings).toHaveLength(3);
      expect(data.repairs_applied).toBe(2);
      expect(data.entries_flagged).toBe(3);
      expect(data.summary).toContain("3");
      expect(data.summary).toContain("2");
    });

    it("includes issue type breakdown in summary", async () => {
      const findings: LintFinding[] = [
        makeFinding("contradiction"),
        makeFinding("staleness"),
        makeFinding("redundancy"),
      ];
      vi.mocked(lintAgentMemory).mockResolvedValue({
        findings,
        repairs_applied: 2,
        entries_flagged: 3,
      });

      const result = await tool.call({}, makeContext());

      expect(result.summary).toContain("contradiction");
      expect(result.summary).toContain("staleness");
      expect(result.summary).toContain("redundancy");
    });
  });

  describe("execute() handles lint returning no findings", () => {
    it("returns success with empty findings and appropriate summary", async () => {
      vi.mocked(lintAgentMemory).mockResolvedValue({
        findings: [],
        repairs_applied: 0,
        entries_flagged: 0,
      });

      const result = await tool.call({}, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { findings: LintFinding[]; summary: string };
      expect(data.findings).toHaveLength(0);
      expect(data.summary).toContain("No issues found");
    });
  });

  describe("error handling", () => {
    it("returns failure when lintAgentMemory throws", async () => {
      vi.mocked(lintAgentMemory).mockRejectedValue(new Error("lint failed"));

      const result = await tool.call({}, makeContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain("lint failed");
    });
  });
});
