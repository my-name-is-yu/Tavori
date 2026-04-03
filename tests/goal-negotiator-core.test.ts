import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { EthicsGate } from "../src/traits/ethics-gate.js";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { GoalNegotiator, EthicsRejectedError } from "../src/goal/goal-negotiator.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import {
  PASS_VERDICT_SAFE_JSON as PASS_VERDICT,
  REJECT_VERDICT_ILLEGAL_JSON as REJECT_VERDICT,
  FLAG_VERDICT_PRIVACY_JSON as FLAG_VERDICT,
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

const RESPONSE_MESSAGE_ACCEPT = "Your goal has been accepted. Let's get started!";

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
        RESPONSE_MESSAGE_ACCEPT,
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
      const goals = loadedGoals.filter((goal): goal is import("../src/types/goal.js").Goal => goal !== null);

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
});
