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
import { ZodError } from "zod";

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
  file_existence: JSON.stringify({
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

const expectedNormalizedDimensions = {
  shell: {
    name: "test_coverage",
    label: "Test Coverage %",
    threshold: { type: "min", value: 80 },
    observation_method: {
      type: "mechanical",
      source: "shell",
      endpoint: "npm test -- --coverage | grep Statements",
      confidence_tier: "mechanical",
      schedule: null,
    },
  },
  file_existence: {
    name: "release_ready",
    label: "Release Ready",
    threshold: { type: "present" },
    observation_method: {
      type: "file_check",
      source: "file_existence",
      endpoint: "test -f RELEASE_READY",
      confidence_tier: "mechanical",
      schedule: null,
    },
  },
  api: {
    name: "api_online",
    label: "API Online",
    threshold: { type: "match", value: "ok" },
    observation_method: {
      type: "api_query",
      source: "api",
      endpoint: "curl -fsS https://example.com/health",
      confidence_tier: "self_report",
      schedule: null,
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

describe("refine()", () => {
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
      expected: expectedNormalizedDimensions.shell,
      reason: "Coverage is directly measurable with a shell command",
      feasibilityDimension: "test_coverage",
    },
    {
      name: "file_existence",
      response: measurableResponses.file_existence,
      expected: expectedNormalizedDimensions.file_existence,
      reason: "Release readiness is represented by a file marker",
      feasibilityDimension: "release_ready",
    },
    {
      name: "api",
      response: measurableResponses.api,
      expected: expectedNormalizedDimensions.api,
      reason: "The API exposes a health endpoint that can be queried",
      feasibilityDimension: "api_online",
    },
  ])("normalizes supported $name payloads through GoalRefiner.refine()", async ({ response, expected, reason, feasibilityDimension }) => {
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

    expect(result.goal).toEqual({
      ...goal,
      node_type: "leaf",
      dimensions: [
        {
          name: expected.name,
          label: expected.label,
          current_value: null,
          threshold: expected.threshold,
          confidence: 0.5,
          observation_method: expected.observation_method,
          last_updated: expect.any(String),
          history: [],
          weight: 1,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
      updated_at: expect.any(String),
    });
    expect(result).toMatchObject({
      leaf: true,
      children: null,
      reason,
      feasibility: [
        {
          dimension: feasibilityDimension,
          path: "qualitative",
          assessment: "realistic",
          confidence: "high",
          reasoning: "Target is achievable",
          key_assumptions: ["Tests exist"],
          main_risks: [],
        },
      ],
      tokensUsed: expect.any(Number),
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
    },
    {
      name: "non-JSON text",
      response: "this is not json at all",
    },
  ])("normalizes malformed payloads from $name into the canonical failure shape", async ({ response }) => {
    const expectedReason = "LLM parse failure";
    const childId = randomUUID();
    const childGoal = makeGoal({
      id: childId,
      description: "Sub-goal",
      parent_id: goalId,
      origin: null,
      user_override: true,
      dimensions: [makeDimension()],
    });

    const llmClient = createMockLLMClient([
      response,
    ]);
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
          reasoning: "Decomposed after parse failure",
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

    expect(result).toMatchObject({
      goal: {
        ...goal,
        node_type: "goal",
        children_ids: [childId],
      },
      leaf: false,
      children: [
        {
          goal: childGoal,
          leaf: true,
          children: null,
          feasibility: null,
          tokensUsed: expect.any(Number),
          reason: "already has validated dimensions",
        },
      ],
      feasibility: null,
      tokensUsed: expect.any(Number),
      reason: expectedReason,
    });
    expect(result.goal.node_type).toBe("goal");
    expect(result.goal.children_ids).toEqual([childId]);
    expect(result.children).toHaveLength(1);
    expect(result.children?.[0]?.reason).toBe("already has validated dimensions");
    expect(result.reason).toBe(expectedReason);
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
        (treeManager.decomposeGoal as ReturnType<typeof vi.fn>).mockRejectedValueOnce(rejection);
      },
    },
  ])("propagates underlying refinement $name failures", async ({ setup }) => {
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

  it("rejects invalid refine config with the underlying schema error", async () => {
    const llmClient = createMockLLMClient([measurableResponses.shell, feasibilityResponse]);
    const stateManager = makeStateManager({ [goalId]: goal });
    const refiner = new GoalRefiner(
      stateManager,
      llmClient,
      makeObservationEngine(),
      makeNegotiator(),
      makeTreeManager(),
      makeEthicsGate()
    );

    await expect(refiner.refine(goalId, { maxDepth: 0 })).rejects.toBeInstanceOf(ZodError);
    expect(stateManager.saveGoal).not.toHaveBeenCalled();
  });

  it("propagates downstream state-write failures unchanged during decomposition", async () => {
    const llmClient = createMockLLMClient([
      JSON.stringify({
        is_measurable: false,
        dimensions: null,
        reason: "Goal is too abstract to measure directly",
      }),
    ]);
    const stateManager = makeStateManager({ [goalId]: goal });
    const rejection = new Error("state manager write failed");
    (stateManager.saveGoal as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw rejection;
    });
    const treeManager = makeTreeManager();
    (treeManager.decomposeGoal as ReturnType<typeof vi.fn>).mockImplementationOnce(async (id: string) => {
      await stateManager.saveGoal({
        ...goal,
        id,
        children_ids: [],
        updated_at: new Date().toISOString(),
      } as ReturnType<typeof makeGoal>);
      return {
        parent_id: id,
        children: [],
        depth: 1,
        specificity_scores: {},
        reasoning: "Decomposed into sub-goals",
      };
    });

    const refiner = new GoalRefiner(
      stateManager,
      llmClient,
      makeObservationEngine(),
      makeNegotiator(),
      treeManager,
      makeEthicsGate()
    );

    await expect(refiner.refine(goalId)).rejects.toBe(rejection);
  });
});
