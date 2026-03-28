/**
 * tests/goal-cli-refine.test.ts
 *
 * Tests for goal add CLI integration with GoalRefiner.
 * Covers: refine() by default, --no-refine skip, raw mode unchanged, error fallback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StateManager } from "../src/state-manager.js";
import type { CharacterConfigManager } from "../src/traits/character-config.js";
import type { Goal } from "../src/types/goal.js";
import type { RefineResult } from "../src/types/goal-refiner.js";

// ─── Helpers ───

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: "goal_test_1",
    parent_id: null,
    node_type: "goal",
    title: "Test goal",
    description: "Test goal description",
    status: "active",
    loop_status: "idle",
    dimensions: [],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: "negotiate",
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: 0,
    specificity_score: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeRefineResult(overrides: Partial<RefineResult> = {}): RefineResult {
  return {
    goal: makeGoal(),
    leaf: true,
    children: null,
    feasibility: null,
    tokensUsed: 500,
    reason: "measurable",
    ...overrides,
  };
}

// ─── Mock module factories ───

function makeMockStateManager(): StateManager {
  const goals = new Map<string, Goal>();
  return {
    saveGoal: vi.fn(async (goal: Goal) => { goals.set(goal.id, goal); }),
    loadGoal: vi.fn(async (id: string) => goals.get(id) ?? null),
    deleteGoal: vi.fn(async (id: string) => { goals.delete(id); }),
    getBaseDir: vi.fn(() => "/tmp/pulseed-test"),
  } as unknown as StateManager;
}

function makeMockCharacterConfigManager(): CharacterConfigManager {
  return {
    load: vi.fn(async () => ({
      caution_level: 3,
      stall_flexibility: 3,
      communication_directness: 3,
      proactivity_level: 3,
    })),
  } as unknown as CharacterConfigManager;
}

// ─── Tests ───

describe("cmdGoalAdd — GoalRefiner integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls refiner.refine() by default (no --no-refine)", async () => {
    // Arrange
    const stateManager = makeMockStateManager();
    const characterConfigManager = makeMockCharacterConfigManager();
    const refineResult = makeRefineResult();
    const mockRefine = vi.fn(async () => refineResult);

    // Mock dynamic imports inside cmdGoalAdd
    const mockGoalRefiner = { refine: mockRefine };

    vi.doMock("../src/cli/setup.js", () => ({
      buildDeps: vi.fn(async () => ({
        goalNegotiator: { negotiate: vi.fn() },
        goalRefiner: mockGoalRefiner,
        coreLoop: {},
        reportingEngine: {},
        stateManager,
        driveSystem: {},
      })),
    }));

    vi.doMock("../src/goal/goal-refiner.js", () => ({
      GoalRefiner: vi.fn().mockImplementation(() => mockGoalRefiner),
      collectLeafGoalIds: vi.fn((result: { goal: { id: string }; leaf: boolean; children: null }) => [result.goal.id]),
    }));

    vi.doMock("../src/cli/ensure-api-key.js", () => ({
      ensureProviderConfig: vi.fn(async () => {}),
    }));

    vi.doMock("../src/llm/provider-factory.js", () => ({
      buildLLMClient: vi.fn(async () => ({})),
    }));

    vi.doMock("../src/observation/observation-engine.js", () => ({
      ObservationEngine: vi.fn().mockImplementation(() => ({})),
    }));

    vi.doMock("../src/traits/ethics-gate.js", () => ({
      EthicsGate: vi.fn().mockImplementation(() => ({})),
    }));

    vi.doMock("../src/goal/goal-tree-manager.js", () => ({
      GoalTreeManager: vi.fn().mockImplementation(() => ({})),
    }));

    vi.doMock("../src/goal/goal-dependency-graph.js", () => ({
      GoalDependencyGraph: vi.fn().mockImplementation(() => ({})),
    }));

    vi.doMock("../src/observation/workspace-context.js", () => ({
      createWorkspaceContextProvider: vi.fn(() => ({})),
    }));

    // Import after mocking
    const { cmdGoalAdd } = await import("../src/cli/commands/goal.js");

    // Act
    const code = await cmdGoalAdd(
      stateManager,
      characterConfigManager,
      "Increase test coverage to 90%",
      {}
    );

    // Assert
    expect(code).toBe(0);
    expect(mockRefine).toHaveBeenCalledOnce();
    expect(mockRefine).toHaveBeenCalledWith(expect.any(String), { feasibilityCheck: true });

    vi.resetModules();
  });

  it("skips refiner.refine() when --no-refine is set (uses legacy negotiate)", async () => {
    // Arrange
    const stateManager = makeMockStateManager();
    const characterConfigManager = makeMockCharacterConfigManager();
    const mockNegotiate = vi.fn(async () => ({
      goal: makeGoal({ id: "goal_legacy_1" }),
      response: { type: "accept", message: "Looks good" },
    }));
    const mockRefine = vi.fn();

    vi.doMock("../src/cli/setup.js", () => ({
      buildDeps: vi.fn(async () => ({
        goalNegotiator: { negotiate: mockNegotiate },
        goalRefiner: { refine: mockRefine },
        coreLoop: {},
        reportingEngine: {},
        stateManager,
        driveSystem: {},
      })),
    }));

    vi.doMock("../src/goal/goal-refiner.js", () => ({
      GoalRefiner: vi.fn().mockImplementation(() => ({ refine: mockRefine })),
      collectLeafGoalIds: vi.fn((result: { goal: { id: string }; leaf: boolean; children: null }) => [result.goal.id]),
    }));

    vi.doMock("../src/cli/ensure-api-key.js", () => ({
      ensureProviderConfig: vi.fn(async () => {}),
    }));

    vi.doMock("../src/goal/goal-negotiator.js", () => ({
      EthicsRejectedError: class extends Error {},
      gatherNegotiationContext: vi.fn(async () => null),
    }));

    const { cmdGoalAdd } = await import("../src/cli/commands/goal.js");

    // Act
    const code = await cmdGoalAdd(
      stateManager,
      characterConfigManager,
      "Increase test coverage to 90%",
      { noRefine: true }
    );

    // Assert
    expect(code).toBe(0);
    expect(mockNegotiate).toHaveBeenCalledOnce();
    expect(mockRefine).not.toHaveBeenCalled();

    vi.resetModules();
  });

  it("refine() error falls back gracefully (returns 0, goal already saved)", async () => {
    // Arrange
    const stateManager = makeMockStateManager();
    const characterConfigManager = makeMockCharacterConfigManager();
    const mockRefine = vi.fn(async () => { throw new Error("LLM timeout"); });

    const mockGoalRefiner2 = { refine: mockRefine };

    vi.doMock("../src/cli/setup.js", () => ({
      buildDeps: vi.fn(async () => ({
        goalNegotiator: { negotiate: vi.fn() },
        goalRefiner: mockGoalRefiner2,
        coreLoop: {},
        reportingEngine: {},
        stateManager,
        driveSystem: {},
      })),
    }));

    vi.doMock("../src/goal/goal-refiner.js", () => ({
      GoalRefiner: vi.fn().mockImplementation(() => mockGoalRefiner2),
      collectLeafGoalIds: vi.fn((result: { goal: { id: string }; leaf: boolean; children: null }) => [result.goal.id]),
    }));

    vi.doMock("../src/cli/ensure-api-key.js", () => ({
      ensureProviderConfig: vi.fn(async () => {}),
    }));

    vi.doMock("../src/llm/provider-factory.js", () => ({
      buildLLMClient: vi.fn(async () => ({})),
    }));

    vi.doMock("../src/observation/observation-engine.js", () => ({
      ObservationEngine: vi.fn().mockImplementation(() => ({})),
    }));

    vi.doMock("../src/traits/ethics-gate.js", () => ({
      EthicsGate: vi.fn().mockImplementation(() => ({})),
    }));

    vi.doMock("../src/goal/goal-tree-manager.js", () => ({
      GoalTreeManager: vi.fn().mockImplementation(() => ({})),
    }));

    vi.doMock("../src/goal/goal-dependency-graph.js", () => ({
      GoalDependencyGraph: vi.fn().mockImplementation(() => ({})),
    }));

    vi.doMock("../src/observation/workspace-context.js", () => ({
      createWorkspaceContextProvider: vi.fn(() => ({})),
    }));

    const { cmdGoalAdd } = await import("../src/cli/commands/goal.js");

    // Act
    const code = await cmdGoalAdd(
      stateManager,
      characterConfigManager,
      "Increase test coverage to 90%",
      {}
    );

    // Assert: fallback returns 0 (goal saved in unrefined state)
    expect(code).toBe(0);
    // Stub goal was saved before refine() was called
    expect(stateManager.saveGoal).toHaveBeenCalled();

    vi.resetModules();
  });
});

describe("cmdGoalAddRaw — raw mode unchanged", () => {
  it("saves goal without calling LLM when --title and --dim provided", async () => {
    const stateManager = makeMockStateManager();

    const { cmdGoalAddRaw } = await import("../src/cli/commands/goal-raw.js");

    const code = await cmdGoalAddRaw(stateManager, {
      title: "tsc zero",
      description: "tsc zero",
      rawDimensions: ["tsc_error_count:min:0"],
    });

    expect(code).toBe(0);
    // Should save goal via stateManager
    expect(stateManager.saveGoal).toHaveBeenCalledOnce();
    const savedGoal = (stateManager.saveGoal as ReturnType<typeof vi.fn>).mock.calls[0][0] as Goal;
    expect(savedGoal.dimensions).toHaveLength(1);
    expect(savedGoal.dimensions[0].name).toBe("tsc_error_count");
    expect(savedGoal.origin).toBe("manual");
  });
});
