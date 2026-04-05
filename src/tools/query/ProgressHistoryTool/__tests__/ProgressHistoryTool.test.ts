import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProgressHistoryTool } from "../ProgressHistoryTool.js";
import type { StateManager } from "../../../../base/state/state-manager.js";
import type { ToolCallContext } from "../../../types.js";
import type { GapHistoryEntry } from "../../../../base/types/gap.js";

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
});

function makeGapEntry(
  iteration: number,
  gap: number,
  confidence = 0.8,
  dimName = "tests_passing"
): GapHistoryEntry {
  return {
    iteration,
    timestamp: new Date(Date.now() + iteration * 1000).toISOString(),
    gap_vector: [{ dimension_name: dimName, normalized_weighted_gap: gap }],
    confidence_vector: [{ dimension_name: dimName, confidence }],
  };
}

function makeMockStateManager(
  overrides: Partial<StateManager> = {}
): StateManager {
  return {
    loadGapHistory: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as StateManager;
}

describe("ProgressHistoryTool", () => {
  let sm: StateManager;
  let tool: ProgressHistoryTool;

  beforeEach(() => {
    sm = makeMockStateManager();
    tool = new ProgressHistoryTool(sm);
  });

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("progress_history");
    });

    it("is read_only", () => {
      expect(tool.metadata.permissionLevel).toBe("read_only");
      expect(tool.metadata.isReadOnly).toBe(true);
    });

    it("is not destructive", () => {
      expect(tool.metadata.isDestructive).toBe(false);
    });
  });

  describe("checkPermissions", () => {
    it("always returns allowed", async () => {
      const result = await tool.checkPermissions({ goalId: "goal-1", limit: 10 }, makeContext());
      expect(result.status).toBe("allowed");
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns true", () => {
      expect(tool.isConcurrencySafe()).toBe(true);
    });
  });

  describe("description", () => {
    it("returns non-empty string", () => {
      expect(tool.description()).toBeTruthy();
    });
  });

  describe("call — basic behavior", () => {
    it("returns empty history and insufficient_data when no history", async () => {
      vi.mocked(sm.loadGapHistory).mockResolvedValue([]);

      const result = await tool.call({ goalId: "goal-1", limit: 10 }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { history: unknown[]; trend: string };
      expect(data.history).toEqual([]);
      expect(data.trend).toBe("insufficient_data");
    });

    it("returns goalId in output", async () => {
      vi.mocked(sm.loadGapHistory).mockResolvedValue([]);

      const result = await tool.call({ goalId: "my-goal", limit: 10 }, makeContext());

      const data = result.data as { goalId: string };
      expect(data.goalId).toBe("my-goal");
    });

    it("maps gap history entries to history points", async () => {
      const entries = [
        makeGapEntry(1, 0.5),
        makeGapEntry(2, 0.4),
      ];
      vi.mocked(sm.loadGapHistory).mockResolvedValue(entries);

      const result = await tool.call({ goalId: "goal-1", limit: 10 }, makeContext());

      const data = result.data as { history: Array<{ iteration: number; dimensions: unknown[] }> };
      expect(data.history.length).toBe(2);
      expect(data.history[0]?.iteration).toBe(1);
      expect(data.history[0]?.dimensions.length).toBe(1);
    });

    it("respects limit parameter", async () => {
      const entries = Array.from({ length: 20 }, (_, i) => makeGapEntry(i + 1, 0.5));
      vi.mocked(sm.loadGapHistory).mockResolvedValue(entries);

      const result = await tool.call({ goalId: "goal-1", limit: 5 }, makeContext());

      const data = result.data as { history: unknown[] };
      expect(data.history.length).toBe(5);
    });
  });

  describe("trend detection", () => {
    it("returns insufficient_data for fewer than 3 entries", async () => {
      vi.mocked(sm.loadGapHistory).mockResolvedValue([
        makeGapEntry(1, 0.5),
        makeGapEntry(2, 0.4),
      ]);

      const result = await tool.call({ goalId: "goal-1", limit: 10 }, makeContext());

      const data = result.data as { trend: string };
      expect(data.trend).toBe("insufficient_data");
    });

    it("detects improving trend (gap consistently decreasing)", async () => {
      vi.mocked(sm.loadGapHistory).mockResolvedValue([
        makeGapEntry(1, 0.8),
        makeGapEntry(2, 0.6),
        makeGapEntry(3, 0.3),
      ]);

      const result = await tool.call({ goalId: "goal-1", limit: 10 }, makeContext());

      const data = result.data as { trend: string };
      expect(data.trend).toBe("improving");
    });

    it("detects declining trend (gap consistently increasing)", async () => {
      vi.mocked(sm.loadGapHistory).mockResolvedValue([
        makeGapEntry(1, 0.2),
        makeGapEntry(2, 0.5),
        makeGapEntry(3, 0.8),
      ]);

      const result = await tool.call({ goalId: "goal-1", limit: 10 }, makeContext());

      const data = result.data as { trend: string };
      expect(data.trend).toBe("declining");
    });

    it("detects stagnating trend (gap unchanged within threshold)", async () => {
      vi.mocked(sm.loadGapHistory).mockResolvedValue([
        makeGapEntry(1, 0.5),
        makeGapEntry(2, 0.51),
        makeGapEntry(3, 0.49),
      ]);

      const result = await tool.call({ goalId: "goal-1", limit: 10 }, makeContext());

      const data = result.data as { trend: string };
      expect(data.trend).toBe("stagnating");
    });

    it("uses last 3 entries for trend when history is long", async () => {
      // First entries improving, last 3 declining
      const entries = [
        makeGapEntry(1, 0.9),
        makeGapEntry(2, 0.7),
        makeGapEntry(3, 0.5),
        makeGapEntry(4, 0.5),
        makeGapEntry(5, 0.6),
        makeGapEntry(6, 0.8),
      ];
      vi.mocked(sm.loadGapHistory).mockResolvedValue(entries);

      const result = await tool.call({ goalId: "goal-1", limit: 10 }, makeContext());

      const data = result.data as { trend: string };
      expect(data.trend).toBe("declining");
    });
  });

  describe("dimensionName filter", () => {
    it("filters to specific dimension", async () => {
      const entries = [
        {
          iteration: 1,
          timestamp: new Date().toISOString(),
          gap_vector: [
            { dimension_name: "tests_passing", normalized_weighted_gap: 0.5 },
            { dimension_name: "coverage", normalized_weighted_gap: 0.3 },
          ],
          confidence_vector: [
            { dimension_name: "tests_passing", confidence: 0.8 },
            { dimension_name: "coverage", confidence: 0.7 },
          ],
        },
      ];
      vi.mocked(sm.loadGapHistory).mockResolvedValue(entries);

      const result = await tool.call(
        { goalId: "goal-1", limit: 10, dimensionName: "tests_passing" },
        makeContext()
      );

      const data = result.data as { history: Array<{ dimensions: Array<{ name: string }> }> };
      expect(data.history[0]?.dimensions.length).toBe(1);
      expect(data.history[0]?.dimensions[0]?.name).toBe("tests_passing");
    });

    it("returns empty dimensions for missing dimension name", async () => {
      vi.mocked(sm.loadGapHistory).mockResolvedValue([makeGapEntry(1, 0.5)]);

      const result = await tool.call(
        { goalId: "goal-1", limit: 10, dimensionName: "nonexistent" },
        makeContext()
      );

      const data = result.data as { history: Array<{ dimensions: unknown[] }> };
      expect(data.history[0]?.dimensions).toEqual([]);
    });
  });

  describe("output shape", () => {
    it("includes value as 1-gap", async () => {
      vi.mocked(sm.loadGapHistory).mockResolvedValue([makeGapEntry(1, 0.3)]);

      const result = await tool.call({ goalId: "goal-1", limit: 10 }, makeContext());

      const data = result.data as { history: Array<{ dimensions: Array<{ value: number; gap: number }> }> };
      const dim = data.history[0]?.dimensions[0];
      expect(dim?.gap).toBeCloseTo(0.3);
      expect(dim?.value).toBeCloseTo(0.7);
    });
  });

  describe("error handling", () => {
    it("returns failure on exception", async () => {
      vi.mocked(sm.loadGapHistory).mockRejectedValue(new Error("read error"));

      const result = await tool.call({ goalId: "goal-1", limit: 10 }, makeContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain("read error");
    });
  });
});
