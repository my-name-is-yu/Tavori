import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoalRefiner } from "../src/goal/goal-refiner.js";
import type { StateManager } from "../src/state/state-manager.js";
import type { ObservationEngine } from "../src/observation/observation-engine.js";
import type { GoalNegotiator } from "../src/goal/goal-negotiator.js";
import type { GoalTreeManager } from "../src/goal/goal-tree-manager.js";
import type { EthicsGate } from "../src/traits/ethics-gate.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeGoal, makeDimension } from "./helpers/fixtures.js";
import { randomUUID } from "node:crypto";

const notMeasurableLeafTestResponse = JSON.stringify({
  is_measurable: false,
  dimensions: null,
  reason: "Goal is too abstract to measure directly",
});

const measurableLeafTestResponse = JSON.stringify({
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
});

const feasibilityResponse = JSON.stringify({
  assessment: "realistic",
  confidence: "high",
  reasoning: "Target is achievable",
  key_assumptions: ["Tests exist"],
  main_risks: [],
});

// ─── Mock factories ───

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
    getDataSources: vi.fn(() => [
      { sourceId: "shell", config: { name: "shell" } },
    ]),
  } as unknown as ObservationEngine;
}

function makeNegotiator(): GoalNegotiator {
  return {} as unknown as GoalNegotiator;
}

function makeTreeManager(childGoals: ReturnType<typeof makeGoal>[] = []): GoalTreeManager {
  return {
    decomposeGoal: vi.fn(async (_goalId: string, _config: unknown) => {
      return {
        parent_id: _goalId,
        children: childGoals,
        depth: 1,
        specificity_scores: {},
        reasoning: "Decomposed into sub-goals",
      };
    }),
  } as unknown as GoalTreeManager;
}

function makeEthicsGate(): EthicsGate {
  return {} as unknown as EthicsGate;
}

// ─── Test suite ───

