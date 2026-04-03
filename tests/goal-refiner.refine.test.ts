import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { GoalRefiner } from "../src/goal/goal-refiner.js";
import type { StateManager } from "../src/state/state-manager.js";
import type { ObservationEngine } from "../src/observation/observation-engine.js";
import type { GoalNegotiator } from "../src/goal/goal-negotiator.js";
import type { GoalTreeManager } from "../src/goal/goal-tree-manager.js";
import type { EthicsGate } from "../src/traits/ethics-gate.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeGoal, makeDimension } from "./helpers/fixtures.js";

const measurableResponses = {
  shell: JSON.stringify({
    is_measurable: true,
    dimensions: [
      {
        name: "test_coverage",
        label: "Test Coverage %",
        threshold_type: "min",
        threshold_value: 80,
        data_source: "shell",
        observation_command: "npm test -- --coverage | grep Statements",
      },
    ],
    reason: "Coverage is directly measurable with a shell command",
  }),
  fileExistence: JSON.stringify({
    is_measurable: true,
    dimensions: [
      {
        name: "release_ready",
        label: "Release Ready",
        threshold_type: "present",
        threshold_value: null,
        data_source: "file_existence",
        observation_command: "test -f RELEASE_READY",
      },
    ],
    reason: "Release readiness is represented by a file marker",
  }),
  api: JSON.stringify({
    is_measurable: true,
    dimensions: [
      {
        name: "api_online",
        label: "API Online",
        threshold_type: "match",
        threshold_value: "ok",
        data_source: "api",
        observation_command: "curl -fsS https://example.com/health",
      },
    ],
    reason: "The API exposes a health endpoint that can be queried",
  }),
} as const;

const normalizedGoalExpectations = {
  shell: {
    reason: "Coverage is directly measurable with a shell command",
    threshold: { type: "min", value: 80 },
    observation_method: {
      type: "mechanical",
      source: "shell",
      endpoint: "npm test -- --coverage | grep Statements",
      confidence_tier: "mechanical",
    },
  },
  file_existence: {
    reason: "Release readiness is represented by a file marker",
    threshold: { type: "present" },
    observation_method: {
      type: "file_check",
      source: "file_existence",
      endpoint: "test -f RELEASE_READY",
      confidence_tier: "mechanical",
    },
  },
  api: {
    reason: "The API exposes a health endpoint that can be queried",
    threshold: { type: "match", value: "ok" },
    observation_method: {
      type: "api_query",
      source: "api",
      endpoint: "curl -fsS https://example.com/health",
      confidence_tier: "self_report",
    },
  },
} as const;

const feasibilityResponse = JSON.stringify({
  assessment: "realistic",
  confidence: "high",
  reasoning: "Target is achievable",
  key_assumptions: ["Tests exist"],
  main_risks: [],
});

function makeStateManager(goals: Record<string, ReturnType<typeof makeGoal>> = {}): StateManager {
  const store = { ...goals };
  return {
    loadGoal: vi.fn(async (id: string) => store[id] ?? null),
    saveGoal: vi.fn(async (goal: ReturnType<typeof makeGoal>) => {
      store[goal.id] = goal;
    }),
  } as unknown as StateManager;
}

function makeObservationEngine(): ObservationEngine {
  return {
    getDataSources: vi.fn(() => [{ sourceId: "shell", config: { name: "shell" } }]),
  } as unknown as ObservationEngine;
}

function makeNegotiator(): GoalNegotiator {
  return {} as unknown as GoalNegotiator;
}

function makeTreeManager(): GoalTreeManager {
  return {
    decomposeGoal: vi.fn(async (_goalId: string) => ({
      parent_id: _goalId,
      children: [],
      depth: 1,
      specificity_scores: {},
      reasoning: "Decomposed into sub-goals",
    })),
  } as unknown as GoalTreeManager;
}

function makeEthicsGate(): EthicsGate {
  return {} as unknown as EthicsGate;
}

