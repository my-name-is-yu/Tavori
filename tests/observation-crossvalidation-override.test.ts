import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { StateManager } from "../src/state/state-manager.js";
import type { ObservationMethod } from "../src/types/core.js";
import type { ILLMClient } from "../src/llm/llm-client.js";
import type { IDataSourceAdapter } from "../src/observation/data-source-adapter.js";
import type { DataSourceConfig } from "../src/types/data-source.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";
import { applyObservation } from "../src/observation/observation-apply.js";

// ─── Helpers ───

const defaultMethod: ObservationMethod = {
  type: "mechanical",
  source: "test-runner",
  schedule: null,
  endpoint: null,
  confidence_tier: "mechanical",
};

function makeDsConfig(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: "mock-ds",
    name: "Mock Data Source",
    type: "file",
    connection: { path: "/tmp/mock.json" },
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockDataSource(
  queryValue: number | string | boolean = 0,
  supportedDimensions: string[] = ["capability_count"]
): IDataSourceAdapter {
  return {
    sourceId: "mock-ds",
    sourceType: "file",
    config: makeDsConfig(),
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({
      value: queryValue,
      raw: { count: queryValue },
      timestamp: new Date().toISOString(),
      source_id: "mock-ds",
    }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
    getSupportedDimensions: vi.fn().mockReturnValue(supportedDimensions),
  };
}

function createMockLLMClient(score: number, reason = "test reason"): ILLMClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      content: JSON.stringify({ score, reason }),
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: "end_turn",
    }),
    parseJSON: vi.fn().mockReturnValue({ score, reason }),
  };
}

// ─── Tests: Cross-Validation Confidence Penalty ───

describe("Cross-validation confidence penalty on LLM hallucination", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies confidence penalty when LLM claims 1.0 but mechanical returns 0", async () => {
    // Scenario: capability_count dimension
    // Mechanical (DataSource) returns 0 — no capabilities exist
    // LLM hallucinates score=1.0 — claims capabilities exist
    const goal = makeGoal({
      id: "goal-hallucination",
      dimensions: [
        {
          name: "capability_count",
          label: "Capability Count",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.90,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
        },
      ],
    });
    await stateManager.saveGoal(goal);

    const mockDs = makeMockDataSource(0, ["capability_count"]);
    const mockLLMClient = createMockLLMClient(1.0, "capabilities detected");
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const engine = new ObservationEngine(
      stateManager,
      [mockDs],
      mockLLMClient,
      undefined,
      { crossValidationEnabled: true, divergenceThreshold: 0.20 },
      mockLogger as never
    );

    await engine.observe("goal-hallucination", [defaultMethod]);

    // Mechanical value should be retained (0)
    const updatedGoal = await stateManager.loadGoal("goal-hallucination");
    expect(updatedGoal).not.toBeNull();
    const dim = updatedGoal!.dimensions.find((d) => d.name === "capability_count");
    expect(dim).not.toBeNull();
    expect(dim!.current_value).toBe(0);

    // Confidence should have been penalized (below original 0.90)
    expect(dim!.confidence).toBeLessThan(0.90);

    // Should have logged divergence warning
    const divergeWarn = mockLogger.warn.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("[CrossValidation] DIVERGED")
    );
    expect(divergeWarn).toBeDefined();

    // Should have logged confidence penalty warning
    const penaltyWarn = mockLogger.warn.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("Confidence penalized")
    );
    expect(penaltyWarn).toBeDefined();
    expect(penaltyWarn![0]).toContain("LLM hallucination detected");
  });

  it("does NOT apply confidence penalty when LLM agrees with mechanical", async () => {
    const goal = makeGoal({
      id: "goal-agreement",
      dimensions: [
        {
          name: "capability_count",
          label: "Capability Count",
          current_value: 0.5,
          threshold: { type: "min", value: 1 },
          confidence: 0.90,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
        },
      ],
    });
    await stateManager.saveGoal(goal);

    // Both return ~0.5 — no divergence
    const mockDs = makeMockDataSource(0.5, ["capability_count"]);
    const mockLLMClient = createMockLLMClient(0.5, "partial progress");
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const engine = new ObservationEngine(
      stateManager,
      [mockDs],
      mockLLMClient,
      undefined,
      { crossValidationEnabled: true, divergenceThreshold: 0.20 },
      mockLogger as never
    );

    await engine.observe("goal-agreement", [defaultMethod]);

    const updatedGoal = await stateManager.loadGoal("goal-agreement");
    const dim = updatedGoal!.dimensions.find((d) => d.name === "capability_count");

    // Confidence should remain at mechanical level (0.90)
    expect(dim!.confidence).toBe(0.90);

    // Should NOT have logged penalty warning
    const penaltyWarn = mockLogger.warn.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("Confidence penalized")
    );
    expect(penaltyWarn).toBeUndefined();
  });

  it("confidence penalty does not go below 0.10 floor", async () => {
    const goal = makeGoal({
      id: "goal-floor",
      dimensions: [
        {
          name: "capability_count",
          label: "Capability Count",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.15, // already very low
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
        },
      ],
    });
    await stateManager.saveGoal(goal);

    const mockDs = makeMockDataSource(0, ["capability_count"]);
    const mockLLMClient = createMockLLMClient(1.0, "hallucinated");

    const engine = new ObservationEngine(
      stateManager,
      [mockDs],
      mockLLMClient,
      undefined,
      { crossValidationEnabled: true },
    );

    await engine.observe("goal-floor", [defaultMethod]);

    const updatedGoal = await stateManager.loadGoal("goal-floor");
    const dim = updatedGoal!.dimensions.find((d) => d.name === "capability_count");

    // Confidence should be floored at 0.10
    expect(dim!.confidence).toBeGreaterThanOrEqual(0.10);
  });
});

