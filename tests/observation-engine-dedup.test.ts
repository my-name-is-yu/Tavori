import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ObservationEngine } from "../src/observation-engine.js";
import { StateManager } from "../src/state-manager.js";
import type { Goal } from "../src/types/goal.js";
import type { ObservationMethod } from "../src/types/core.js";

// ─── Helpers ───

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-obs-dedup-test-"));
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
    description: "Test goal description",
    status: "active",
    dimensions: overrides.dimensions ?? [
      {
        name: "todo_count",
        label: "Todo Count",
        current_value: 5,
        threshold: { type: "min", value: 10 },
        confidence: 0.9,
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

// ─── Tests ───

describe("ObservationEngine dimension name dedup normalization", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let engine: ObservationEngine;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    engine = new ObservationEngine(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Access the private method via casting for unit tests
  function normalize(name: string): string {
    return (engine as unknown as { normalizeDimensionName(n: string): string }).normalizeDimensionName(name);
  }

  // ─── Unit: normalizeDimensionName ───

  it("strips _2 suffix from todo_count_2", () => {
    expect(normalize("todo_count_2")).toBe("todo_count");
  });

  it("strips _3 suffix from quality_3", () => {
    expect(normalize("quality_3")).toBe("quality");
  });

  it("does NOT strip step_count — 'count' is not a digit-only suffix", () => {
    expect(normalize("step_count")).toBe("step_count");
  });

  it("leaves coverage unchanged — no numeric suffix", () => {
    expect(normalize("coverage")).toBe("coverage");
  });

  // ─── Integration: applyObservation with deduplicated key ───

  it("applyObservation succeeds when dimension_name has _2 suffix matching a real dimension", () => {
    const goalId = "goal-dedup-int";
    const goal = makeGoal({ id: goalId });
    stateManager.saveGoal(goal);

    // Build an entry with the deduplicated key "todo_count_2"
    const entry = engine.createObservationEntry({
      goalId,
      dimensionName: "todo_count_2", // LLM-produced dedup key
      layer: "mechanical",
      method: defaultMethod,
      trigger: "periodic",
      rawResult: 8,
      extractedValue: 8,
      confidence: 0.9,
    });

    // Should NOT throw — normalization maps "todo_count_2" → "todo_count"
    expect(() => engine.applyObservation(goalId, entry)).not.toThrow();

    // The goal dimension should have been updated
    const updated = stateManager.loadGoal(goalId);
    expect(updated).not.toBeNull();
    const dim = updated!.dimensions.find((d) => d.name === "todo_count");
    expect(dim).not.toBeUndefined();
    expect(dim!.current_value).toBe(8);
  });

  it("applyObservation throws when stripped name still has no match in goal dimensions", () => {
    const goalId = "goal-dedup-unknown";
    const goal = makeGoal({ id: goalId }); // only has "todo_count"
    stateManager.saveGoal(goal);

    // "unknown_metric_2" strips to "unknown_metric" — still not in goal
    const entry = engine.createObservationEntry({
      goalId,
      dimensionName: "unknown_metric_2",
      layer: "mechanical",
      method: defaultMethod,
      trigger: "periodic",
      rawResult: 0,
      extractedValue: 0,
      confidence: 0.9,
    });

    expect(() => engine.applyObservation(goalId, entry)).toThrow(
      /dimension "unknown_metric_2" not found/
    );
  });
});
