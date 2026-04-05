import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryDataSourceTool } from "../query-data-source.js";
import type { ObservationEngine } from "../../../platform/observation/observation-engine.js";
import type { ToolCallContext } from "../../types.js";

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
});

function makeObservationEntry() {
  return {
    dimension: "test-dim",
    value: 0.8,
    confidence: 0.9,
    layer: "data_source" as const,
    method: "data_source_polling" as const,
    timestamp: new Date().toISOString(),
    raw_response: "ok",
    source_id: "src-1",
  };
}

function makeMockEngine(overrides: Partial<ObservationEngine> = {}): ObservationEngine {
  return {
    observeFromDataSource: vi.fn().mockResolvedValue(makeObservationEntry()),
    ...overrides,
  } as unknown as ObservationEngine;
}

describe("QueryDataSourceTool", () => {
  let engine: ObservationEngine;
  let tool: QueryDataSourceTool;

  beforeEach(() => {
    engine = makeMockEngine();
    tool = new QueryDataSourceTool(engine);
  });

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("query-data-source");
    });

    it("is read-only", () => {
      expect(tool.metadata.isReadOnly).toBe(true);
      expect(tool.metadata.permissionLevel).toBe("read_only");
    });

    it("is not destructive", () => {
      expect(tool.metadata.isDestructive).toBe(false);
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns true", () => {
      const input = { goal_id: "g", dimension_name: "d", source_id: "s" };
      expect(tool.isConcurrencySafe(input)).toBe(true);
    });
  });

  describe("checkPermissions", () => {
    it("always returns allowed", async () => {
      const input = { goal_id: "g", dimension_name: "d", source_id: "s" };
      const result = await tool.checkPermissions(input, makeContext());
      expect(result.status).toBe("allowed");
    });
  });

  describe("description", () => {
    it("returns non-empty string", () => {
      expect(tool.description()).toBeTruthy();
    });
  });

  describe("successful execution", () => {
    it("calls observeFromDataSource with correct args", async () => {
      const input = { goal_id: "goal-42", dimension_name: "coverage", source_id: "shell-1" };
      const result = await tool.call(input, makeContext());

      expect(result.success).toBe(true);
      expect(vi.mocked(engine.observeFromDataSource)).toHaveBeenCalledWith(
        "goal-42",
        "coverage",
        "shell-1"
      );
      expect(result.data).toMatchObject({ dimension: "test-dim", value: 0.8 });
    });

    it("includes dimension and source in summary", async () => {
      const input = { goal_id: "g", dimension_name: "velocity", source_id: "jira" };
      const result = await tool.call(input, makeContext());
      expect(result.summary).toContain("velocity");
      expect(result.summary).toContain("jira");
    });
  });

  describe("Zod validation — missing required params", () => {
    it("rejects missing goal_id", () => {
      const result = tool.inputSchema.safeParse({ dimension_name: "d", source_id: "s" });
      expect(result.success).toBe(false);
    });

    it("rejects empty dimension_name", () => {
      const result = tool.inputSchema.safeParse({ goal_id: "g", dimension_name: "", source_id: "s" });
      expect(result.success).toBe(false);
    });

    it("rejects missing source_id", () => {
      const result = tool.inputSchema.safeParse({ goal_id: "g", dimension_name: "d" });
      expect(result.success).toBe(false);
    });
  });

  describe("error handling", () => {
    it("returns failure when observeFromDataSource throws", async () => {
      vi.mocked(engine.observeFromDataSource).mockRejectedValue(new Error("source unavailable"));
      const input = { goal_id: "g", dimension_name: "d", source_id: "s" };
      const result = await tool.call(input, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain("source unavailable");
    });
  });
});