// ─── Tests: Value Bounds Validation in applyObservation ───

describe("observation-apply value bounds validation", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clamps present-type dimension values to [0, 1]", async () => {
    const goal = makeGoal({
      id: "goal-clamp-present",
      dimensions: [
        {
          name: "has_feature",
          label: "Has Feature",
          current_value: 0,
          threshold: { type: "present" },
          confidence: 0.70,
          observation_method: {
            type: "llm_review",
            source: "llm",
            schedule: null,
            endpoint: null,
            confidence_tier: "independent_review",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
        },
      ],
    });
    await stateManager.saveGoal(goal);

    // Create an entry with out-of-bounds value (1.5)
    const entry = {
      observation_id: "obs-clamp-1",
      timestamp: new Date().toISOString(),
      trigger: "periodic" as const,
      goal_id: "goal-clamp-present",
      dimension_name: "has_feature",
      layer: "independent_review" as const,
      method: {
        type: "llm_review" as const,
        source: "llm",
        schedule: null,
        endpoint: null,
        confidence_tier: "independent_review" as const,
      },
      raw_result: { score: 1.5 },
      extracted_value: 1.5,
      confidence: 0.70,
      notes: null,
    };

    await applyObservation("goal-clamp-present", entry, stateManager, {});

    const updated = await stateManager.loadGoal("goal-clamp-present");
    const dim = updated!.dimensions.find((d) => d.name === "has_feature");

    // Value should be clamped to 1.0 (max for present-type)
    expect(dim!.current_value).toBe(1);
  });

  it("clamps negative values to 0 for min-type dimensions", async () => {
    const goal = makeGoal({
      id: "goal-clamp-min",
      dimensions: [
        {
          name: "test_count",
          label: "Test Count",
          current_value: 0,
          threshold: { type: "min", value: 10 },
          confidence: 0.70,
          observation_method: {
            type: "llm_review",
            source: "llm",
            schedule: null,
            endpoint: null,
            confidence_tier: "independent_review",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
        },
      ],
    });
    await stateManager.saveGoal(goal);

    const entry = {
      observation_id: "obs-clamp-2",
      timestamp: new Date().toISOString(),
      trigger: "periodic" as const,
      goal_id: "goal-clamp-min",
      dimension_name: "test_count",
      layer: "independent_review" as const,
      method: {
        type: "llm_review" as const,
        source: "llm",
        schedule: null,
        endpoint: null,
        confidence_tier: "independent_review" as const,
      },
      raw_result: { score: -5 },
      extracted_value: -5,
      confidence: 0.70,
      notes: null,
    };

    await applyObservation("goal-clamp-min", entry, stateManager, {});

    const updated = await stateManager.loadGoal("goal-clamp-min");
    const dim = updated!.dimensions.find((d) => d.name === "test_count");

    // Negative values should be clamped to 0
    expect(dim!.current_value).toBe(0);
  });

  it("clamps excessively high values to 2x threshold for min-type dimensions", async () => {
    const goal = makeGoal({
      id: "goal-clamp-high",
      dimensions: [
        {
          name: "test_count",
          label: "Test Count",
          current_value: 5,
          threshold: { type: "min", value: 10 },
          confidence: 0.70,
          observation_method: {
            type: "llm_review",
            source: "llm",
            schedule: null,
            endpoint: null,
            confidence_tier: "independent_review",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
        },
      ],
    });
    await stateManager.saveGoal(goal);

    const entry = {
      observation_id: "obs-clamp-3",
      timestamp: new Date().toISOString(),
      trigger: "periodic" as const,
      goal_id: "goal-clamp-high",
      dimension_name: "test_count",
      layer: "independent_review" as const,
      method: {
        type: "llm_review" as const,
        source: "llm",
        schedule: null,
        endpoint: null,
        confidence_tier: "independent_review" as const,
      },
      raw_result: { score: 100 },
      extracted_value: 100,
      confidence: 0.70,
      notes: null,
    };

    await applyObservation("goal-clamp-high", entry, stateManager, {});

    const updated = await stateManager.loadGoal("goal-clamp-high");
    const dim = updated!.dimensions.find((d) => d.name === "test_count");

    // Value should be clamped to 20 (2x threshold value of 10)
    expect(dim!.current_value).toBe(20);
  });
});