describe("GoalRefiner.refine()", () => {
  let goalId: string;
  let goal: ReturnType<typeof makeGoal>;

  beforeEach(() => {
    goalId = randomUUID();
    goal = makeGoal({
      id: goalId,
      description: "Achieve 80% test coverage",
      dimensions: [],
      origin: null,
      user_override: false,
    });
  });

  it.each([
    {
      name: "shell",
      response: measurableResponses.shell,
      expected: normalizedGoalExpectations.shell,
    },
    {
      name: "file_existence",
      response: measurableResponses.fileExistence,
      expected: normalizedGoalExpectations.file_existence,
    },
    {
      name: "api",
      response: measurableResponses.api,
      expected: normalizedGoalExpectations.api,
    },
  ])("normalizes $name input through refine()", async ({ response, expected }) => {
    const llmClient = createMockLLMClient([response, feasibilityResponse]);
    const stateManager = makeStateManager({ [goalId]: goal });
    const refiner = new GoalRefiner(
      stateManager,
      llmClient,
      makeObservationEngine(),
      makeNegotiator(),
      makeTreeManager(),
      makeEthicsGate()
    );

    const result = await refiner.refine(goalId);

    expect(result).toMatchObject({
      leaf: true,
      children: null,
      feasibility: [
        expect.objectContaining({
          assessment: "realistic",
          confidence: "high",
          reasoning: "Target is achievable",
          key_assumptions: ["Tests exist"],
          main_risks: [],
        }),
      ],
      tokensUsed: expect.any(Number),
      reason: expected.reason,
    });
    expect(result.goal).toMatchObject({
      id: goalId,
      description: "Achieve 80% test coverage",
      node_type: "leaf",
      children_ids: [],
      dimensions: [
        expect.objectContaining({
          threshold: expected.threshold,
          observation_method: expect.objectContaining(expected.observation_method),
        }),
      ],
    });
    expect(result.goal.dimensions[0]).toMatchObject({
      threshold: expected.threshold,
      observation_method: expected.observation_method,
    });
  });

  it.each([
    {
      name: "schema-invalid JSON",
      response: JSON.stringify({
        is_measurable: true,
        dimensions: [
          {
            name: "broken",
            label: "Broken",
            threshold_type: "min",
            threshold_value: 10,
            data_source: "shell",
          },
        ],
      }),
      expectedReason: "LLM parse failure",
    },
    {
      name: "non-JSON text",
      response: "this is not json at all",
      expectedReason: "LLM parse failure",
    },
  ])("normalizes malformed payloads from $name", async ({ response, expectedReason }) => {
    const childId = randomUUID();
    const childGoal = makeGoal({
      id: childId,
      description: "Sub-goal",
      parent_id: goalId,
      origin: null,
      user_override: true,
      dimensions: [makeDimension()],
    });

    const llmClient = createMockLLMClient([response]);
    const stateManager = makeStateManager({ [goalId]: goal, [childId]: childGoal });
    const treeManager = makeTreeManager();
    (treeManager.decomposeGoal as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_goalId: string) => {
        const updated = { ...goal, children_ids: [childId] };
        await stateManager.saveGoal(updated as ReturnType<typeof makeGoal>);
        return {
          parent_id: _goalId,
          children: [childGoal],
          depth: 1,
          specificity_scores: {},
          reasoning: `Decomposed after ${expectedReason}`,
        };
      }
    );

    const refiner = new GoalRefiner(
      stateManager,
      llmClient,
      makeObservationEngine(),
      makeNegotiator(),
      treeManager,
      makeEthicsGate()
    );

    const result = await refiner.refine(goalId);

    expect(result.leaf).toBe(false);
    expect(result.children).toHaveLength(1);
    expect(result.children?.[0]).toMatchObject({
      leaf: true,
      children: null,
      feasibility: null,
      reason: "already has validated dimensions",
      goal: expect.objectContaining({
        id: childId,
        parent_id: goalId,
        node_type: "goal",
        user_override: true,
        children_ids: [],
      }),
    });
    expect(result.feasibility).toBeNull();
    expect(result.reason).toBe(expectedReason);
    expect(result.tokensUsed).toEqual(expect.any(Number));
    expect(result.goal).toMatchObject({
      id: goalId,
      node_type: "goal",
      children_ids: [childId],
    });
    expect(stateManager.saveGoal).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "sync throw",
      setup(treeManager: GoalTreeManager, rejection: Error) {
        (treeManager.decomposeGoal as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
          throw rejection;
        });
      },
    },
    {
      name: "async rejection",
      setup(treeManager: GoalTreeManager, rejection: Error) {
        (treeManager.decomposeGoal as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
          rejection
        );
      },
    },
  ])("preserves downstream $name failures", async ({ setup }) => {
    const llmClient = createMockLLMClient([
      JSON.stringify({
        is_measurable: false,
        dimensions: null,
        reason: "Goal is too abstract to measure directly",
      }),
    ]);
    const stateManager = makeStateManager({ [goalId]: goal });
    const treeManager = makeTreeManager();
    const rejection = new Error("tree manager unavailable");
    setup(treeManager, rejection);

    const refiner = new GoalRefiner(
      stateManager,
      llmClient,
      makeObservationEngine(),
      makeNegotiator(),
      treeManager,
      makeEthicsGate()
    );

    await expect(refiner.refine(goalId)).rejects.toBe(rejection);
    expect(stateManager.saveGoal).not.toHaveBeenCalled();
  });
});
