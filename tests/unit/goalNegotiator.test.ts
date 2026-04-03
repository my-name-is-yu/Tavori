import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObservationEngine } from "../../src/observation/observation-engine.js";
import {
  EthicsRejectedError,
  GoalNegotiator,
  gatherNegotiationContext,
} from "../../src/goal/goal-negotiator.js";
import { StateManager } from "../../src/state/state-manager.js";
import { GoalSchema } from "../../src/types/goal.js";
import type { Dimension } from "../../src/types/goal.js";
import { makeTempDir } from "../helpers/temp-dir.js";

function makeDecomposition(name = "test_coverage", thresholdValue: number | boolean = 80) {
  return {
    name,
    label: "Test Coverage",
    threshold_type: typeof thresholdValue === "boolean" ? "present" : "min",
    threshold_value: thresholdValue,
    observation_method_hint: "Run tests",
  };
}

function makeStoredGoal(overrides: Partial<ReturnType<typeof GoalSchema.parse>> = {}) {
  const now = new Date().toISOString();
  return GoalSchema.parse({
    id: "goal-1",
    parent_id: null,
    node_type: "goal",
    title: "Improve quality",
    description: "Improve quality",
    status: "active",
    dimensions: [
      {
        name: "test_coverage",
        label: "Test Coverage",
        current_value: 40,
        threshold: { type: "min", value: 80 },
        confidence: 0.8,
        observation_method: {
          type: "mechanical",
          source: "vitest",
          schedule: null,
          endpoint: null,
          confidence_tier: "mechanical",
        },
        last_updated: now,
        history: [
          {
            value: 10,
            timestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
            confidence: 0.8,
            source_observation_id: "obs-1",
          },
          {
            value: 40,
            timestamp: now,
            confidence: 0.8,
            source_observation_id: "obs-2",
          },
        ],
        weight: 1,
        uncertainty_weight: null,
        state_integrity: "ok",
        dimension_mapping: null,
      },
    ],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: "negotiation",
    pace_snapshot: null,
    deadline: null,
    confidence_flag: "high",
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1,
    decomposition_depth: 0,
    specificity_score: null,
    loop_status: "idle",
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

function makeDimension(history: Dimension["history"]): Dimension {
  const now = new Date().toISOString();
  return {
    name: "velocity",
    label: "Velocity",
    current_value: typeof history[history.length - 1]?.value === "number" ? history[history.length - 1]!.value : null,
    threshold: { type: "min", value: 10 },
    confidence: 0.9,
    observation_method: {
      type: "mechanical",
      source: "test",
      schedule: null,
      endpoint: null,
      confidence_tier: "mechanical",
    },
    last_updated: now,
    history,
    weight: 1,
    uncertainty_weight: null,
    state_integrity: "ok",
  };
}

describe("GoalNegotiator helper coverage", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs.length = 0;
  });

  describe("gatherNegotiationContext", () => {
    it("summarizes workspace files and keyword matches from a repo-like src directory", async () => {
      const tmpDir = makeTempDir();
      tempDirs.push(tmpDir);
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(
        path.join(srcDir, "feature.ts"),
        "export const coverage = 1;\n// TODO improve coverage\n"
      );

      const result = await gatherNegotiationContext("Improve coverage TODO", tmpDir);

      expect(result).toContain("=== Workspace Context ===");
      expect(result).toContain("Project structure: 1 TypeScript files in src/");
      expect(result).toContain("\"coverage\":");
      expect(result).toContain("\"TODO\": 1 occurrences across 1 files");
    });

    it("returns an empty string when no src directory is available", async () => {
      const tmpDir = makeTempDir();
      tempDirs.push(tmpDir);

      await expect(gatherNegotiationContext("Improve docs", tmpDir)).resolves.toBe("");
    });
  });

  describe("EthicsRejectedError", () => {
    it("formats the rejection reason from the verdict", () => {
      const error = new EthicsRejectedError({
        verdict: "reject",
        category: "harmful",
        reasoning: "Unsafe request",
        risks: ["abuse"],
        confidence: 0.9,
      });

      expect(error.name).toBe("EthicsRejectedError");
      expect(error.message).toContain("Unsafe request");
      expect(error.verdict.verdict).toBe("reject");
    });
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup() {
    const tmpDir = makeTempDir();
    tempDirs.push(tmpDir);
    const stateManager = new StateManager(tmpDir);
    const observationEngine = new ObservationEngine(stateManager);
    const llmClient = {
      sendMessage: vi.fn(),
      parseJSON: vi.fn(),
    };
    const ethicsGate = {
      check: vi.fn(),
    };

    return new GoalNegotiator(
      stateManager,
      llmClient as never,
      ethicsGate as never,
      observationEngine
    );
  }

  it("builds a counter-proposal for infeasible results with a positive feasibility ratio", () => {
    const negotiator = setup() as unknown as {
      determineResponseType: (
        feasibilityResults: Array<{
          dimension: string;
          path: "quantitative" | "qualitative";
          feasibility_ratio: number | null;
          assessment: "realistic" | "ambitious" | "infeasible";
          confidence: "high" | "medium" | "low";
          reasoning: string;
          key_assumptions: string[];
          main_risks: string[];
        }>,
        baselineObservations: Array<{
          dimension: string;
          value: number | string | boolean | null;
          confidence: number;
          method: string;
        }>,
        timeHorizonDays: number
      ) => {
        responseType: "accept" | "counter_propose" | "flag_as_ambitious";
        counterProposal?: {
          realistic_target: number;
          reasoning: string;
          alternatives: string[];
        };
        initialConfidence: "high" | "medium" | "low";
      };
    };

    const result = negotiator.determineResponseType(
      [
        {
          dimension: "velocity",
          path: "quantitative",
          feasibility_ratio: 2,
          assessment: "infeasible",
          confidence: "low",
          reasoning: "Needs more time.",
          key_assumptions: [],
          main_risks: [],
        },
      ],
      [
        {
          dimension: "velocity",
          value: 12,
          confidence: 0.8,
          method: "history",
        },
      ],
      30
    );

    expect(result).toEqual({
      responseType: "counter_propose",
      counterProposal: {
        realistic_target: 31.5,
        reasoning: "Needs more time.",
        alternatives: ["Consider reducing scope or extending timeline"],
      },
      initialConfidence: "low",
    });
  });

  it("uses the defensive accept fallback when results contain an unexpected assessment", () => {
    const negotiator = setup() as unknown as {
      determineResponseType: (
        feasibilityResults: Array<{
          dimension: string;
          path: "quantitative" | "qualitative";
          feasibility_ratio: number | null;
          assessment: "realistic" | "ambitious" | "infeasible" | "unknown";
          confidence: "high" | "medium" | "low";
          reasoning: string;
          key_assumptions: string[];
          main_risks: string[];
        }>,
        baselineObservations: Array<{
          dimension: string;
          value: number | string | boolean | null;
          confidence: number;
          method: string;
        }>,
        timeHorizonDays: number
      ) => {
        responseType: "accept" | "counter_propose" | "flag_as_ambitious";
        initialConfidence: "high" | "medium" | "low";
      };
    };

    const result = negotiator.determineResponseType(
      [
        {
          dimension: "velocity",
          path: "qualitative",
          feasibility_ratio: null,
          assessment: "unknown",
          confidence: "medium",
          reasoning: "Unexpected state",
          key_assumptions: [],
          main_risks: [],
        },
      ],
      [],
      14
    );

    expect(result).toEqual({
      responseType: "accept",
      initialConfidence: "medium",
    });
  });

  it("returns null change rate when history timestamps do not move forward", () => {
    const negotiator = setup() as unknown as {
      estimateChangeRate: (dimension: Dimension) => number | null;
    };
    const timestamp = new Date().toISOString();
    const dimension = makeDimension([
      { value: 1, timestamp, confidence: 0.7, source_observation_id: "obs-1" },
      { value: 5, timestamp, confidence: 0.7, source_observation_id: "obs-2" },
    ]);

    expect(negotiator.estimateChangeRate(dimension)).toBeNull();
  });

  it("calculates a realistic target from baseline, rate, and horizon", () => {
    expect(GoalNegotiator.calculateRealisticTarget(10, 2, 5)).toBe(23);
  });

  it("delegates goal suggestions through the suggestGoals wrapper", async () => {
    const tmpDir = makeTempDir();
    tempDirs.push(tmpDir);
    const stateManager = new StateManager(tmpDir);
    const observationEngine = new ObservationEngine(stateManager);
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: JSON.stringify([
          {
            title: "Increase Test Coverage",
            description: "Raise unit coverage to 85%",
            rationale: "Reduce regressions",
            dimensions_hint: ["test_coverage"],
          },
        ]),
      }),
      parseJSON: vi.fn().mockReturnValue([
        {
          title: "Increase Test Coverage",
          description: "Raise unit coverage to 85%",
          rationale: "Reduce regressions",
          dimensions_hint: ["test_coverage"],
        },
      ]),
    };
    const ethicsGate = {
      check: vi.fn().mockResolvedValue({
        verdict: "pass",
        category: "safe",
        reasoning: "Safe",
        risks: [],
        confidence: 0.9,
      }),
    };
    const negotiator = new GoalNegotiator(
      stateManager,
      llmClient as never,
      ethicsGate as never,
      observationEngine
    );

    const result = await negotiator.suggestGoals("A TypeScript project", {
      maxSuggestions: 1,
      existingGoals: [],
    });

    expect(result).toEqual([
      {
        title: "Increase Test Coverage",
        description: "Raise unit coverage to 85%",
        rationale: "Reduce regressions",
        dimensions_hint: ["test_coverage"],
      },
    ]);
    expect(llmClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(ethicsGate.check).toHaveBeenCalledTimes(1);
  });

  it("returns null when no negotiation log exists", async () => {
    const negotiator = setup();

    expect(await negotiator.getNegotiationLog("missing-goal")).toBeNull();
  });

  it("persists and reloads a negotiation log through negotiate", async () => {
    const tmpDir = makeTempDir();
    tempDirs.push(tmpDir);
    const stateManager = new StateManager(tmpDir);
    const observationEngine = new ObservationEngine(stateManager);
    const llmClient = {
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce({
          content: JSON.stringify([makeDecomposition("test_coverage", 80)]),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            assessment: "realistic",
            confidence: "high",
            reasoning: "Feasible",
            key_assumptions: ["steady progress"],
            main_risks: [],
          }),
        })
        .mockResolvedValueOnce({
          content: "Accepted.",
        }),
      parseJSON: vi
        .fn()
        .mockReturnValueOnce([makeDecomposition("test_coverage", 80)])
        .mockReturnValueOnce({
          assessment: "realistic",
          confidence: "high",
          reasoning: "Feasible",
          key_assumptions: ["steady progress"],
          main_risks: [],
        }),
    };
    const ethicsGate = {
      check: vi.fn().mockResolvedValue({
        verdict: "pass",
        category: "safe",
        reasoning: "Safe",
        risks: [],
        confidence: 0.9,
      }),
    };
    const negotiator = new GoalNegotiator(
      stateManager,
      llmClient as never,
      ethicsGate as never,
      observationEngine
    );

    const result = await negotiator.negotiate("Raise unit test coverage");
    const savedGoal = await stateManager.loadGoal(result.goal.id);
    const log = await negotiator.getNegotiationLog(result.goal.id);

    expect(result.response.type).toBe("accept");
    expect(savedGoal?.description).toBe("Raise unit test coverage");
    expect(log?.goal_id).toBe(result.goal.id);
    expect(log?.step2_decomposition?.dimensions[0]?.name).toBe("test_coverage");
    expect(log?.step5_response?.type).toBe("accept");
  });

  it("throws EthicsRejectedError when negotiate is blocked by the ethics gate", async () => {
    const negotiator = setup();
    const ethicsGate = (negotiator as unknown as { ethicsGate: { check: ReturnType<typeof vi.fn> } }).ethicsGate;
    ethicsGate.check.mockResolvedValue({
      verdict: "reject",
      category: "unsafe",
      reasoning: "Not allowed",
      risks: ["harm"],
      confidence: 1,
    });

    await expect(negotiator.negotiate("Do something harmful")).rejects.toMatchObject({
      name: "EthicsRejectedError",
      verdict: expect.objectContaining({ verdict: "reject" }),
    });
  });

  it("adds ethics flags and capability gaps during negotiate without failing the flow", async () => {
    const tmpDir = makeTempDir();
    tempDirs.push(tmpDir);
    const stateManager = new StateManager(tmpDir);
    const observationEngine = new ObservationEngine(stateManager);
    const llmClient = {
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce({
          content: JSON.stringify([makeDecomposition("test_coverage", 80)]),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            assessment: "realistic",
            confidence: "medium",
            reasoning: "Possible",
            key_assumptions: [],
            main_risks: [],
          }),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            gaps: [
              {
                dimension: "test_coverage",
                required_capability: "run_tests",
                reason: "No test runner access",
                acquirable: false,
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          content: "Proceed with caution.",
        }),
      parseJSON: vi
        .fn()
        .mockReturnValueOnce([makeDecomposition("test_coverage", 80)])
        .mockReturnValueOnce({
          assessment: "realistic",
          confidence: "medium",
          reasoning: "Possible",
          key_assumptions: [],
          main_risks: [],
        })
        .mockReturnValueOnce({
          gaps: [
            {
              dimension: "test_coverage",
              required_capability: "run_tests",
              reason: "No test runner access",
              acquirable: false,
            },
          ],
        }),
    };
    const ethicsGate = {
      check: vi.fn().mockResolvedValue({
        verdict: "flag",
        category: "review",
        reasoning: "Needs review",
        risks: ["manual oversight"],
        confidence: 0.8,
      }),
    };
    const negotiator = new GoalNegotiator(
      stateManager,
      llmClient as never,
      ethicsGate as never,
      observationEngine,
      undefined,
      undefined,
      undefined,
      [{ adapterType: "codex", capabilities: ["read_repo"] }]
    );

    const result = await negotiator.negotiate("Raise unit test coverage");

    expect(result.response.type).toBe("counter_propose");
    expect(result.response.flags).toEqual(["manual oversight"]);
    expect(result.log.step4_capability_check?.infeasible_dimensions).toEqual(["test_coverage"]);
    expect(result.log.step4_evaluation?.dimensions[0]?.reasoning).toContain("Capability gap");
  });

  it("returns subgoals and rejected entries through the decompose wrapper", async () => {
    const tmpDir = makeTempDir();
    tempDirs.push(tmpDir);
    const stateManager = new StateManager(tmpDir);
    const observationEngine = new ObservationEngine(stateManager);
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: JSON.stringify([
          {
            title: "Add tests",
            description: "Add missing unit tests",
            dimensions: [makeDecomposition("test_coverage", 80)],
          },
          {
            title: "Abuse system",
            description: "Perform unsafe task",
            dimensions: [makeDecomposition("unsafe_action", true)],
          },
        ]),
      }),
      parseJSON: vi.fn().mockReturnValue([
        {
          title: "Add tests",
          description: "Add missing unit tests",
          dimensions: [makeDecomposition("test_coverage", 80)],
        },
        {
          title: "Abuse system",
          description: "Perform unsafe task",
          dimensions: [makeDecomposition("unsafe_action", true)],
        },
      ]),
    };
    const ethicsGate = {
      check: vi
        .fn()
        .mockResolvedValueOnce({
          verdict: "pass",
          category: "safe",
          reasoning: "Safe",
          risks: [],
          confidence: 1,
        })
        .mockResolvedValueOnce({
          verdict: "reject",
          category: "unsafe",
          reasoning: "Unsafe",
          risks: ["harm"],
          confidence: 1,
        }),
    };
    const negotiator = new GoalNegotiator(
      stateManager,
      llmClient as never,
      ethicsGate as never,
      observationEngine
    );

    const result = await negotiator.decompose("goal-1", makeStoredGoal());

    expect(result.subgoals).toHaveLength(1);
    expect(result.rejectedSubgoals).toEqual([
      { description: "Abuse system", reason: "Unsafe" },
    ]);
    expect(await stateManager.listGoalIds()).toHaveLength(1);
  });

  it("renegotiates an existing goal using quantitative history when available", async () => {
    const tmpDir = makeTempDir();
    tempDirs.push(tmpDir);
    const stateManager = new StateManager(tmpDir);
    const goal = makeStoredGoal();
    await stateManager.saveGoal(goal);
    const observationEngine = new ObservationEngine(stateManager);
    const llmClient = {
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce({
          content: JSON.stringify([makeDecomposition("test_coverage", 50)]),
        })
        .mockResolvedValueOnce({
          content: "Revised plan accepted.",
        }),
      parseJSON: vi.fn().mockReturnValueOnce([makeDecomposition("test_coverage", 50)]),
    };
    const ethicsGate = {
      check: vi.fn().mockResolvedValue({
        verdict: "pass",
        category: "safe",
        reasoning: "Safe",
        risks: [],
        confidence: 0.9,
      }),
    };
    const negotiator = new GoalNegotiator(
      stateManager,
      llmClient as never,
      ethicsGate as never,
      observationEngine
    );

    const result = await negotiator.renegotiate(goal.id, "new_info", "Recent progress increased");

    expect(result.response.type).toBe("accept");
    expect(result.log.step4_evaluation?.path).toBe("hybrid");
    expect(result.log.step4_evaluation?.dimensions[0]).toMatchObject({
      path: "quantitative",
      assessment: "realistic",
    });
    expect((await stateManager.loadGoal(goal.id))?.updated_at).not.toBe(goal.updated_at);
  });

  it("throws when renegotiating a missing goal", async () => {
    const negotiator = setup();

    await expect(negotiator.renegotiate("missing-goal", "stall")).rejects.toThrow(
      'renegotiate: goal "missing-goal" not found'
    );
  });

  it("returns null from decomposeIntoSubgoals when no goal tree manager is provided", async () => {
    const tmpDir = makeTempDir();
    tempDirs.push(tmpDir);
    const stateManager = new StateManager(tmpDir);
    const negotiator = new GoalNegotiator(
      stateManager,
      { sendMessage: vi.fn(), parseJSON: vi.fn() } as never,
      { check: vi.fn() } as never,
      new ObservationEngine(stateManager)
    );

    await expect(negotiator.decomposeIntoSubgoals("goal-1")).resolves.toBeNull();
  });

  it("delegates decomposeIntoSubgoals to the goal tree manager when available", async () => {
    const tmpDir = makeTempDir();
    tempDirs.push(tmpDir);
    const stateManager = new StateManager(tmpDir);
    const goal = makeStoredGoal();
    await stateManager.saveGoal(goal);
    const goalTreeManager = {
      decomposeGoal: vi.fn().mockResolvedValue({
        created: 2,
        pruned: 0,
        max_depth_reached: false,
      }),
    };
    const negotiator = new GoalNegotiator(
      stateManager,
      { sendMessage: vi.fn(), parseJSON: vi.fn() } as never,
      { check: vi.fn() } as never,
      new ObservationEngine(stateManager),
      undefined,
      undefined,
      goalTreeManager as never
    );

    const result = await negotiator.decomposeIntoSubgoals(goal.id, {
      max_depth: 2,
      min_specificity: 0.6,
      auto_prune_threshold: 0.2,
      parallel_loop_limit: 2,
    });

    expect(result).toEqual({
      created: 2,
      pruned: 0,
      max_depth_reached: false,
    });
    expect(goalTreeManager.decomposeGoal).toHaveBeenCalledWith(goal.id, {
      max_depth: 2,
      min_specificity: 0.6,
      auto_prune_threshold: 0.2,
      parallel_loop_limit: 2,
    });
  });

  it("returns parsed qualitative feasibility details when the LLM JSON is valid", async () => {
    const tmpDir = makeTempDir();
    tempDirs.push(tmpDir);
    const stateManager = new StateManager(tmpDir);
    const observationEngine = new ObservationEngine(stateManager);
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: "{\"assessment\":\"realistic\",\"confidence\":\"high\",\"reasoning\":\"On track\",\"key_assumptions\":[\"steady pace\"],\"main_risks\":[\"scope drift\"]}",
      }),
      parseJSON: vi.fn().mockReturnValue({
        assessment: "realistic",
        confidence: "high",
        reasoning: "On track",
        key_assumptions: ["steady pace"],
        main_risks: ["scope drift"],
      }),
    };
    const ethicsGate = {
      check: vi.fn(),
    };
    const negotiator = new GoalNegotiator(
      stateManager,
      llmClient as never,
      ethicsGate as never,
      observationEngine
    ) as unknown as {
      evaluateQualitatively: (
        dimensionName: string,
        goalDescription: string,
        baselineValue: number | string | boolean | null,
        thresholdValue: number | string | boolean | (number | string)[] | null,
        timeHorizonDays: number
      ) => Promise<{
        dimension: string;
        path: "qualitative";
        feasibility_ratio: null;
        assessment: string;
        confidence: string;
        reasoning: string;
        key_assumptions: string[];
        main_risks: string[];
      }>;
    };

    const result = await negotiator.evaluateQualitatively("velocity", "Ship faster", 2, 5, 14);

    expect(result).toEqual({
      dimension: "velocity",
      path: "qualitative",
      feasibility_ratio: null,
      assessment: "realistic",
      confidence: "high",
      reasoning: "On track",
      key_assumptions: ["steady pace"],
      main_risks: ["scope drift"],
    });
  });

  it("falls back to a conservative qualitative assessment when parsing fails", async () => {
    const tmpDir = makeTempDir();
    tempDirs.push(tmpDir);
    const stateManager = new StateManager(tmpDir);
    const observationEngine = new ObservationEngine(stateManager);
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: "not-json",
      }),
      parseJSON: vi.fn().mockImplementation(() => {
        throw new Error("parse failed");
      }),
    };
    const ethicsGate = {
      check: vi.fn(),
    };
    const negotiator = new GoalNegotiator(
      stateManager,
      llmClient as never,
      ethicsGate as never,
      observationEngine
    ) as unknown as {
      evaluateQualitatively: (
        dimensionName: string,
        goalDescription: string,
        baselineValue: number | string | boolean | null,
        thresholdValue: number | string | boolean | (number | string)[] | null,
        timeHorizonDays: number
      ) => Promise<{
        dimension: string;
        path: "qualitative";
        feasibility_ratio: null;
        assessment: string;
        confidence: string;
        reasoning: string;
        key_assumptions: string[];
        main_risks: string[];
      }>;
    };

    const result = await negotiator.evaluateQualitatively("velocity", "Ship faster", 2, 5, 14);

    expect(result).toEqual({
      dimension: "velocity",
      path: "qualitative",
      feasibility_ratio: null,
      assessment: "ambitious",
      confidence: "low",
      reasoning: "Failed to parse feasibility assessment, defaulting to ambitious.",
      key_assumptions: [],
      main_risks: ["Unable to assess feasibility"],
    });
  });
});
