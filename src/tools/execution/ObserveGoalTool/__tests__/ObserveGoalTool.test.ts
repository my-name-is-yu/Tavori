import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObserveGoalTool } from "../ObserveGoalTool.js";
import type { ObservationEngine } from "../../../../platform/observation/observation-engine.js";
import type { ToolCallContext } from "../../../types.js";

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
});

function makeMockEngine(overrides: Partial<ObservationEngine> = {}): ObservationEngine {
  return {
    observe: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ObservationEngine;
}

describe("ObserveGoalTool", () => {
  let engine: ObservationEngine;
  let tool: ObserveGoalTool;

  beforeEach(() => {
    engine = makeMockEngine();
    tool = new ObserveGoalTool(engine);
  });

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("observe-goal");
    });

    it("is read-only", () => {
      expect(tool.metadata.isReadOnly).toBe(true);
      expect(tool.metadata.permissionLevel).toBe("read_only");
    });

    it("is not destructive", () => {
      expect(tool.metadata.isDestructive).toBe(false);
    });

    it("has correct description", () => {
      expect(tool.description()).toContain("observation");
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns true", () => {
      expect(tool.isConcurrencySafe({ goal_id: "g" })).toBe(true);
    });
  });

  describe("checkPermissions", () => {
    it("always returns allowed", async () => {
      const result = await tool.checkPermissions({ goal_id: "g" }, makeContext());
      expect(result.status).toBe("allowed");
    });
  });

  describe("successful execution", () => {
    it("calls engine.observe with correct goal_id and empty methods", async () => {
      const input = { goal_id: "goal-42" };
      const result = await tool.call(input, makeContext());

      expect(result.success).toBe(true);
      expect(vi.mocked(engine.observe)).toHaveBeenCalledWith("goal-42", []);
    });

    it("includes goal_id in result data", async () => {
      const input = { goal_id: "goal-42" };
      const result = await tool.call(input, makeContext());
      expect((result.data as { goal_id: string }).goal_id).toBe("goal-42");
    });

    it("includes goal_id in summary", async () => {
      const input = { goal_id: "goal-42" };
      const result = await tool.call(input, makeContext());
      expect(result.summary).toContain("goal-42");
    });
  });

  describe("Zod validation — missing required params", () => {
    it("rejects missing goal_id", () => {
      const result = tool.inputSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects empty goal_id", () => {
      const result = tool.inputSchema.safeParse({ goal_id: "" });
      expect(result.success).toBe(false);
    });
  });

  describe("error handling", () => {
    it("returns failure when engine.observe throws", async () => {
      vi.mocked(engine.observe).mockRejectedValue(new Error("observation failed"));
      const input = { goal_id: "g" };
      const result = await tool.call(input, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain("observation failed");
    });
  });
});
