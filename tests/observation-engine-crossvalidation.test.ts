import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ObservationEngine } from "../src/observation-engine.js";
import { StateManager } from "../src/state-manager.js";
import type { Goal } from "../src/types/goal.js";
import type { ObservationMethod } from "../src/types/core.js";
import type { ILLMClient } from "../src/llm-client.js";
import type { IDataSourceAdapter } from "../src/data-source-adapter.js";
import type { DataSourceConfig } from "../src/types/data-source.js";

// ─── Helpers ───

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-obs-xval-test-"));
}

const defaultMethod: ObservationMethod = {
  type: "mechanical",
  source: "test-runner",
  schedule: null,
  endpoint: null,
  confidence_tier: "mechanical",
};

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    parent_id: null,
    node_type: "goal",
    title: "Test Goal",
    description: overrides.description ?? "Improve code quality",
    status: "active",
    dimensions: overrides.dimensions ?? [
      {
        name: "code_quality",
        label: "Code Quality",
        current_value: 0.5,
        threshold: { type: "min", value: 0.8 },
        confidence: 0.3,
        observation_method: defaultMethod,
        last_updated: now,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
        state_integrity: "ok",
      },
    ],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: null,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

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
  queryValue = 5,
  supportedDimensions: string[] = ["code_quality"]
): IDataSourceAdapter {
  return {
    sourceId: "mock-ds",
    sourceType: "file",
    config: makeDsConfig(),
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({
      value: queryValue,
      raw: { metrics: { quality: queryValue } },
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

// ─── Tests ───

describe("ObservationEngine cross-validation", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Test 1: crossValidationEnabled=false (default): LLM NOT called when DataSource succeeds ───

  it("LLM is NOT called when crossValidationEnabled is false (default) and DataSource succeeds", async () => {
    const mockLLMClient = createMockLLMClient(0.5);
    const mockDs = makeMockDataSource(0.85);
    // No options passed — default is crossValidationEnabled=false
    const engine = new ObservationEngine(stateManager, [mockDs], mockLLMClient);

    const goal = makeGoal({ id: "goal-xval-off" });
    stateManager.saveGoal(goal);

    await engine.observe("goal-xval-off", [defaultMethod]);

    // DataSource was used
    expect(mockDs.query).toHaveBeenCalled();
    // LLM should NOT have been called
    expect(mockLLMClient.sendMessage).not.toHaveBeenCalled();
  });

  // ─── Test 2: crossValidationEnabled=true: LLM IS called even when DataSource succeeds ───

  it("LLM IS called when crossValidationEnabled=true and DataSource succeeds", async () => {
    const mockLLMClient = createMockLLMClient(0.82);
    const mockDs = makeMockDataSource(0.85);
    const engine = new ObservationEngine(
      stateManager,
      [mockDs],
      mockLLMClient,
      undefined,
      { crossValidationEnabled: true }
    );

    const goal = makeGoal({ id: "goal-xval-on" });
    stateManager.saveGoal(goal);

    await engine.observe("goal-xval-on", [defaultMethod]);

    // DataSource was used
    expect(mockDs.query).toHaveBeenCalled();
    // LLM should also have been called for cross-validation
    expect(mockLLMClient.sendMessage).toHaveBeenCalled();
  });

  // ─── Test 3: No divergence (within threshold) → diverged=false, no warn log ───

  it("no warn log when mechanical and LLM values are within divergenceThreshold", async () => {
    // mechanical=5 (from DataSource), LLM score=0.51 → scaled value 5*0.51=2.55
    // But the goal threshold is {type:"min", value:10}, so LLM score 0.51 → 0.51*10=5.1
    // |5 - 5.1| / max(5, 5.1, 1) = 0.1/5.1 ≈ 0.0196 — well within 0.20
    const goal = makeGoal({
      id: "goal-xval-no-diverge",
      dimensions: [
        {
          name: "code_quality",
          label: "Code Quality",
          current_value: 5,
          threshold: { type: "min", value: 10 },
          confidence: 0.3,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
        },
      ],
    });
    stateManager.saveGoal(goal);

    // DataSource returns 5, LLM returns score=0.51 → extractedValue = 0.51*10 = 5.1
    const mockLLMClient = createMockLLMClient(0.51);
    const mockDs = makeMockDataSource(5);
    const engine = new ObservationEngine(
      stateManager,
      [mockDs],
      mockLLMClient,
      undefined,
      { crossValidationEnabled: true, divergenceThreshold: 0.20 }
    );

    const warnSpy = vi.spyOn(console, "warn");

    await engine.observe("goal-xval-no-diverge", [defaultMethod]);

    // Should not have logged a CrossValidation DIVERGED warning
    const divergedWarn = warnSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("[CrossValidation] DIVERGED")
    );
    expect(divergedWarn).toBeUndefined();

    warnSpy.mockRestore();
  });

  // ─── Test 4: Divergence (mechanical=5, llm=0) → diverged=true, warn log emitted ───

  it("emits warn log when mechanical and LLM values diverge beyond threshold", async () => {
    // mechanical=5 (from DataSource), LLM score=0.0 → extractedValue=0 (0*any = 0)
    // |5 - 0| / max(5, 0, 1) = 5/5 = 1.0 → diverged (> 0.20)
    const goal = makeGoal({
      id: "goal-xval-diverge",
      dimensions: [
        {
          name: "code_quality",
          label: "Code Quality",
          current_value: 5,
          threshold: { type: "min", value: 10 },
          confidence: 0.3,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
        },
      ],
    });
    stateManager.saveGoal(goal);

    // DataSource returns 5, LLM returns score=0.0 → extractedValue=0
    const mockLLMClient = createMockLLMClient(0.0, "nothing found");
    const mockDs = makeMockDataSource(5);
    const engine = new ObservationEngine(
      stateManager,
      [mockDs],
      mockLLMClient,
      undefined,
      { crossValidationEnabled: true, divergenceThreshold: 0.20 }
    );

    const warnSpy = vi.spyOn(console, "warn");

    await engine.observe("goal-xval-diverge", [defaultMethod]);

    // Should have logged a CrossValidation DIVERGED warning
    const divergedWarn = warnSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("[CrossValidation] DIVERGED")
    );
    expect(divergedWarn).toBeDefined();
    expect(divergedWarn![0]).toContain('resolution=mechanical_wins');

    warnSpy.mockRestore();
  });

  // ─── Test 5: Goal dimension retains mechanical value — LLM does NOT overwrite ───

  it("goal dimension retains mechanical value after cross-validation (LLM does not overwrite)", async () => {
    const mechanicalValue = 0.85;
    const llmScore = 0.3; // very different — but must not win

    const goal = makeGoal({
      id: "goal-xval-retain",
      dimensions: [
        {
          name: "code_quality",
          label: "Code Quality",
          current_value: 0.5,
          threshold: { type: "min", value: 0.8 },
          confidence: 0.3,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
        },
      ],
    });
    stateManager.saveGoal(goal);

    const mockLLMClient = createMockLLMClient(llmScore);
    const mockDs = makeMockDataSource(mechanicalValue);
    const engine = new ObservationEngine(
      stateManager,
      [mockDs],
      mockLLMClient,
      undefined,
      { crossValidationEnabled: true }
    );

    await engine.observe("goal-xval-retain", [defaultMethod]);

    const updatedGoal = stateManager.loadGoal("goal-xval-retain");
    expect(updatedGoal).not.toBeNull();
    const dim = updatedGoal!.dimensions.find((d) => d.name === "code_quality");
    expect(dim).not.toBeNull();

    // The dimension should hold the mechanical value (0.85), not the LLM value (0.3)
    expect(dim!.current_value).toBe(mechanicalValue);

    // There should be exactly 1 observation log entry (mechanical only)
    const log = engine.getObservationLog("goal-xval-retain");
    expect(log.entries.length).toBe(1);
    expect(log.entries[0]!.layer).toBe("mechanical");
  });

  // ─── Test 6: LLM failure during cross-validation is caught and doesn't break observation ───

  it("LLM failure during cross-validation is caught and observation still completes", async () => {
    const goal = makeGoal({ id: "goal-xval-llm-fail" });
    stateManager.saveGoal(goal);

    const failingLLMClient: ILLMClient = {
      sendMessage: vi.fn().mockRejectedValue(new Error("LLM service unavailable")),
      parseJSON: vi.fn(),
    };
    const mockDs = makeMockDataSource(0.85);
    const engine = new ObservationEngine(
      stateManager,
      [mockDs],
      failingLLMClient,
      undefined,
      { crossValidationEnabled: true }
    );

    const warnSpy = vi.spyOn(console, "warn");

    // Should not throw even though LLM fails
    await expect(engine.observe("goal-xval-llm-fail", [defaultMethod])).resolves.toBeUndefined();

    // A warning should have been emitted about the LLM failure
    const crossValWarn = warnSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("[CrossValidation] LLM comparison failed")
    );
    expect(crossValWarn).toBeDefined();

    // The goal state should still reflect the mechanical value
    const updatedGoal = stateManager.loadGoal("goal-xval-llm-fail");
    expect(updatedGoal).not.toBeNull();
    const dim = updatedGoal!.dimensions.find((d) => d.name === "code_quality");
    expect(dim).not.toBeNull();
    expect(dim!.current_value).toBe(0.85);

    warnSpy.mockRestore();
  });
});
