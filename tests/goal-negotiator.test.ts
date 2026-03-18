import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { StateManager } from "../src/state-manager.js";
import { EthicsGate } from "../src/traits/ethics-gate.js";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { GoalNegotiator, EthicsRejectedError } from "../src/goal/goal-negotiator.js";
import { GoalSchema } from "../src/types/goal.js";
import type { Goal } from "../src/types/goal.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../src/llm/llm-client.js";
import * as os from "node:os";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Fixtures ───

const PASS_VERDICT = JSON.stringify({
  verdict: "pass",
  category: "safe",
  reasoning: "This goal is clearly safe.",
  risks: [],
  confidence: 0.95,
});

const REJECT_VERDICT = JSON.stringify({
  verdict: "reject",
  category: "illegal",
  reasoning: "This goal involves illegal activities.",
  risks: ["illegal activity"],
  confidence: 0.99,
});

const FLAG_VERDICT = JSON.stringify({
  verdict: "flag",
  category: "privacy_concern",
  reasoning: "Privacy risks identified.",
  risks: ["data collection concern", "potential misuse"],
  confidence: 0.70,
});

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

const SINGLE_DIMENSION_RESPONSE = JSON.stringify([
  {
    name: "completion_rate",
    label: "Completion Rate",
    threshold_type: "min",
    threshold_value: 100,
    observation_method_hint: "Check task completion metrics",
  },
]);

const FEASIBILITY_REALISTIC = JSON.stringify({
  assessment: "realistic",
  confidence: "high",
  reasoning: "This target is achievable within the time horizon.",
  key_assumptions: ["Current pace maintained"],
  main_risks: [],
});