describe("GoalRefiner", () => {
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

  // ── Regression 1: supported leaf inputs → normalized RefineResult shape ──

  const normalizedLeafCases = [
    {
      name: "shell",
      response: JSON.stringify({
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
      expected: {
        reason: "Coverage is directly measurable with a shell command",
        threshold: { type: "min", value: 80 },
        observation_method: {
          type: "mechanical",
          source: "shell",
          endpoint: "npm test -- --coverage | grep Statements",
          confidence_tier: "mechanical",
        },
      },
    },
    {
      name: "file_existence",
      response: JSON.stringify({
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
      expected: {
        reason: "Release readiness is represented by a file marker",
        threshold: { type: "present" },
        observation_method: {
          type: "file_check",
          source: "file_existence",
          endpoint: "test -f RELEASE_READY",
          confidence_tier: "mechanical",
        },
      },
    },
    {
      name: "api",
      response: JSON.stringify({
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
      expected: {
        reason: "The API exposes a health endpoint that can be queried",
        threshold: { type: "match", value: "ok" },
        observation_method: {
          type: "api_query",
          source: "api",
          endpoint: "curl -fsS https://example.com/health",
          confidence_tier: "self_report",
        },
      },
    },
  ] as const;

  it.each(normalizedLeafCases)(
    "normalizes $name leaf inputs through refine()",
    async ({ response, expected }) => {
      const llmClient = createMockLLMClient([
        response,
        JSON.stringify({
          assessment: "realistic",
          confidence: "high",
          reasoning: "Target is achievable",
          key_assumptions: ["Tests exist"],
          main_risks: [],
        }),
      ]);
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
          }),
        ],
        reason: expected.reason,
        goal: expect.objectContaining({
          id: goalId,
          description: "Achieve 80% test coverage",
          node_type: "leaf",
          children_ids: [],
          origin: null,
          user_override: false,
          dimensions: [
            expect.objectContaining({
              threshold: expected.threshold,
              observation_method: expect.objectContaining(expected.observation_method),
            }),
          ],
        }),
      });
      expect(result.tokensUsed).toBeGreaterThan(0);
      expect(result.feasibility).toHaveLength(1);
      expect(result.goal.dimensions[0]).toMatchObject({
        name: expect.any(String),
        label: expect.any(String),
        threshold: expected.threshold,
        observation_method: expect.objectContaining(expected.observation_method),
      });
    }
  );

  // ── Regression 2: malformed payload → canonical fallback shape ──

  const malformedPayloadCases = [
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
            observation_command: "echo ok",
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
  ] as const;

  it.each(malformedPayloadCases)(
    "normalizes malformed payloads from $name into the canonical fallback refine shape",
    async ({ response, expectedReason }) => {
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
      const treeManager = makeTreeManager([childGoal]);
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

      expect(result).toEqual(
        expect.objectContaining({
          leaf: false,
          children: [
            expect.objectContaining({
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
            }),
          ],
          feasibility: null,
          reason: expectedReason,
          goal: expect.objectContaining({
            id: goalId,
            children_ids: [childId],
            node_type: "goal",
          }),
        })
      );
      expect(result.reason).toBe(expectedReason);
      expect(result.goal.id).toBe(goalId);
      expect(result.goal.node_type).toBe("goal");
      expect(result.goal.children_ids).toEqual([childId]);
      expect(result.children?.[0]?.goal.id).toBe(childId);
      expect(result.children?.[0]?.goal.node_type).toBe("goal");
      expect(result.children?.[0]?.reason).toBe("already has validated dimensions");
      expect(result.goal.children_ids).toEqual([childId]);
      expect(result.children).toHaveLength(1);
      expect(result.children?.[0]?.goal.dimensions).toHaveLength(1);
    }
  );

  // ── Regression 3: downstream failure propagation ──

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
  ] as const)(
    "propagates downstream decomposeGoal failures for $name without rewriting them",
    async ({ setup }) => {
      const llmClient = createMockLLMClient([notMeasurableLeafTestResponse]);
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
      await expect(stateManager.loadGoal(goalId)).resolves.toEqual(goal);
    }
  );

  // ── Test 2: non-measurable goal → decomposes and recursively refines ──

  it("decomposes and recursively refines when goal is not measurable", async () => {
    const childId = randomUUID();
    const childGoal = makeGoal({
      id: childId,
      description: "Set up CI pipeline",
      parent_id: goalId,
      dimensions: [],
      origin: null,
      user_override: false,
      decomposition_depth: 1,
    });

    // For the root: not measurable
    // For the child: measurable
    const llmClient = createMockLLMClient([
      notMeasurableLeafTestResponse,
      measurableLeafTestResponse,
      feasibilityResponse,
    ]);

    const parentGoalWithChild = makeGoal({
      ...goal,
      children_ids: [childId],
    });

    const stateManager = makeStateManager({
      [goalId]: goal,
      [childId]: childGoal,
    });

    // Override loadGoal to return updated parent after decompose saves it
    const loadGoalMock = vi.fn(async (id: string) => {
      if (id === goalId) {
        // Return parent with children after first call
        return loadGoalMock.mock.calls.length > 1 ? parentGoalWithChild : goal;
      }
      return childGoal;
    });
    (stateManager as unknown as { loadGoal: typeof loadGoalMock }).loadGoal = loadGoalMock;

    const treeManager = makeTreeManager([childGoal]);
    // After decomposeGoal, update parent's children_ids in stateManager
    (treeManager.decomposeGoal as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_goalId: string) => {
        const updated = { ...goal, children_ids: [childId] };
        await stateManager.saveGoal(updated as ReturnType<typeof makeGoal>);
        return {
          parent_id: _goalId,
          children: [childGoal],
          depth: 1,
          specificity_scores: {},
          reasoning: "Decomposed",
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
    expect(result.children![0]!.leaf).toBe(true);
    expect(result.children![0]!.goal.dimensions[0]!.name).toBe("test_coverage");
  });

  // ── Test 3: maxDepth reached → forces leaf for children at depth limit ──

  it("forces leaf when recursion depth >= maxDepth", async () => {
    const childId = randomUUID();
    const childGoal = makeGoal({
      id: childId,
      description: "Child goal",
      parent_id: goalId,
      origin: null,
      user_override: false,
      decomposition_depth: 1,
    });

    // Root (depth=0): not measurable → decomposes
    // Child (depth=1): depth >= maxDepth(1) → force leaf, no LLM call for child
    const llmClient = createMockLLMClient([notMeasurableLeafTestResponse]);

    const stateManager = makeStateManager({ [goalId]: goal, [childId]: childGoal });

    const treeManager = makeTreeManager([childGoal]);
    (treeManager.decomposeGoal as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_goalId: string) => {
        const updated = { ...goal, children_ids: [childId] };
        await stateManager.saveGoal(updated as ReturnType<typeof makeGoal>);
        return {
          parent_id: _goalId,
          children: [childGoal],
          depth: 1,
          specificity_scores: {},
          reasoning: "Decomposed",
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

    // maxDepth: 1 → children at depth 1 are forced leaves
    const result = await refiner.refine(goalId, { maxDepth: 1 });

    expect(result.leaf).toBe(false); // root is not a leaf
    expect(result.children).toHaveLength(1);
    expect(result.children![0]!.leaf).toBe(true);
    expect(result.children![0]!.reason).toContain("max depth");
    expect(result.children![0]!.feasibility).toBeNull();
    // Only 1 LLM call (for root leaf test); child forced leaf without LLM call
    expect(llmClient.callCount).toBe(1);
  });

  // ── Test 4: tokenBudget exhausted → forces leaf ──

  it("forces leaf when tokenBudget is exhausted", async () => {
    const childId = randomUUID();
    const childGoal = makeGoal({
      id: childId,
      description: "Child goal",
      parent_id: goalId,
      origin: null,
      user_override: false,
      dimensions: [], // no validated dimensions — would need LLM call if budget allowed
      decomposition_depth: 1,
    });

    // Root call uses notMeasurable → decomposes. After decomposition, child call
    // encounters budget exceeded because root LLM call consumed ~1010 tokens
    // and tokenBudget is set to 1 (below ~1010).
    // But actually the budget check fires BEFORE the LLM call on each iteration.
    // The root call's LLM response costs 1010 tokens.
    // On the child call, shared.tokensUsed=1010 >= tokenBudget=500 → force leaf.
    const llmClient = createMockLLMClient([notMeasurableLeafTestResponse]);

    const stateManager = makeStateManager({ [goalId]: goal, [childId]: childGoal });

    const treeManager = makeTreeManager([childGoal]);
    (treeManager.decomposeGoal as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_goalId: string) => {
        const updated = { ...goal, children_ids: [childId] };
        await stateManager.saveGoal(updated as ReturnType<typeof makeGoal>);
        return {
          parent_id: _goalId,
          children: [childGoal],
          depth: 1,
          specificity_scores: {},
          reasoning: "Decomposed",
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

    // tokenBudget=50: root call costs ~83 tokens (10 input + ~73 output)
    // child call sees tokensUsed (~83) >= tokenBudget (50) → force leaf
    const result = await refiner.refine(goalId, { tokenBudget: 50 });

    expect(result.leaf).toBe(false); // root is non-measurable → decomposed
    expect(result.children).toHaveLength(1);
    expect(result.children![0]!.leaf).toBe(true);
    expect(result.children![0]!.reason).toContain("token budget");
  });

  // ── Test 5: already-validated dimensions → skips refinement ──

  it("skips refinement when goal already has validated dimensions", async () => {
    const validatedGoal = makeGoal({
      ...goal,
      user_override: true,
      dimensions: [
        makeDimension({
          name: "coverage",
          observation_method: {
            type: "mechanical",
            source: "shell",
            schedule: null,
            endpoint: "npm test",
            confidence_tier: "mechanical",
          },
        }),
      ],
    });
    const stateManager = makeStateManager({ [goalId]: validatedGoal });
    const llmClient = createMockLLMClient([]); // no LLM calls expected

    const refiner = new GoalRefiner(
      stateManager,
      llmClient,
      makeObservationEngine(),
      makeNegotiator(),
      makeTreeManager(),
      makeEthicsGate()
    );

    const result = await refiner.refine(goalId);

    expect(result.leaf).toBe(true);
    expect(result.reason).toBe("already has validated dimensions");
    expect(llmClient.callCount).toBe(0);
  });

  // ── Test 4: reRefineLeaf includes failure context ──

  it("reRefineLeaf includes failure context in prompt", async () => {
    const llmClient = createMockLLMClient([measurableLeafTestResponse, feasibilityResponse]);
    const stateManager = makeStateManager({ [goalId]: goal });

    let capturedLeafTestPrompt = "";
    let firstCall = true;
    const origSendMessage = llmClient.sendMessage.bind(llmClient);
    llmClient.sendMessage = vi.fn(async (messages, opts) => {
      if (firstCall && messages[0]) {
        capturedLeafTestPrompt = messages[0].content as string;
        firstCall = false;
      }
      return origSendMessage(messages, opts);
    });

    const refiner = new GoalRefiner(
      stateManager,
      llmClient,
      makeObservationEngine(),
      makeNegotiator(),
      makeTreeManager(),
      makeEthicsGate()
    );

    await refiner.reRefineLeaf(goalId, "observation command not found");

    expect(capturedLeafTestPrompt).toContain("observation command not found");
  });
});
