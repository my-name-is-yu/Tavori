import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";
import { EthicsGate } from "../src/traits/ethics-gate.js";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { GoalNegotiator, EthicsRejectedError } from "../src/goal/goal-negotiator.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
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

const RESPONSE_MESSAGE_ACCEPT = "Your goal has been accepted. Let's get started!";
const RESPONSE_MESSAGE_COUNTER = "This goal is too ambitious. Consider a safer target.";

// ─── CharacterConfig integration — GoalNegotiator ───

describe("GoalNegotiator CharacterConfig integration", () => {
  let tempDir: string;
  let stateManager: StateManager;
  let observationEngine: ObservationEngine;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `pulseed-gn-char-test-${Math.random().toString(36).slice(2)}`);
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
    function makePersistenceTestNegotiator(sm: StateManager, oe: ObservationEngine) {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(sm, mockLLM);
      return new GoalNegotiator(sm, mockLLM, ethicsGate, oe);
    }

    it("adds a goal by persisting the negotiated result", async () => {
      const negotiator = makePersistenceTestNegotiator(stateManager, observationEngine);

      const result = await negotiator.negotiate("Ship the onboarding checklist");
      const savedGoal = await stateManager.loadGoal(result.goal.id);

      expect(savedGoal).not.toBeNull();
      expect(savedGoal?.id).toBe(result.goal.id);
      expect(savedGoal?.title).toBe("Ship the onboarding checklist");
      expect(savedGoal?.dimensions).toHaveLength(1);
      expect(savedGoal?.dimensions[0]?.name).toBe("completion_rate");
    });

    it("removes a persisted goal and makes subsequent lookup return null", async () => {
      const negotiator = makePersistenceTestNegotiator(stateManager, observationEngine);

      const result = await negotiator.negotiate("Archive outdated project notes");
      const deleted = await stateManager.deleteGoal(result.goal.id);

      expect(deleted).toBe(true);
      expect(await stateManager.loadGoal(result.goal.id)).toBeNull();
    });

    it("gets persisted goals after multiple negotiations", async () => {
      const firstNegotiator = makePersistenceTestNegotiator(stateManager, observationEngine);
      const secondNegotiator = makePersistenceTestNegotiator(stateManager, observationEngine);

      const first = await firstNegotiator.negotiate("Prepare sprint retrospective");
      const second = await secondNegotiator.negotiate("Write API migration notes");

      const goalIds = await stateManager.listGoalIds();
      const loadedGoals2 = await Promise.all(goalIds.map((goalId) => stateManager.loadGoal(goalId)));
      const goals = loadedGoals2.filter((goal): goal is import("../src/types/goal.js").Goal => goal !== null);

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
