import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoalStateTool } from "../GoalStateTool.js";
import type { ToolCallContext } from "../../../types.js";
import type { StateManager } from "../../../../base/state/state-manager.js";

function makeContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

function makeGoal(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Goal ${id}`,
    description: "test goal",
    status: "active",
    loop_status: "running",
    parent_id: null,
    children_ids: [],
    dimensions: [
      {
        name: "coverage",
        label: "Coverage",
        current_value: 0.75,
        threshold: { type: "min", value: 0.8 },
        confidence: 0.9,
        last_updated: "2024-01-01T00:00:00Z",
        weight: 1.0,
        uncertainty_weight: null,
        history: [],
        observation_method: { type: "shell", command: "echo 0.75" },
        state_integrity: "ok",
        last_observed_layer: undefined,
        dimension_mapping: null,
      },
    ],
    ...overrides,
  };
}

describe("GoalStateTool", () => {
  let stateManager: StateManager;
  let tool: GoalStateTool;

  beforeEach(() => {
    stateManager = {
      listGoalIds: vi.fn(),
      loadGoal: vi.fn(),
      getSubtree: vi.fn(),
    } as unknown as StateManager;
    tool = new GoalStateTool(stateManager);
  });

  it("returns metadata with correct name and tags", () => {
    expect(tool.metadata.name).toBe("goal_state");
    expect(tool.metadata.tags).toContain("self-grounding");
    expect(tool.metadata.isReadOnly).toBe(true);
  });

  it("description returns non-empty string", () => {
    expect(tool.description()).toContain("goal");
  });

  it("checkPermissions returns allowed", async () => {
    const result = await tool.checkPermissions({ includeTree: false }, makeContext());
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", () => {
    expect(tool.isConcurrencySafe({ includeTree: false })).toBe(true);
  });

  it("returns all active goals when no goalId given", async () => {
    vi.mocked(stateManager.listGoalIds).mockResolvedValue(["g1", "g2"]);
    vi.mocked(stateManager.loadGoal).mockImplementation(async (id) => makeGoal(id) as any);

    const result = await tool.call({ includeTree: false }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { goals: unknown[] };
    expect(data.goals).toHaveLength(2);
    expect(result.summary).toContain("2");
  });

  it("returns empty when no goals exist", async () => {
    vi.mocked(stateManager.listGoalIds).mockResolvedValue([]);
    const result = await tool.call({ includeTree: false }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { goals: unknown[] };
    expect(data.goals).toHaveLength(0);
    expect(result.summary).toContain("No active goals");
  });

  it("returns single goal when goalId is given", async () => {
    vi.mocked(stateManager.loadGoal).mockResolvedValue(makeGoal("g1") as any);
    const result = await tool.call({ goalId: "g1", includeTree: false }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { id: string; dimensions: unknown[] };
    expect(data.id).toBe("g1");
    expect(data.dimensions).toHaveLength(1);
  });

  it("returns failure when specific goal not found", async () => {
    vi.mocked(stateManager.loadGoal).mockResolvedValue(null);
    const result = await tool.call({ goalId: "missing", includeTree: false }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("missing");
  });

  it("includes subtree when includeTree is true and children exist", async () => {
    const parentGoal = makeGoal("parent", { children_ids: ["child1"] });
    vi.mocked(stateManager.loadGoal).mockResolvedValue(parentGoal as any);
    vi.mocked(stateManager.getSubtree).mockResolvedValue([
      makeGoal("parent") as any,
      makeGoal("child1", { parent_id: "parent" }) as any,
    ]);

    const result = await tool.call({ goalId: "parent", includeTree: true }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { subtree: unknown[] };
    expect(data.subtree).toHaveLength(1);
  });

  it("handles stateManager error gracefully", async () => {
    vi.mocked(stateManager.listGoalIds).mockRejectedValue(new Error("disk error"));
    const result = await tool.call({ includeTree: false }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("disk error");
  });
});