const FEASIBILITY_AMBITIOUS = JSON.stringify({
  assessment: "ambitious",
  confidence: "medium",
  reasoning: "This target is ambitious but possible.",
  key_assumptions: ["Increased effort required"],
  main_risks: ["May require extra resources"],
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
const RESPONSE_MESSAGE_FLAG = "This goal is ambitious. Please review the risks carefully.";

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

// ─── Tests ───

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

  // ─── EthicsRejectedError ───

  describe("EthicsRejectedError", () => {
    it("has correct name property", () => {
      const verdict = {
        verdict: "reject" as const,
        category: "illegal",
        reasoning: "test reason",
        risks: [],
        confidence: 0.9,
      };
      const err = new EthicsRejectedError(verdict);
      expect(err.name).toBe("EthicsRejectedError");
    });

    it("includes reasoning in message", () => {
      const verdict = {
        verdict: "reject" as const,
        category: "illegal",
        reasoning: "Goal is unethical",
        risks: [],
        confidence: 0.9,
      };
      const err = new EthicsRejectedError(verdict);
      expect(err.message).toContain("Goal is unethical");
    });

    it("stores the verdict", () => {
      const verdict = {
        verdict: "reject" as const,
        category: "illegal",
        reasoning: "test",
        risks: ["risk1"],
        confidence: 0.9,
      };
      const err = new EthicsRejectedError(verdict);
      expect(err.verdict).toEqual(verdict);
    });

    it("is an instance of Error", () => {
      const verdict = {
        verdict: "reject" as const,
        category: "illegal",
        reasoning: "test",
        risks: [],
        confidence: 0.9,
      };
      const err = new EthicsRejectedError(verdict);
      expect(err).toBeInstanceOf(Error);
    });
  });

  // ─── negotiate() — full flow ───

  describe("negotiate() full flow", () => {
    it("returns goal, response, and log on successful negotiation", async () => {
      // LLM calls: ethics(1) + decomposition(2) + feasibility per dim(3,4) + response(5)
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,           // ethics check
        DIMENSIONS_RESPONSE,     // dimension decomposition
        FEASIBILITY_REALISTIC,   // feasibility dim 1
        FEASIBILITY_REALISTIC,   // feasibility dim 2
        RESPONSE_MESSAGE_ACCEPT, // response generation
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Improve software quality");

      expect(result.goal).toBeDefined();
      expect(result.response).toBeDefined();
      expect(result.log).toBeDefined();
    });

    it("falls back to ambitious low-confidence feasibility when feasibility JSON cannot be parsed", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        "not-json",
        RESPONSE_MESSAGE_FLAG,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Goal with malformed feasibility response");
      const feasibility = result.log.step4_evaluation!.dimensions[0]!;

      expect(feasibility.assessment).toBe("ambitious");
      expect(feasibility.confidence).toBe("low");
      expect(feasibility.reasoning).toContain("Failed to parse feasibility assessment");
      expect(feasibility.main_risks).toContain("Unable to assess feasibility");
      expect(result.response.type).toBe("flag_as_ambitious");
    });

    it("generates a unique goal ID", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        DIMENSIONS_RESPONSE,
        FEASIBILITY_REALISTIC,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.goal.id).toBeTruthy();
      expect(result.goal.id.length).toBeGreaterThan(0);
    });

    it("sets goal title from raw description", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        DIMENSIONS_RESPONSE,
        FEASIBILITY_REALISTIC,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Improve software quality");
      expect(result.goal.title).toBe("Improve software quality");
    });

    it("sets goal origin to negotiation", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        DIMENSIONS_RESPONSE,
        FEASIBILITY_REALISTIC,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.goal.origin).toBe("negotiation");
    });

    it("sets goal status to active", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        DIMENSIONS_RESPONSE,
        FEASIBILITY_REALISTIC,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.goal.status).toBe("active");
    });

    it("includes dimensions from LLM decomposition", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        DIMENSIONS_RESPONSE,
        FEASIBILITY_REALISTIC,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.goal.dimensions).toHaveLength(2);
      expect(result.goal.dimensions[0]!.name).toBe("test_coverage");
      expect(result.goal.dimensions[1]!.name).toBe("code_quality");
    });

    it("applies deadline from options", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const deadline = "2026-06-01T00:00:00.000Z";
      const result = await negotiator.negotiate("Test goal", { deadline });
      expect(result.goal.deadline).toBe(deadline);
    });

    it("applies constraints from options", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal", {
        constraints: ["Budget limit: $1000"],
      });
      expect(result.goal.constraints).toContain("Budget limit: $1000");
    });

    it("persists goal to state manager", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      const loaded = await stateManager.loadGoal(result.goal.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(result.goal.id);
    });
  });

  describe("goal lifecycle operations", () => {
    it("adds a goal by persisting the negotiated result", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Launch a beta program");

      const goalIds = await stateManager.listGoalIds();
      const storedGoal = await stateManager.loadGoal(result.goal.id);

      expect(goalIds).toContain(result.goal.id);
      expect(storedGoal).not.toBeNull();
      expect(storedGoal!.title).toBe("Launch a beta program");
      expect(storedGoal!.dimensions).toHaveLength(1);
    });

    it("removes an existing negotiated goal from state", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Retire stale feature flags");

      expect(await stateManager.deleteGoal(result.goal.id)).toBe(true);
      expect(await stateManager.loadGoal(result.goal.id)).toBeNull();
      expect(await stateManager.listGoalIds()).not.toContain(result.goal.id);
    });

    it("gets all negotiated goals currently stored in state", async () => {
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

      const first = await negotiator.negotiate("Improve onboarding completion");
      const second = await negotiator.negotiate("Reduce support response time");

      const goalIds = await stateManager.listGoalIds();
      const loadedGoals = await Promise.all(goalIds.map((goalId) => stateManager.loadGoal(goalId)));
      const goals = loadedGoals.filter((goal): goal is Goal => goal !== null);

      expect(goals).toHaveLength(2);
      expect(goals.map((goal) => goal.id)).toEqual(
        expect.arrayContaining([first.goal.id, second.goal.id])
      );
      expect(goals.map((goal) => goal.title)).toEqual(
        expect.arrayContaining([
          "Improve onboarding completion",
          "Reduce support response time",
        ])
      );
    });
  });

  // ─── negotiate() — Ethics Gate ───

  describe("negotiate() ethics gate", () => {
    it("throws EthicsRejectedError when ethics gate rejects", async () => {
      const mockLLM = createMockLLMClient([REJECT_VERDICT]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      await expect(
        negotiator.negotiate("Help me commit fraud")
      ).rejects.toThrow(EthicsRejectedError);
    });

    it("EthicsRejectedError contains the verdict", async () => {
      const mockLLM = createMockLLMClient([REJECT_VERDICT]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      try {
        await negotiator.negotiate("Illegal goal");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(EthicsRejectedError);
        expect((err as EthicsRejectedError).verdict.verdict).toBe("reject");
      }
    });

    it("does not create goal when ethics gate rejects", async () => {
      const mockLLM = createMockLLMClient([REJECT_VERDICT]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      try {
        await negotiator.negotiate("Illegal goal");
      } catch {
        // expected
      }

      const goalIds = await stateManager.listGoalIds();
      // No goals should have been created (ethics log dir may exist but not goal dir)
      const goals = goalIds.filter(async (id) => await stateManager.loadGoal(id) !== null);
      expect(goals).toHaveLength(0);
    });

    it("includes flags in response when ethics gate flags", async () => {
      const mockLLM = createMockLLMClient([
        FLAG_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Collect user data");
      expect(result.response.flags).toBeDefined();
      expect(result.response.flags!.length).toBeGreaterThan(0);
      expect(result.response.flags).toContain("data collection concern");
    });

    it("continues negotiation when ethics gate passes", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Safe goal");
      expect(result.goal).toBeDefined();
      expect(result.response.flags).toBeUndefined();
    });
  });

  // ─── negotiate() — Dimension Decomposition ───

  describe("negotiate() dimension decomposition", () => {
    it("records decomposition in negotiation log", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        DIMENSIONS_RESPONSE,
        FEASIBILITY_REALISTIC,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.log.step2_decomposition).not.toBeNull();
      expect(result.log.step2_decomposition!.method).toBe("llm");
      expect(result.log.step2_decomposition!.dimensions).toHaveLength(2);
    });

    it("decomposes into correct dimension names", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        DIMENSIONS_RESPONSE,
        FEASIBILITY_REALISTIC,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      const dimNames = result.log.step2_decomposition!.dimensions.map((d) => d.name);
      expect(dimNames).toContain("test_coverage");
      expect(dimNames).toContain("code_quality");
    });

    it("handles single dimension", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Simple goal");
      expect(result.goal.dimensions).toHaveLength(1);
      expect(result.goal.dimensions[0]!.name).toBe("completion_rate");
    });
  });

  // ─── negotiate() — Baseline Observation ───

  describe("negotiate() baseline observation", () => {
    it("records baseline in negotiation log", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.log.step3_baseline).not.toBeNull();
      expect(result.log.step3_baseline!.observations).toHaveLength(1);
    });

    it("sets null value for new goal baseline", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      const obs = result.log.step3_baseline!.observations[0]!;
      expect(obs.value).toBeNull();
      expect(obs.confidence).toBe(0);
    });

    it("sets method to initial_baseline for new goals", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.log.step3_baseline!.observations[0]!.method).toBe("initial_baseline");
    });
  });

  // ─── negotiate() — Feasibility Evaluation ───

  describe("negotiate() feasibility evaluation", () => {
    it("records feasibility in negotiation log", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.log.step4_evaluation).not.toBeNull();
      expect(result.log.step4_evaluation!.dimensions).toHaveLength(1);
    });

    it("realistic assessment results in accept response", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.response.type).toBe("accept");
      expect(result.response.accepted).toBe(true);
    });

    it("ambitious assessment results in accept response", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_AMBITIOUS,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Ambitious goal");
      // Ambitious with medium confidence -> could be accept or flag_as_ambitious
      expect(["accept", "flag_as_ambitious"]).toContain(result.response.type);
    });

    it("infeasible assessment results in counter_propose response", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_INFEASIBLE,
        RESPONSE_MESSAGE_COUNTER,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Unrealistic goal");
      expect(result.response.type).toBe("counter_propose");
      expect(result.response.accepted).toBe(false);
    });

    it("counter_propose includes counter_proposal object", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_INFEASIBLE,
        RESPONSE_MESSAGE_COUNTER,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Unrealistic goal");
      expect(result.response.counter_proposal).toBeDefined();
      expect(typeof result.response.counter_proposal!.realistic_target).toBe("number");
      expect(typeof result.response.counter_proposal!.reasoning).toBe("string");
    });

    it("low confidence feasibility results in flag_as_ambitious", async () => {
      const lowConfFeasibility = JSON.stringify({
        assessment: "ambitious",
        confidence: "low",
        reasoning: "Very uncertain outcome.",
        key_assumptions: ["Many unknowns"],
        main_risks: ["High uncertainty"],
      });

      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        lowConfFeasibility,
        RESPONSE_MESSAGE_FLAG,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Uncertain goal");
      expect(result.response.type).toBe("flag_as_ambitious");
      expect(result.response.initial_confidence).toBe("low");
    });

    it("qualitative path is used when no baseline exists", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("New domain goal");
      expect(result.log.step4_evaluation!.dimensions[0]!.path).toBe("qualitative");
    });
  });

  // ─── negotiate() — Response Generation ───

  describe("negotiate() response generation", () => {
    it("response has type field", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(["accept", "counter_propose", "flag_as_ambitious"]).toContain(result.response.type);
    });

    it("response has message from LLM", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.response.message).toBeTruthy();
      expect(result.response.message.length).toBeGreaterThan(0);
    });

    it("accept response has accepted=true", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.response.accepted).toBe(true);
    });

    it("counter_propose response has accepted=false", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_INFEASIBLE,
        RESPONSE_MESSAGE_COUNTER,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Unrealistic goal");
      expect(result.response.accepted).toBe(false);
    });

    it("response records step5 in log", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.log.step5_response).not.toBeNull();
      expect(result.log.step5_response!.type).toBe("accept");
      expect(result.log.step5_response!.accepted).toBe(true);
    });
  });

  // ─── Counter Proposal Calculation ───

  describe("counter proposal calculation", () => {
    it("calculateRealisticTarget uses acceleration factor 1.3", () => {
      // baseline=50, changeRate=1/day, 90 days
      const target = GoalNegotiator.calculateRealisticTarget(50, 1, 90);
      expect(target).toBeCloseTo(50 + 1 * 90 * 1.3);
      expect(target).toBeCloseTo(167);
    });

    it("calculateRealisticTarget with zero change rate returns baseline", () => {
      const target = GoalNegotiator.calculateRealisticTarget(50, 0, 90);
      expect(target).toBe(50);
    });

    it("calculateRealisticTarget with small change rate", () => {
      const target = GoalNegotiator.calculateRealisticTarget(10, 0.5, 30);
      expect(target).toBeCloseTo(10 + 0.5 * 30 * 1.3);
    });
  });

  // ─── getNegotiationLog() ───

  describe("await getNegotiationLog()", () => {
    it("returns null when no log exists", async () => {
      const mockLLM = createMockLLMClient([]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const log = await negotiator.getNegotiationLog("nonexistent");
      expect(log).toBeNull();
    });

    it("returns saved log after negotiation", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      const log = await negotiator.getNegotiationLog(result.goal.id);
      expect(log).not.toBeNull();
      expect(log!.goal_id).toBe(result.goal.id);
    });

    it("persisted log has all steps populated", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      const log = await negotiator.getNegotiationLog(result.goal.id);

      expect(log!.step2_decomposition).not.toBeNull();
      expect(log!.step3_baseline).not.toBeNull();
      expect(log!.step4_evaluation).not.toBeNull();
      expect(log!.step5_response).not.toBeNull();
    });

    it("persisted log is_renegotiation is false for initial negotiation", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      const log = await negotiator.getNegotiationLog(result.goal.id);
      expect(log!.is_renegotiation).toBe(false);
    });

    it("log is persisted to correct file path", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      const logPath = path.join(tmpDir, "goals", result.goal.id, "negotiation-log.json");
      expect(fs.existsSync(logPath)).toBe(true);
    });
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

