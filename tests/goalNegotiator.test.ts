import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { GoalNegotiator, EthicsRejectedError } from "../src/goal/goal-negotiator.js";
import { StateManager } from "../src/state/state-manager.js";
import type { DimensionDecomposition } from "../src/types/negotiation.js";
import type { Goal } from "../src/types/goal.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";

type EthicsVerdict = {
  verdict: "pass" | "flag" | "reject";
  category: string;
  reasoning: string;
  risks: string[];
  confidence: number;
};

function makeEthicsGate(verdict: EthicsVerdict) {
  return {
    check: async () => verdict,
  };
}

function makeDimension(
  overrides: Partial<DimensionDecomposition> & Pick<DimensionDecomposition, "name" | "label" | "threshold_type">
): DimensionDecomposition {
  return {
    name: overrides.name,
    label: overrides.label,
    threshold_type: overrides.threshold_type,
    threshold_value: overrides.threshold_value ?? null,
    observation_method_hint: overrides.observation_method_hint ?? "Inspect progress",
  };
}

describe("GoalNegotiator lightweight unit coverage", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let observationEngine: ObservationEngine;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    observationEngine = new ObservationEngine(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function negotiateGoal(args: {
    description?: string;
    dimensions: DimensionDecomposition[];
    feasibilityResponses?: string[];
    responseMessage?: string;
    ethicsVerdict?: EthicsVerdict;
    options?: {
      deadline?: string;
      constraints?: string[];
      timeHorizonDays?: number;
      workspaceContext?: string;
    };
  }) {
    const dimensions = args.dimensions;
    const feasibilityResponses =
      args.feasibilityResponses ??
      dimensions.map(() =>
        JSON.stringify({
          assessment: "realistic",
          confidence: "high",
          reasoning: "Achievable within the time horizon.",
          key_assumptions: [],
          main_risks: [],
        })
      );

    const llm = createMockLLMClient([
      JSON.stringify(dimensions),
      ...feasibilityResponses,
      args.responseMessage ?? "Accepted",
    ]);

    const negotiator = new GoalNegotiator(
      stateManager,
      llm,
      makeEthicsGate(
        args.ethicsVerdict ?? {
          verdict: "pass",
          category: "safe",
          reasoning: "Safe goal",
          risks: [],
          confidence: 0.99,
        }
      ) as never,
      observationEngine
    );

    const result = await negotiator.negotiate(
      args.description ?? "Improve repository quality",
      args.options
    );

    return { ...result, llm };
  }

  it("adds a negotiated goal and persists it", async () => {
    const { goal } = await negotiateGoal({
      dimensions: [makeDimension({ name: "test_coverage", label: "Test Coverage", threshold_type: "min", threshold_value: 80 })],
    });

    const saved = await stateManager.loadGoal(goal.id);
    expect(saved?.id).toBe(goal.id);
    expect(saved?.title).toBe("Improve repository quality");
    expect(saved?.dimensions).toHaveLength(1);
  });

  it("makes a saved goal retrievable through the goal id list", async () => {
    const { goal } = await negotiateGoal({
      dimensions: [makeDimension({ name: "quality_score", label: "Quality Score", threshold_type: "min", threshold_value: 90 })],
    });

    expect(await stateManager.listGoalIds()).toContain(goal.id);
  });

  it("stores deadline and constraints from negotiation options", async () => {
    const { goal } = await negotiateGoal({
      dimensions: [makeDimension({ name: "completion_rate", label: "Completion Rate", threshold_type: "min", threshold_value: 100 })],
      options: {
        deadline: "2026-04-01",
        constraints: ["No production downtime", "Stay within budget"],
      },
    });

    const saved = await stateManager.loadGoal(goal.id);
    expect(saved?.deadline).toBe("2026-04-01");
    expect(saved?.constraints).toEqual(["No production downtime", "Stay within budget"]);
  });

  it("builds a numeric min threshold correctly", async () => {
    const { goal } = await negotiateGoal({
      dimensions: [makeDimension({ name: "coverage", label: "Coverage", threshold_type: "min", threshold_value: 85 })],
    });

    expect(goal.dimensions[0]?.threshold).toEqual({ type: "min", value: 85 });
  });

  it("builds a numeric max threshold correctly", async () => {
    const { goal } = await negotiateGoal({
      dimensions: [makeDimension({ name: "defect_count", label: "Defect Count", threshold_type: "max", threshold_value: 5 })],
    });

    expect(goal.dimensions[0]?.threshold).toEqual({ type: "max", value: 5 });
  });

  it("builds a range threshold from a two-value array", async () => {
    const { goal } = await negotiateGoal({
      dimensions: [
        makeDimension({
          name: "response_time",
          label: "Response Time",
          threshold_type: "range",
          threshold_value: [100, 250],
        }),
      ],
    });

    expect(goal.dimensions[0]?.threshold).toEqual({ type: "range", low: 100, high: 250 });
  });

  it("falls back to a zero-based range when the LLM returns a single numeric value", async () => {
    const { goal } = await negotiateGoal({
      dimensions: [
        makeDimension({
          name: "latency_band",
          label: "Latency Band",
          threshold_type: "range",
          threshold_value: 300,
        }),
      ],
    });

    expect(goal.dimensions[0]?.threshold).toEqual({ type: "range", low: 0, high: 300 });
  });

  it("normalizes present thresholds without storing a value payload", async () => {
    const { goal } = await negotiateGoal({
      dimensions: [
        makeDimension({
          name: "ci_enabled",
          label: "CI Enabled",
          threshold_type: "present",
          threshold_value: false,
        }),
      ],
    });

    expect(goal.dimensions[0]?.threshold).toEqual({ type: "present" });
  });

  it("preserves match thresholds for exact-value goals", async () => {
    const { goal } = await negotiateGoal({
      dimensions: [
        makeDimension({
          name: "branch_name",
          label: "Branch Name",
          threshold_type: "match",
          threshold_value: "main",
        }),
      ],
    });

    expect(goal.dimensions[0]?.threshold).toEqual({ type: "match", value: "main" });
  });

  it("deduplicates duplicate dimension names returned by the LLM", async () => {
    const { goal } = await negotiateGoal({
      dimensions: [
        makeDimension({ name: "coverage", label: "Coverage", threshold_type: "min", threshold_value: 80 }),
        makeDimension({ name: "coverage", label: "Coverage Stretch", threshold_type: "min", threshold_value: 90 }),
        makeDimension({ name: "coverage", label: "Coverage Guardrail", threshold_type: "max", threshold_value: 100 }),
      ],
    });

    expect(goal.dimensions.map((dimension) => dimension.name)).toEqual([
      "coverage",
      "coverage_2",
      "coverage_3",
    ]);
  });

  it("includes ethics flags while still accepting flagged goals", async () => {
    const { response } = await negotiateGoal({
      dimensions: [makeDimension({ name: "documentation", label: "Documentation", threshold_type: "min", threshold_value: 1 })],
      ethicsVerdict: {
        verdict: "flag",
        category: "privacy_concern",
        reasoning: "Needs human review",
        risks: ["contains customer data"],
        confidence: 0.7,
      },
      responseMessage: "Proceed carefully",
    });

    expect(response.accepted).toBe(true);
    expect(response.flags).toEqual(["contains customer data"]);
  });

  it("throws on rejected ethics verdicts and does not persist a goal", async () => {
    const llm = createMockLLMClient([
      JSON.stringify([
        makeDimension({ name: "ignored", label: "Ignored", threshold_type: "min", threshold_value: 1 }),
      ]),
    ]);

    const negotiator = new GoalNegotiator(
      stateManager,
      llm,
      makeEthicsGate({
        verdict: "reject",
        category: "illegal",
        reasoning: "Rejected by ethics gate",
        risks: ["illegal activity"],
        confidence: 0.99,
      }) as never,
      observationEngine
    );

    await expect(negotiator.negotiate("Do something disallowed")).rejects.toBeInstanceOf(EthicsRejectedError);
    expect(await stateManager.listGoalIds()).toEqual([]);
  });

  it("renegotiates an existing goal and updates its persisted dimensions", async () => {
    const existingGoal = makeGoal({
      id: "goal-renegotiate",
      dimensions: [
        {
          ...makeGoal().dimensions[0]!,
          name: "coverage",
          label: "Coverage",
          current_value: 60,
        },
      ],
    });
    await stateManager.saveGoal(existingGoal);

    const llm = createMockLLMClient([
      JSON.stringify([
        makeDimension({ name: "coverage", label: "Coverage", threshold_type: "min", threshold_value: 90 }),
      ]),
      JSON.stringify({
        assessment: "realistic",
        confidence: "high",
        reasoning: "The revised target is still achievable.",
        key_assumptions: [],
        main_risks: [],
      }),
      "Updated goal accepted",
    ]);

    const negotiator = new GoalNegotiator(
      stateManager,
      llm,
      makeEthicsGate({
        verdict: "pass",
        category: "safe",
        reasoning: "Safe goal",
        risks: [],
        confidence: 0.99,
      }) as never,
      observationEngine
    );

    const { goal, response } = await negotiator.renegotiate("goal-renegotiate", "user_request", "Raise the target");

    expect(response.accepted).toBe(true);
    expect(goal.dimensions[0]?.threshold).toEqual({ type: "min", value: 90 });
    expect((await stateManager.loadGoal("goal-renegotiate"))?.dimensions[0]?.threshold).toEqual({
      type: "min",
      value: 90,
    });
  });

  it("throws when renegotiating a missing goal", async () => {
    const negotiator = new GoalNegotiator(
      stateManager,
      createMockLLMClient([]),
      makeEthicsGate({
        verdict: "pass",
        category: "safe",
        reasoning: "Safe goal",
        risks: [],
        confidence: 0.99,
      }) as never,
      observationEngine
    );

    await expect(negotiator.renegotiate("missing-goal", "stall")).rejects.toThrow(
      'renegotiate: goal "missing-goal" not found'
    );
  });

  it("returns the persisted negotiation log after negotiation", async () => {
    const { goal, log } = await negotiateGoal({
      dimensions: [makeDimension({ name: "coverage", label: "Coverage", threshold_type: "min", threshold_value: 85 })],
    });

    const negotiator = new GoalNegotiator(
      stateManager,
      createMockLLMClient([]),
      makeEthicsGate({
        verdict: "pass",
        category: "safe",
        reasoning: "Safe goal",
        risks: [],
        confidence: 0.99,
      }) as never,
      observationEngine
    );

    expect(await negotiator.getNegotiationLog(goal.id)).toEqual(log);
  });

  it("returns null for a missing negotiation log", async () => {
    const negotiator = new GoalNegotiator(
      stateManager,
      createMockLLMClient([]),
      makeEthicsGate({
        verdict: "pass",
        category: "safe",
        reasoning: "Safe goal",
        risks: [],
        confidence: 0.99,
      }) as never,
      observationEngine
    );

    expect(await negotiator.getNegotiationLog("missing-goal")).toBeNull();
  });

  it("decomposes a parent goal into persisted subgoals and records rejected ones", async () => {
    const parentGoal = makeGoal({ id: "parent-goal" });
    const llm = createMockLLMClient([
      JSON.stringify([
        {
          title: "Raise test coverage",
          description: "Increase unit test coverage in core modules",
          dimensions: [
            makeDimension({
              name: "coverage",
              label: "Coverage",
              threshold_type: "min",
              threshold_value: 80,
            }),
          ],
        },
        {
          title: "Do unsafe thing",
          description: "Exfiltrate production data",
          dimensions: [
            makeDimension({
              name: "data_export",
              label: "Data Export",
              threshold_type: "present",
              threshold_value: true,
            }),
          ],
        },
      ]),
    ]);
    const ethicsGate = {
      check: vi
        .fn()
        .mockResolvedValueOnce({
          verdict: "pass",
          category: "safe",
          reasoning: "Safe subgoal",
          risks: [],
          confidence: 0.95,
        })
        .mockResolvedValueOnce({
          verdict: "reject",
          category: "privacy",
          reasoning: "Unsafe subgoal",
          risks: ["data exfiltration"],
          confidence: 0.99,
        }),
    };

    const negotiator = new GoalNegotiator(
      stateManager,
      llm,
      ethicsGate as never,
      observationEngine
    );

    const result = await negotiator.decompose(parentGoal.id, parentGoal);

    expect(result.subgoals).toHaveLength(1);
    expect(result.subgoals[0]?.parent_id).toBe(parentGoal.id);
    expect((await stateManager.loadGoal(result.subgoals[0]!.id))?.title).toBe("Raise test coverage");
    expect(result.rejectedSubgoals).toEqual([
      {
        description: "Do unsafe thing",
        reason: "Unsafe subgoal",
      },
    ]);
  });

  it("returns null from decomposeIntoSubgoals when no goal tree manager is configured", async () => {
    const goal = makeGoal({ id: "goal-no-tree" });
    await stateManager.saveGoal(goal);

    const negotiator = new GoalNegotiator(
      stateManager,
      createMockLLMClient([]),
      makeEthicsGate({
        verdict: "pass",
        category: "safe",
        reasoning: "Safe goal",
        risks: [],
        confidence: 0.99,
      }) as never,
      observationEngine
    );

    await expect(negotiator.decomposeIntoSubgoals(goal.id)).resolves.toBeNull();
  });

  it("delegates decomposeIntoSubgoals to the injected goal tree manager", async () => {
    const goal = makeGoal({ id: "goal-tree" });
    await stateManager.saveGoal(goal);

    const decomposeGoal = vi.fn().mockResolvedValue({
      root_goal_id: goal.id,
      created_goal_ids: ["subgoal-1"],
      warnings: [],
    });
    const goalTreeManager = { decomposeGoal };

    const negotiator = new GoalNegotiator(
      stateManager,
      createMockLLMClient([]),
      makeEthicsGate({
        verdict: "pass",
        category: "safe",
        reasoning: "Safe goal",
        risks: [],
        confidence: 0.99,
      }) as never,
      observationEngine,
      undefined,
      undefined,
      goalTreeManager as never
    );

    const config = {
      max_depth: 2,
      min_specificity: 0.5,
      auto_prune_threshold: 0.2,
      parallel_loop_limit: 1,
    };
    const result = await negotiator.decomposeIntoSubgoals(goal.id, config);

    expect(result).toEqual({
      root_goal_id: goal.id,
      created_goal_ids: ["subgoal-1"],
      warnings: [],
    });
    expect(decomposeGoal).toHaveBeenCalledWith(goal.id, config);
  });

  it("delegates goal suggestions through the public suggestGoals wrapper", async () => {
    const llm = {
      sendMessage: vi.fn().mockResolvedValue({
        content: JSON.stringify([
          {
            title: "Improve docs",
            description: "Add setup examples",
            rationale: "Reduce onboarding friction",
            dimensions_hint: ["docs_completeness"],
          },
        ]),
      }),
      parseJSON: vi.fn().mockReturnValue([
        {
          title: "Improve docs",
          description: "Add setup examples",
          rationale: "Reduce onboarding friction",
          dimensions_hint: ["docs_completeness"],
        },
      ]),
    };
    const ethicsGate = {
      check: vi.fn().mockResolvedValue({
        verdict: "pass",
        category: "safe",
        reasoning: "Safe suggestion",
        risks: [],
        confidence: 0.95,
      }),
    };

    const negotiator = new GoalNegotiator(
      stateManager,
      llm as never,
      ethicsGate as never,
      observationEngine
    );

    await expect(
      negotiator.suggestGoals("A TypeScript repository", {
        maxSuggestions: 1,
        existingGoals: [],
      })
    ).resolves.toEqual([
      {
        title: "Improve docs",
        description: "Add setup examples",
        rationale: "Reduce onboarding friction",
        dimensions_hint: ["docs_completeness"],
      },
    ]);
    expect(llm.sendMessage).toHaveBeenCalledTimes(1);
    expect(ethicsGate.check).toHaveBeenCalledTimes(1);
  });
});
