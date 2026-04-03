import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { EthicsGate } from "../src/traits/ethics-gate.js";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { GoalNegotiator, EthicsRejectedError } from "../src/goal/goal-negotiator.js";
import { GoalSchema } from "../src/types/goal.js";
import type { Goal } from "../src/types/goal.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import {
  PASS_VERDICT_SAFE_JSON as PASS_VERDICT,
  REJECT_VERDICT_ILLEGAL_JSON as REJECT_VERDICT,
} from "./helpers/ethics-fixtures.js";

const SINGLE_DIMENSION_RESPONSE = JSON.stringify([
  {
    name: "completion_rate",
    label: "Completion Rate",
    threshold_type: "min",
    threshold_value: 100,
    observation_method_hint: "Check task completion metrics",
  },
]);

const DIMENSIONS_RESPONSE = JSON.stringify([
  {
    name: "test_coverage",
    label: "Test Coverage",
    threshold_type: "min",
    threshold_value: 80,
    observation_method_hint: "Run test suite and check coverage report",
  },
  {
    name: "code_quality",
    label: "Code Quality Score",
    threshold_type: "min",
    threshold_value: 90,
    observation_method_hint: "Run linter and code analysis tools",
  },
]);

const FEASIBILITY_REALISTIC = JSON.stringify({
  assessment: "realistic",
  confidence: "high",
  reasoning: "This target is achievable within the time horizon.",
  key_assumptions: ["Current pace maintained"],
  main_risks: [],
});

const FEASIBILITY_INFEASIBLE = JSON.stringify({
  assessment: "infeasible",
  confidence: "low",
  reasoning: "This target is not achievable in the given timeframe.",
  key_assumptions: ["No acceleration possible"],
  main_risks: ["Target unreachable", "Burnout risk"],
});

const RESPONSE_MESSAGE_ACCEPT = "Your goal has been accepted. Let's get started!";
const RESPONSE_MESSAGE_COUNTER = "This goal is too ambitious. Consider a safer target.";

const SUBGOALS_RESPONSE = JSON.stringify([
  {
    title: "Setup CI Pipeline",
    description: "Configure continuous integration for automated testing",
    dimensions: [
      {
        name: "ci_configured",
        label: "CI Configured",
        threshold_type: "present",
        threshold_value: null,
        observation_method_hint: "Check CI config exists",
      },
    ],
  },
  {
    title: "Write Unit Tests",
    description: "Achieve 80% unit test coverage",
    dimensions: [
      {
        name: "unit_coverage",
        label: "Unit Test Coverage",
        threshold_type: "min",
        threshold_value: 80,
        observation_method_hint: "Run coverage tool",
      },
    ],
  },
]);

function makeTestGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return GoalSchema.parse({
    id: overrides.id ?? "test-goal-id",
    parent_id: null,
    node_type: "goal",
    title: overrides.title ?? "Test Goal",
    description: overrides.description ?? "A test goal for testing",
    status: "active",
    dimensions: overrides.dimensions ?? [
      {
        name: "metric_a",
        label: "Metric A",
        current_value: 50,
        threshold: { type: "min", value: 80 },
        confidence: 0.8,
        observation_method: {
          type: "mechanical",
          source: "test",
          schedule: null,
          endpoint: null,
          confidence_tier: "mechanical",
        },
        last_updated: now,
        history: [
          { value: 30, timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), confidence: 0.8, source_observation_id: "obs-1" },
          { value: 50, timestamp: now, confidence: 0.8, source_observation_id: "obs-2" },
        ],
        weight: 1.0,
        uncertainty_weight: null,
        state_integrity: "ok",
      },
    ],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: ["No weekend work"],
    children_ids: [],
    target_date: null,
    origin: "negotiation",
    pace_snapshot: null,
    deadline: null,
    confidence_flag: "high",
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    created_at: now,
    updated_at: now,
  });
}