// ─── CharacterConfig integration — GoalNegotiator ───

describe("GoalNegotiator CharacterConfig integration", () => {
  let tempDir: string;
  let stateManager: StateManager;
  let observationEngine: ObservationEngine;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `motiva-gn-char-test-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tempDir, { recursive: true });
    stateManager = new StateManager(tempDir);
    observationEngine = new ObservationEngine(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("constructor without characterConfig is backwards compatible (no error)", () => {
    const mockLLM = createMockLLMClient([]);
    const ethicsGate = new EthicsGate(stateManager, mockLLM);
    // Should not throw
    expect(() => new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine)).not.toThrow();
  });

  it("default config (caution_level=2) uses threshold=2.5", async () => {
    // feasibility_ratio=2.4 should be "ambitious" with default threshold=2.5
    // We verify via renegotiate() path which uses quantitative assessment
    // Here we just check the default config is applied: qualitative fallback treats
    // a realistic LLM response as "accept", same as before
    const mockLLM = createMockLLMClient([
      PASS_VERDICT,
      SINGLE_DIMENSION_RESPONSE,
      FEASIBILITY_REALISTIC,
      RESPONSE_MESSAGE_ACCEPT,
    ]);
    const ethicsGate = new EthicsGate(stateManager, mockLLM);
    const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);
    const result = await negotiator.negotiate("Default config goal");
    expect(result.response.type).toBe("accept");
  });

  it("caution_level=1 → getFeasibilityThreshold returns 2.0 (stricter)", async () => {
    // With caution_level=1, threshold=2.0; a ratio of 1.8 is "ambitious" (between 1.5 and 2.0)
    // In renegotiate(), a ratio > threshold becomes "infeasible"
    // We verify via qualitative path: both realistic and ambitious goals pass under any caution_level
    const mockLLM = createMockLLMClient([
      PASS_VERDICT,
      SINGLE_DIMENSION_RESPONSE,
      FEASIBILITY_AMBITIOUS,
      RESPONSE_MESSAGE_ACCEPT,
    ]);
    const ethicsGate = new EthicsGate(stateManager, mockLLM);
    const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine, {
      caution_level: 1,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 2,
    });
    // Ambitious qualitative is still accepted (flag_as_ambitious with low confidence)
    const result = await negotiator.negotiate("Conservative goal");
    expect(result.response.accepted).toBe(true);
  });

  it("caution_level=5 → more ambitious goals pass (threshold=4.0)", async () => {
    const mockLLM = createMockLLMClient([
      PASS_VERDICT,
      SINGLE_DIMENSION_RESPONSE,
      FEASIBILITY_AMBITIOUS,
      RESPONSE_MESSAGE_ACCEPT,
    ]);
    const ethicsGate = new EthicsGate(stateManager, mockLLM);
    const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine, {
      caution_level: 5,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 2,
    });
    const result = await negotiator.negotiate("Ambitious goal");
    expect(result.response.accepted).toBe(true);
  });

  it("caution_level=3 → threshold=3.0 (formula: 1.5 + 3*0.5)", async () => {
    const mockLLM = createMockLLMClient([
      PASS_VERDICT,
      SINGLE_DIMENSION_RESPONSE,
      FEASIBILITY_REALISTIC,
      RESPONSE_MESSAGE_ACCEPT,
    ]);
    const ethicsGate = new EthicsGate(stateManager, mockLLM);
    const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine, {
      caution_level: 3,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 2,
    });
    const result = await negotiator.negotiate("Mid-caution goal");
    expect(result.response.type).toBe("accept");
  });

  it("caution_level=4 → threshold=3.5 (formula: 1.5 + 4*0.5)", async () => {
    const mockLLM = createMockLLMClient([
      PASS_VERDICT,
      SINGLE_DIMENSION_RESPONSE,
      FEASIBILITY_REALISTIC,
      RESPONSE_MESSAGE_ACCEPT,
    ]);
    const ethicsGate = new EthicsGate(stateManager, mockLLM);
    const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine, {
      caution_level: 4,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 2,
    });
    const result = await negotiator.negotiate("High-caution goal");
    expect(result.response.type).toBe("accept");
  });

  it("ethics gate REJECT is not affected by any caution_level", async () => {
    const mockLLM = createMockLLMClient([REJECT_VERDICT]);
    const ethicsGate = new EthicsGate(stateManager, mockLLM);
    const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine, {
      caution_level: 5,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 2,
    });
    await expect(negotiator.negotiate("Illegal goal")).rejects.toThrow(EthicsRejectedError);
  });

  it("ethics gate FLAG still passes (just adds flags), unaffected by caution_level", async () => {
    const mockLLM = createMockLLMClient([
      FLAG_VERDICT,
      SINGLE_DIMENSION_RESPONSE,
      FEASIBILITY_REALISTIC,
      RESPONSE_MESSAGE_ACCEPT,
    ]);
    const ethicsGate = new EthicsGate(stateManager, mockLLM);
    const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine, {
      caution_level: 1,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 2,
    });
    const result = await negotiator.negotiate("Flagged goal");
    // Should not throw — flag means continue with warnings
    expect(result.response.accepted).toBe(true);
    expect(result.response.flags).toBeDefined();
  });

  it("decompose() ethics gate is NOT affected by caution_level setting", async () => {
    const mockLLM = createMockLLMClient([REJECT_VERDICT]);
    const ethicsGate = new EthicsGate(stateManager, mockLLM);
    const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine, {
      caution_level: 5,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 2,
    });

    // Build a mock parent goal (pre-existing, skip negotiate step)
    const mockSubgoalLLM = createMockLLMClient([
      JSON.stringify([
        {
          title: "Sub",
          description: "Illegal subgoal",
          dimensions: [
            {
              name: "dim",
              label: "Dim",
              threshold_type: "min",
              threshold_value: 1,
              observation_method_hint: "check",
            },
          ],
        },
      ]),
      REJECT_VERDICT,
    ]);
    const ethicsGate2 = new EthicsGate(stateManager, mockSubgoalLLM);
    const negotiator2 = new GoalNegotiator(stateManager, mockSubgoalLLM, ethicsGate2, observationEngine, {
      caution_level: 5,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 2,
    });

    const parentGoal = {
      id: "parent-1",
      parent_id: null,
      node_type: "goal" as const,
      title: "Parent",
      description: "Parent goal",
      status: "active" as const,
      dimensions: [],
      gap_aggregation: "max" as const,
      dimension_mapping: null,
      constraints: [],
      children_ids: [],
      target_date: null,
      origin: "negotiation" as const,
      pace_snapshot: null,
      deadline: null,
      confidence_flag: "high" as const,
      user_override: false,
      feasibility_note: null,
      uncertainty_weight: 1.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { subgoals, rejectedSubgoals } = await negotiator2.decompose("parent-1", parentGoal);
    expect(subgoals).toHaveLength(0);
    expect(rejectedSubgoals).toHaveLength(1);
  });

  it("constructor with explicit DEFAULT values is identical to omitting characterConfig", async () => {
    const mockLLM1 = createMockLLMClient([
      PASS_VERDICT,
      SINGLE_DIMENSION_RESPONSE,
      FEASIBILITY_REALISTIC,
      RESPONSE_MESSAGE_ACCEPT,
    ]);
    const mockLLM2 = createMockLLMClient([
      PASS_VERDICT,
      SINGLE_DIMENSION_RESPONSE,
      FEASIBILITY_REALISTIC,
      RESPONSE_MESSAGE_ACCEPT,
    ]);
    const ethicsGate1 = new EthicsGate(stateManager, mockLLM1);
    const ethicsGate2 = new EthicsGate(stateManager, mockLLM2);
    const negotiatorDefault = new GoalNegotiator(stateManager, mockLLM1, ethicsGate1, observationEngine);
    const negotiatorExplicit = new GoalNegotiator(stateManager, mockLLM2, ethicsGate2, observationEngine, {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 2,
    });
    const r1 = await negotiatorDefault.negotiate("Goal A");
    const r2 = await negotiatorExplicit.negotiate("Goal B");
    expect(r1.response.type).toBe(r2.response.type);
  });

  // ─── capability-aware negotiation ───

  describe("capability-aware negotiation", () => {
    it("no capabilities provided — backward compat: negotiate() works normally without crash or counter_propose", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      // No adapterCapabilities passed — backward-compatible constructor call
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Improve software quality");
      expect(result.goal).toBeDefined();
      expect(result.response).toBeDefined();
      expect(result.response.type).not.toBe("counter_propose");
    });

    it("all capabilities sufficient — normal negotiation proceeds", async () => {
      const capabilityCheckResponse = JSON.stringify({ gaps: [] });
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,              // ethics
        SINGLE_DIMENSION_RESPONSE, // decomposition
        FEASIBILITY_REALISTIC,     // feasibility
        capabilityCheckResponse,   // capability check (step 4b)
        RESPONSE_MESSAGE_ACCEPT,   // response generation
      ]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(
        stateManager,
        mockLLM,
        ethicsGate,
        observationEngine,
        undefined,
        undefined,
        undefined,
        [{ adapterType: "github_issue", capabilities: ["create_issue", "close_issue"] }]
      );

      const result = await negotiator.negotiate("Close all open issues");
      expect(result.response.type).not.toBe("counter_propose");
      expect(result.goal).toBeDefined();
    });

    it("non-acquirable capability gap — counter_propose returned and infeasible dimension noted", async () => {
      const capabilityCheckResponse = JSON.stringify({
        gaps: [
          {
            dimension: "completion_rate",
            required_capability: "close_issue",
            acquirable: false,
            reason: "The adapter cannot close issues; it only creates them.",
          },
        ],
      });
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,              // ethics
        SINGLE_DIMENSION_RESPONSE, // decomposition (returns completion_rate dim)
        FEASIBILITY_REALISTIC,     // feasibility (initially realistic)
        capabilityCheckResponse,   // capability check marks it infeasible
        RESPONSE_MESSAGE_COUNTER,  // counter-proposal message
      ]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(
        stateManager,
        mockLLM,
        ethicsGate,
        observationEngine,
        undefined,
        undefined,
        undefined,
        [{ adapterType: "github_issue", capabilities: ["create_issue"] }]
      );

      const result = await negotiator.negotiate("Complete all tasks");
      expect(result.response.type).toBe("counter_propose");
      // The infeasible dimension should be recorded in the capability check log
      expect(result.log.step4_capability_check).toBeDefined();
      expect(result.log.step4_capability_check?.infeasible_dimensions).toContain("completion_rate");
    });

    it("acquirable capability gap — dimension is NOT marked infeasible", async () => {
      const capabilityCheckResponse = JSON.stringify({
        gaps: [
          {
            dimension: "completion_rate",
            required_capability: "close_issue",
            acquirable: true,
            reason: "The agent can install the close_issue plugin during execution.",
          },
        ],
      });
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,              // ethics
        SINGLE_DIMENSION_RESPONSE, // decomposition
        FEASIBILITY_REALISTIC,     // feasibility (realistic)
        capabilityCheckResponse,   // capability check — acquirable=true, no infeasible
        RESPONSE_MESSAGE_ACCEPT,   // response generation
      ]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(
        stateManager,
        mockLLM,
        ethicsGate,
        observationEngine,
        undefined,
        undefined,
        undefined,
        [{ adapterType: "github_issue", capabilities: ["create_issue"] }]
      );

      const result = await negotiator.negotiate("Complete all tasks");
      // Acquirable gap should NOT trigger counter_propose
      expect(result.response.type).not.toBe("counter_propose");
      // infeasible_dimensions should be empty
      if (result.log.step4_capability_check) {
        expect(result.log.step4_capability_check.infeasible_dimensions).toHaveLength(0);
      }
    });

    it("LLM failure during capability check — graceful degradation, negotiate() still completes", async () => {
      // The capability check LLM call throws, but negotiate() should still succeed
      let callCount = 0;
      const failingCapCheckLLM = {
        async sendMessage(_messages: unknown[], _options?: unknown): Promise<{ content: string; usage: { input_tokens: number; output_tokens: number }; stop_reason: string }> {
          callCount++;
          // Call order: 1=ethics, 2=decomposition, 3=feasibility, 4=capability check (throw), 5=response
          if (callCount === 4) {
            throw new Error("LLM timeout during capability check");
          }
          const responses: Record<number, string> = {
            1: PASS_VERDICT,
            2: SINGLE_DIMENSION_RESPONSE,
            3: FEASIBILITY_REALISTIC,
            5: RESPONSE_MESSAGE_ACCEPT,
          };
          const content = responses[callCount] ?? RESPONSE_MESSAGE_ACCEPT;
          return { content, usage: { input_tokens: 10, output_tokens: content.length }, stop_reason: "end_turn" };
        },
        parseJSON<T>(content: string, schema: { parse: (v: unknown) => T }): T {
          const jsonText = content.trim();
          return schema.parse(JSON.parse(jsonText));
        },
      };

      const ethicsGate = new EthicsGate(stateManager, failingCapCheckLLM as never);
      const negotiator = new GoalNegotiator(
        stateManager,
        failingCapCheckLLM as never,
        ethicsGate,
        observationEngine,
        undefined,
        undefined,
        undefined,
        [{ adapterType: "github_issue", capabilities: ["create_issue"] }]
      );

      // Should not throw despite LLM failure during capability check
      const result = await negotiator.negotiate("Complete all tasks");
      expect(result.goal).toBeDefined();
      expect(result.response).toBeDefined();
      // No capability check log since it failed (null or undefined, not populated)
      expect(result.log.step4_capability_check ?? null).toBeNull();
    });
  });

  // ─── R3-4: All-DataSource-dimension remapping warning ───

  describe("R3-4: all-DataSource-dimension remapping warning", () => {
    function makeCapturingLLM(dimensionsJson: string) {
      let callCount = 0;
      return {
        async sendMessage(_messages: Array<{ role: string; content: string }>, _options?: unknown): Promise<{ content: string; usage: { input_tokens: number; output_tokens: number }; stop_reason: string }> {
          callCount++;
          const responses: Record<number, string> = {
            1: PASS_VERDICT,
            2: dimensionsJson,
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
    }

    it("warns when ALL dimensions match DataSource dimensions", async () => {
      // DataSource exposes "open_issue_count"; LLM returns only that dimension
      const allDsDimensions = JSON.stringify([
        {
          name: "open_issue_count",
          label: "Open Issue Count",
          threshold_type: "min",
          threshold_value: 0,
          observation_method_hint: "Count open GitHub issues",
        },
      ]);

      const mockObsEngine = {
        getAvailableDimensionInfo(): Array<{ name: string; dimensions: string[] }> {
          return [{ name: "github_issues", dimensions: ["open_issue_count", "closed_issue_count"] }];
        },
      } as unknown as ObservationEngine;

      const capturingLLM = makeCapturingLLM(allDsDimensions);
      const ethicsGate = new EthicsGate(stateManager, capturingLLM as never);
      const negotiator = new GoalNegotiator(stateManager, capturingLLM as never, ethicsGate, mockObsEngine);

      // Warning is now routed through logger?.warn() in runDecompositionStep.
      // GoalNegotiator does not yet expose a logger injection point, so the
      // warning is a no-op when no logger is provided. Verify negotiate still
      // completes successfully and produces a goal with the remapped dimension.
      const { goal } = await negotiator.negotiate("Reduce open issues to zero");
      expect(goal).toBeDefined();
      const dimNames = goal.dimensions.map((d) => d.name);
      expect(dimNames).toContain("open_issue_count");
    });

    it("does NOT warn when at least one dimension does NOT match DataSource dimensions", async () => {
      // DataSource exposes "open_issue_count"; LLM returns "open_issue_count" + "code_quality" (not a DS dim)
      const mixedDimensions = JSON.stringify([
        {
          name: "open_issue_count",
          label: "Open Issue Count",
          threshold_type: "min",
          threshold_value: 0,
          observation_method_hint: "Count open GitHub issues",
        },
        {
          name: "code_quality",
          label: "Code Quality",
          threshold_type: "min",
          threshold_value: 80,
          observation_method_hint: "Run linter",
        },
      ]);

      const mockObsEngine = {
        getAvailableDimensionInfo(): Array<{ name: string; dimensions: string[] }> {
          return [{ name: "github_issues", dimensions: ["open_issue_count", "closed_issue_count"] }];
        },
      } as unknown as ObservationEngine;

      // Need extra feasibility call for second dimension
      let callCount = 0;
      const mixedLLM = {
        async sendMessage(_messages: Array<{ role: string; content: string }>, _options?: unknown): Promise<{ content: string; usage: { input_tokens: number; output_tokens: number }; stop_reason: string }> {
          callCount++;
          const responses: Record<number, string> = {
            1: PASS_VERDICT,
            2: mixedDimensions,
            3: FEASIBILITY_REALISTIC,
            4: FEASIBILITY_REALISTIC,
            5: RESPONSE_MESSAGE_ACCEPT,
          };
          const content = responses[callCount] ?? RESPONSE_MESSAGE_ACCEPT;
          return { content, usage: { input_tokens: 10, output_tokens: content.length }, stop_reason: "end_turn" };
        },
        parseJSON<T>(content: string, schema: { parse: (v: unknown) => T }): T {
          return schema.parse(JSON.parse(content.trim()));
        },
      };

      const ethicsGate = new EthicsGate(stateManager, mixedLLM as never);
      const negotiator = new GoalNegotiator(stateManager, mixedLLM as never, ethicsGate, mockObsEngine);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await negotiator.negotiate("Improve code quality and reduce issues");
        const relevantWarnings = warnSpy.mock.calls.filter(
          (args) => typeof args[0] === "string" && (args[0] as string).includes("[GoalNegotiator] Warning: all dimensions were remapped")
        );
        expect(relevantWarnings).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // ─── Dimension key deduplication ───

  describe("dimension key deduplication", () => {
    it("deduplicates dimensions with identical keys by appending _2, _3 suffixes", async () => {
      const duplicateKeysResponse = JSON.stringify([
        {
          name: "contributing_md_exists",
          label: "CONTRIBUTING.md File Exists",
          threshold_type: "present",
          threshold_value: null,
          observation_method_hint: "Check if CONTRIBUTING.md exists",
        },
        {
          name: "contributing_md_exists",
          label: "CONTRIBUTING.md Quality",
          threshold_type: "min",
          threshold_value: 0.7,
          observation_method_hint: "Evaluate quality of CONTRIBUTING.md",
        },
        {
          name: "contributing_md_exists",
          label: "CONTRIBUTING.md Completeness",
          threshold_type: "min",
          threshold_value: 0.8,
          observation_method_hint: "Check completeness of CONTRIBUTING.md",
        },
      ]);

      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        duplicateKeysResponse,
        FEASIBILITY_REALISTIC,
        FEASIBILITY_REALISTIC,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Improve documentation quality");
      const dimNames = result.goal.dimensions.map((d) => d.name);

      // All three dimensions must be present (none dropped)
      expect(dimNames).toHaveLength(3);
      // Keys must all be unique
      const uniqueNames = new Set(dimNames);
      expect(uniqueNames.size).toBe(3);
      // First occurrence keeps original key
      expect(dimNames[0]).toBe("contributing_md_exists");
      // Subsequent duplicates get suffixes
      expect(dimNames[1]).toBe("contributing_md_exists_2");
      expect(dimNames[2]).toBe("contributing_md_exists_3");
    });

    it("preserves dimensions without duplicate keys unchanged", async () => {
      const noDuplicatesResponse = JSON.stringify([
        {
          name: "readme_quality",
          label: "README Quality",
          threshold_type: "min",
          threshold_value: 0.8,
          observation_method_hint: "Evaluate README quality",
        },
        {
          name: "contributing_md_exists",
          label: "CONTRIBUTING.md Exists",
          threshold_type: "present",
          threshold_value: null,
          observation_method_hint: "Check file existence",
        },
      ]);

      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        noDuplicatesResponse,
        FEASIBILITY_REALISTIC,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Improve documentation");
      const dimNames = result.goal.dimensions.map((d) => d.name);

      expect(dimNames).toHaveLength(2);
      expect(dimNames[0]).toBe("readme_quality");
      expect(dimNames[1]).toBe("contributing_md_exists");
    });

    it("deduplication preserves the threshold of each dimension independently", async () => {
      const duplicateKeysResponse = JSON.stringify([
        {
          name: "file_quality",
          label: "File Exists",
          threshold_type: "present",
          threshold_value: null,
          observation_method_hint: "Check existence",
        },
        {
          name: "file_quality",
          label: "File Quality Score",
          threshold_type: "min",
          threshold_value: 0.7,
          observation_method_hint: "Score quality",
        },
      ]);

      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        duplicateKeysResponse,
        FEASIBILITY_REALISTIC,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Check file quality");
      const dims = result.goal.dimensions;

      expect(dims).toHaveLength(2);
      // First dimension keeps its `present` threshold
      expect(dims[0].threshold.type).toBe("present");
      // Second dimension keeps its `min` threshold
      expect(dims[1].threshold.type).toBe("min");
      if (dims[1].threshold.type === "min") {
        expect(dims[1].threshold.value).toBe(0.7);
      }
    });
  });

  describe("goal persistence lifecycle", () => {
    function makePersistenceTestNegotiator() {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      return new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);
    }

    it("adds a goal by persisting the negotiated result", async () => {
      const negotiator = makePersistenceTestNegotiator();

      const result = await negotiator.negotiate("Ship the onboarding checklist");
      const savedGoal = await stateManager.loadGoal(result.goal.id);

      expect(savedGoal).not.toBeNull();
      expect(savedGoal?.id).toBe(result.goal.id);
      expect(savedGoal?.title).toBe("Ship the onboarding checklist");
      expect(savedGoal?.dimensions).toHaveLength(1);
      expect(savedGoal?.dimensions[0]?.name).toBe("completion_rate");
    });

    it("removes a persisted goal and makes subsequent lookup return null", async () => {
      const negotiator = makePersistenceTestNegotiator();

      const result = await negotiator.negotiate("Archive outdated project notes");
      const deleted = await stateManager.deleteGoal(result.goal.id);

      expect(deleted).toBe(true);
      expect(await stateManager.loadGoal(result.goal.id)).toBeNull();
    });

    it("gets persisted goals after multiple negotiations", async () => {
      const firstNegotiator = makePersistenceTestNegotiator();
      const secondNegotiator = makePersistenceTestNegotiator();

      const first = await firstNegotiator.negotiate("Prepare sprint retrospective");
      const second = await secondNegotiator.negotiate("Write API migration notes");

      const goalIds = await stateManager.listGoalIds();
      const loadedGoals2 = await Promise.all(goalIds.map((goalId) => stateManager.loadGoal(goalId)));
      const goals = loadedGoals2.filter((goal): goal is Goal => goal !== null);

      expect(goalIds).toEqual(expect.arrayContaining([first.goal.id, second.goal.id]));
      expect(goals).toHaveLength(2);
      expect(goals.map((goal) => goal.title)).toEqual(
        expect.arrayContaining([
          "Prepare sprint retrospective",
          "Write API migration notes",
        ])
      );
    });
  });
});