describe("GoalNegotiator", () => {
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

  // ─── decompose() ───

  describe("decompose()", () => {
    it("returns subgoals and rejected subgoals", async () => {
      const mockLLM = createMockLLMClient([
        // For negotiate
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
        // For decompose: LLM generates subgoals
        SUBGOALS_RESPONSE,
        // Ethics checks for each subgoal (2 subgoals)
        PASS_VERDICT,
        PASS_VERDICT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const negotiateResult = await negotiator.negotiate("Improve quality");
      const result = await negotiator.decompose(negotiateResult.goal.id, negotiateResult.goal);

      expect(result.subgoals).toHaveLength(2);
      expect(result.rejectedSubgoals).toHaveLength(0);
    });

    it("subgoals have correct parent_id", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
        SUBGOALS_RESPONSE,
        PASS_VERDICT,
        PASS_VERDICT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const negotiateResult = await negotiator.negotiate("Improve quality");
      const result = await negotiator.decompose(negotiateResult.goal.id, negotiateResult.goal);

      for (const subgoal of result.subgoals) {
        expect(subgoal.parent_id).toBe(negotiateResult.goal.id);
      }
    });

    it("subgoals have node_type subgoal", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
        SUBGOALS_RESPONSE,
        PASS_VERDICT,
        PASS_VERDICT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const negotiateResult = await negotiator.negotiate("Improve quality");
      const result = await negotiator.decompose(negotiateResult.goal.id, negotiateResult.goal);

      for (const subgoal of result.subgoals) {
        expect(subgoal.node_type).toBe("subgoal");
      }
    });

    it("subgoals have origin decomposition", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
        SUBGOALS_RESPONSE,
        PASS_VERDICT,
        PASS_VERDICT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const negotiateResult = await negotiator.negotiate("Improve quality");
      const result = await negotiator.decompose(negotiateResult.goal.id, negotiateResult.goal);

      for (const subgoal of result.subgoals) {
        expect(subgoal.origin).toBe("decomposition");
      }
    });

    it("rejected subgoals are collected with reason", async () => {
      const mockLLM = createMockLLMClient([
        // For negotiate
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
        // For decompose
        SUBGOALS_RESPONSE,
        // First subgoal passes
        PASS_VERDICT,
        // Second subgoal rejected
        REJECT_VERDICT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const negotiateResult = await negotiator.negotiate("Improve quality");
      const result = await negotiator.decompose(negotiateResult.goal.id, negotiateResult.goal);

      expect(result.subgoals).toHaveLength(1);
      expect(result.rejectedSubgoals).toHaveLength(1);
      expect(result.rejectedSubgoals[0]!.reason).toBeTruthy();
    });

    it("persists accepted subgoals to state manager", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
        SUBGOALS_RESPONSE,
        PASS_VERDICT,
        PASS_VERDICT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const negotiateResult = await negotiator.negotiate("Improve quality");
      const result = await negotiator.decompose(negotiateResult.goal.id, negotiateResult.goal);

      for (const subgoal of result.subgoals) {
        const loaded = await stateManager.loadGoal(subgoal.id);
        expect(loaded).not.toBeNull();
      }
    });

    it("all subgoals rejected returns empty subgoals array", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
        SUBGOALS_RESPONSE,
        REJECT_VERDICT,
        REJECT_VERDICT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const negotiateResult = await negotiator.negotiate("Improve quality");
      const result = await negotiator.decompose(negotiateResult.goal.id, negotiateResult.goal);

      expect(result.subgoals).toHaveLength(0);
      expect(result.rejectedSubgoals).toHaveLength(2);
    });
  });

  describe("decomposeIntoSubgoals()", () => {
    it("returns null when GoalTreeManager is not provided", async () => {
      const mockLLM = createMockLLMClient([]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      await expect(negotiator.decomposeIntoSubgoals("missing-goal")).resolves.toBeNull();
    });

    it("returns null when the goal does not exist", async () => {
      const mockLLM = createMockLLMClient([]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const goalTreeManager = {
        decomposeGoal: vi.fn(),
      };
      const negotiator = new GoalNegotiator(
        stateManager,
        mockLLM,
        ethicsGate,
        observationEngine,
        undefined,
        undefined,
        goalTreeManager as never,
      );

      await expect(negotiator.decomposeIntoSubgoals("missing-goal")).resolves.toBeNull();
      expect(goalTreeManager.decomposeGoal).not.toHaveBeenCalled();
    });

    it("uses default decomposition config when none is provided", async () => {
      const parentGoal = makeTestGoal({ id: "goal-for-default-decompose" });
      await stateManager.saveGoal(parentGoal);

      const mockLLM = createMockLLMClient([]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const decomposeGoal = vi.fn().mockResolvedValue({
        created: [],
        reused: [],
        pruned: [],
        depth_reached: 0,
      });
      const negotiator = new GoalNegotiator(
        stateManager,
        mockLLM,
        ethicsGate,
        observationEngine,
        undefined,
        undefined,
        { decomposeGoal } as never,
      );

      await negotiator.decomposeIntoSubgoals(parentGoal.id);

      expect(decomposeGoal).toHaveBeenCalledWith(parentGoal.id, {
        max_depth: 5,
        min_specificity: 0.7,
        auto_prune_threshold: 0.3,
        parallel_loop_limit: 3,
      });
    });

    it("passes through an explicit decomposition config", async () => {
      const parentGoal = makeTestGoal({ id: "goal-for-custom-decompose" });
      await stateManager.saveGoal(parentGoal);

      const mockLLM = createMockLLMClient([]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const decomposeGoal = vi.fn().mockResolvedValue({
        created: [],
        reused: [],
        pruned: [],
        depth_reached: 1,
      });
      const negotiator = new GoalNegotiator(
        stateManager,
        mockLLM,
        ethicsGate,
        observationEngine,
        undefined,
        undefined,
        { decomposeGoal } as never,
      );
      const config = {
        max_depth: 2,
        min_specificity: 0.9,
        auto_prune_threshold: 0.2,
        parallel_loop_limit: 1,
      };

      await negotiator.decomposeIntoSubgoals(parentGoal.id, config);

      expect(decomposeGoal).toHaveBeenCalledWith(parentGoal.id, config);
    });
  });

  describe("suggestGoals()", () => {
    it("returns an empty array for blank context", async () => {
      const mockLLM = createMockLLMClient([]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      await expect(negotiator.suggestGoals("   ")).resolves.toEqual([]);
    });

    it("returns parsed suggestions without persisting any goal", async () => {
      const suggestionsResponse = JSON.stringify([
        {
          title: "Increase Test Coverage",
          description: "Raise unit test coverage to 80 percent",
          rationale: "Coverage is below the team standard",
          dimensions_hint: ["test_coverage", "failing_tests"],
        },
      ]);
      const mockLLM = createMockLLMClient([
        suggestionsResponse,
        PASS_VERDICT,
      ]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const suggestions = await negotiator.suggestGoals("The test suite lacks coverage", {
        maxSuggestions: 1,
      });

      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.title).toBe("Increase Test Coverage");
      expect(await stateManager.listGoalIds()).toEqual([]);
    });
  });

  // ─── renegotiate() ───

  describe("renegotiate()", () => {
    it("throws when goal does not exist", async () => {
      const mockLLM = createMockLLMClient([]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      await expect(
        negotiator.renegotiate("nonexistent", "user_request")
      ).rejects.toThrow('goal "nonexistent" not found');
    });

    it("performs renegotiation on existing goal", async () => {
      const mockLLM = createMockLLMClient([
        // Initial negotiate
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
        // Renegotiate
        PASS_VERDICT,            // ethics re-check
        SINGLE_DIMENSION_RESPONSE, // re-decompose
        FEASIBILITY_REALISTIC,   // feasibility
        RESPONSE_MESSAGE_ACCEPT, // response
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const initial = await negotiator.negotiate("Test goal");
      const result = await negotiator.renegotiate(initial.goal.id, "user_request", "Need adjustments");

      expect(result.goal).toBeDefined();
      expect(result.response).toBeDefined();
      expect(result.log).toBeDefined();
    });

    it("marks log as renegotiation", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const initial = await negotiator.negotiate("Test goal");
      const result = await negotiator.renegotiate(initial.goal.id, "stall");

      expect(result.log.is_renegotiation).toBe(true);
      expect(result.log.renegotiation_trigger).toBe("stall");
    });

    it("records stall trigger correctly", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const initial = await negotiator.negotiate("Test goal");
      const result = await negotiator.renegotiate(initial.goal.id, "stall");
      expect(result.log.renegotiation_trigger).toBe("stall");
    });

    it("records new_info trigger correctly", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const initial = await negotiator.negotiate("Test goal");
      const result = await negotiator.renegotiate(initial.goal.id, "new_info", "New data arrived");
      expect(result.log.renegotiation_trigger).toBe("new_info");
    });

    it("records user_request trigger correctly", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const initial = await negotiator.negotiate("Test goal");
      const result = await negotiator.renegotiate(initial.goal.id, "user_request");
      expect(result.log.renegotiation_trigger).toBe("user_request");
    });

    it("throws EthicsRejectedError if re-check rejects", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
        // renegotiate ethics check rejects
        REJECT_VERDICT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const initial = await negotiator.negotiate("Test goal");
      await expect(
        negotiator.renegotiate(initial.goal.id, "user_request")
      ).rejects.toThrow(EthicsRejectedError);
    });

    it("updates the persisted negotiation log", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const initial = await negotiator.negotiate("Test goal");
      await negotiator.renegotiate(initial.goal.id, "stall");

      const log = await negotiator.getNegotiationLog(initial.goal.id);
      expect(log).not.toBeNull();
      expect(log!.is_renegotiation).toBe(true);
    });

    it("updates goal in state manager", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const initial = await negotiator.negotiate("Test goal");
      const renegResult = await negotiator.renegotiate(initial.goal.id, "user_request");

      const loaded = await stateManager.loadGoal(initial.goal.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.updated_at).toBe(renegResult.goal.updated_at);
    });
  });

  // ─── Negotiation log structure validation ───

  describe("negotiation log structure", () => {
    it("log has goal_id matching the goal", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.log.goal_id).toBe(result.goal.id);
    });

    it("log has valid timestamp", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(() => new Date(result.log.timestamp)).not.toThrow();
    });

    it("log renegotiation_trigger is null for initial negotiation", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.log.renegotiation_trigger).toBeNull();
    });

    it("counter_propose log includes counter_proposal details", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_INFEASIBLE,
        RESPONSE_MESSAGE_COUNTER,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Unrealistic goal");
      expect(result.log.step5_response!.counter_proposal).not.toBeNull();
      expect(typeof result.log.step5_response!.counter_proposal!.realistic_target).toBe("number");
    });
  });

  // ─── Goal dimension thresholds ───

  describe("goal dimension construction", () => {
    it("min threshold creates correct structure", async () => {
      const minDimension = JSON.stringify([
        {
          name: "score",
          label: "Score",
          threshold_type: "min",
          threshold_value: 75,
          observation_method_hint: "Check score",
        },
      ]);

      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        minDimension,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.goal.dimensions[0]!.threshold).toEqual({ type: "min", value: 75 });
    });

    it("present threshold creates correct structure", async () => {
      const presentDimension = JSON.stringify([
        {
          name: "feature_exists",
          label: "Feature Exists",
          threshold_type: "present",
          threshold_value: null,
          observation_method_hint: "Check if feature exists",
        },
      ]);

      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        presentDimension,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.goal.dimensions[0]!.threshold).toEqual({ type: "present" });
    });

    it("match threshold creates correct structure", async () => {
      const matchDimension = JSON.stringify([
        {
          name: "status",
          label: "Status",
          threshold_type: "match",
          threshold_value: "deployed",
          observation_method_hint: "Check deployment status",
        },
      ]);

      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        matchDimension,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.goal.dimensions[0]!.threshold).toEqual({ type: "match", value: "deployed" });
    });

    it("range threshold with array threshold_value creates correct structure", async () => {
      const rangeDimension = JSON.stringify([
        {
          name: "response_time",
          label: "Response Time",
          threshold_type: "range",
          threshold_value: [60, 80],
          observation_method_hint: "Measure response time in ms",
        },
      ]);

      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        rangeDimension,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.goal.dimensions[0]!.threshold).toEqual({ type: "range", low: 60, high: 80 });
    });

    it("dimensions have initial null current_value", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.goal.dimensions[0]!.current_value).toBeNull();
    });

    it("dimensions have initial 0 confidence", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.goal.dimensions[0]!.confidence).toBe(0);
    });
  });

  // ─── Feasibility with quantitative path (renegotiation with history) ───

  describe("renegotiate() with quantitative feasibility path", () => {
    it("uses quantitative path when history data is available", async () => {
      // First, create a goal with history data
      const goalWithHistory = makeTestGoal();
      await stateManager.saveGoal(goalWithHistory);

      // Dimension response that matches existing dimension name
      const matchingDimension = JSON.stringify([
        {
          name: "metric_a",
          label: "Metric A",
          threshold_type: "min",
          threshold_value: 80,
          observation_method_hint: "Measure metric A",
        },
      ]);

      const mockLLM = createMockLLMClient([
        PASS_VERDICT,            // ethics re-check
        matchingDimension,       // re-decompose
        // No qualitative feasibility call needed - quantitative path
        RESPONSE_MESSAGE_ACCEPT, // response
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.renegotiate(goalWithHistory.id, "new_info");

      expect(result.log.step4_evaluation).not.toBeNull();
      // Should have used quantitative path since we have history
      const dimEval = result.log.step4_evaluation!.dimensions[0]!;
      expect(dimEval.path).toBe("quantitative");
      expect(dimEval.feasibility_ratio).not.toBeNull();
    });
  });

  // ─── Multiple dimensions mixed feasibility ───

  describe("negotiate() with mixed feasibility", () => {
    it("counter_propose when any dimension is infeasible", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        DIMENSIONS_RESPONSE,      // 2 dimensions
        FEASIBILITY_REALISTIC,     // dim 1 realistic
        FEASIBILITY_INFEASIBLE,    // dim 2 infeasible
        RESPONSE_MESSAGE_COUNTER,  // counter proposal
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Mixed feasibility goal");
      expect(result.response.type).toBe("counter_propose");
    });

    it("accept when all dimensions are realistic", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        DIMENSIONS_RESPONSE,
        FEASIBILITY_REALISTIC,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Realistic goal");
      expect(result.response.type).toBe("accept");
    });
  });

  // ─── Confidence flag on goal ───

  describe("goal confidence_flag", () => {
    it("sets high confidence when all feasibility is high", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.goal.confidence_flag).toBe("high");
    });

    it("sets low confidence on infeasible dimensions", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_INFEASIBLE,
        RESPONSE_MESSAGE_COUNTER,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Infeasible goal");
      expect(result.goal.confidence_flag).toBe("low");
    });
  });

  // ─── buildDecompositionPrompt — DataSource dimension placement ───

  describe("buildDecompositionPrompt DataSource placement", () => {
    it("DataSource dimensions appear before the example JSON when DataSources are available", async () => {
      // We capture the prompt by inspecting what the LLM client receives.
      let capturedPrompt = "";
      let callCount = 0;
      const capturingLLM = {
        async sendMessage(messages: Array<{ role: string; content: string }>, _options?: unknown): Promise<{ content: string; usage: { input_tokens: number; output_tokens: number }; stop_reason: string }> {
          callCount++;
          if (callCount === 2) {
            // The decomposition call is the 2nd LLM call (after ethics check)
            capturedPrompt = messages[0]?.content ?? "";
          }
          // Return canned responses in order
          const responses: Record<number, string> = {
            1: PASS_VERDICT,
            2: SINGLE_DIMENSION_RESPONSE,
            3: FEASIBILITY_REALISTIC,
            4: RESPONSE_MESSAGE_ACCEPT,
          };
          const content = responses[callCount] ?? RESPONSE_MESSAGE_ACCEPT;
          return { content, usage: { input_tokens: 10, output_tokens: content.length }, stop_reason: "end_turn" };
        },
        parseJSON<T>(content: string, schema: { parse: (v: unknown) => T }): T {
          return schema.parse(JSON.parse(content.trim()));
        },
      };

      // Register a DataSource with known dimension names on the ObservationEngine
      // We do this by calling registerDataSource directly via stateManager
      // The simplest approach: use a mock ObservationEngine that returns a known dimension list
      const mockObsEngine = {
        getAvailableDimensionInfo(): Array<{ name: string; dimensions: string[] }> {
          return [{ name: "github_issues", dimensions: ["open_issue_count", "closed_issue_count", "completion_ratio"] }];
        },
      } as unknown as ObservationEngine;

      const ethicsGate = new EthicsGate(stateManager, capturingLLM as never);
      const negotiator = new GoalNegotiator(stateManager, capturingLLM as never, ethicsGate, mockObsEngine);

      await negotiator.negotiate("Improve project completion");

      // The DataSource section should appear BEFORE the example JSON
      const dsIndex = capturedPrompt.indexOf("DataSources");
      const exampleIndex = capturedPrompt.indexOf("Example:");
      expect(dsIndex).toBeGreaterThanOrEqual(0);
      expect(exampleIndex).toBeGreaterThan(dsIndex);
    });

    it("DataSource CRITICAL CONSTRAINT text appears in prompt when DataSources are available", async () => {
      let capturedPrompt = "";
      let callCount = 0;
      const capturingLLM = {
        async sendMessage(messages: Array<{ role: string; content: string }>, _options?: unknown): Promise<{ content: string; usage: { input_tokens: number; output_tokens: number }; stop_reason: string }> {
          callCount++;
          if (callCount === 2) {
            capturedPrompt = messages[0]?.content ?? "";
          }
          const responses: Record<number, string> = {
            1: PASS_VERDICT,
            2: SINGLE_DIMENSION_RESPONSE,
            3: FEASIBILITY_REALISTIC,
            4: RESPONSE_MESSAGE_ACCEPT,
          };
          const content = responses[callCount] ?? RESPONSE_MESSAGE_ACCEPT;
          return { content, usage: { input_tokens: 10, output_tokens: content.length }, stop_reason: "end_turn" };
        },
        parseJSON<T>(content: string, schema: { parse: (v: unknown) => T }): T {
          return schema.parse(JSON.parse(content.trim()));
        },
      };

      const mockObsEngine = {
        getAvailableDimensionInfo(): Array<{ name: string; dimensions: string[] }> {
          return [{ name: "sensor_feed", dimensions: ["temperature_celsius", "humidity_percent"] }];
        },
      } as unknown as ObservationEngine;

      const ethicsGate = new EthicsGate(stateManager, capturingLLM as never);
      const negotiator = new GoalNegotiator(stateManager, capturingLLM as never, ethicsGate, mockObsEngine);

      await negotiator.negotiate("Maintain comfortable environment");

      expect(capturedPrompt).toContain("DataSources");
      expect(capturedPrompt).toContain("use exact dimension names");
      expect(capturedPrompt).toContain("temperature_celsius");
      expect(capturedPrompt).toContain("humidity_percent");
    });

    it("no DataSource section in prompt when no DataSources are registered", async () => {
      let capturedPrompt = "";
      let callCount = 0;
      const capturingLLM = {
        async sendMessage(messages: Array<{ role: string; content: string }>, _options?: unknown): Promise<{ content: string; usage: { input_tokens: number; output_tokens: number }; stop_reason: string }> {
          callCount++;
          if (callCount === 2) {
            capturedPrompt = messages[0]?.content ?? "";
          }
          const responses: Record<number, string> = {
            1: PASS_VERDICT,
            2: SINGLE_DIMENSION_RESPONSE,
            3: FEASIBILITY_REALISTIC,
            4: RESPONSE_MESSAGE_ACCEPT,
          };
          const content = responses[callCount] ?? RESPONSE_MESSAGE_ACCEPT;
          return { content, usage: { input_tokens: 10, output_tokens: content.length }, stop_reason: "end_turn" };
        },
        parseJSON<T>(content: string, schema: { parse: (v: unknown) => T }): T {
          return schema.parse(JSON.parse(content.trim()));
        },
      };

      // observationEngine has no registered DataSources — getAvailableDimensionInfo() returns []
      const ethicsGate = new EthicsGate(stateManager, capturingLLM as never);
      const negotiator = new GoalNegotiator(stateManager, capturingLLM as never, ethicsGate, observationEngine);

      await negotiator.negotiate("Simple goal with no data sources");

      expect(capturedPrompt).not.toContain("CRITICAL CONSTRAINT");
    });
  });
});
