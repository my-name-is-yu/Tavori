import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { StateManager } from "../src/state/state-manager.js";
import type { Goal } from "../src/types/goal.js";
import type { ObservationMethod } from "../src/types/core.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal, makeDimension } from "./helpers/fixtures.js";

// ─── Helpers ───

const defaultMethod: ObservationMethod = {
  type: "mechanical",
  source: "test-runner",
  schedule: null,
  endpoint: null,
  confidence_tier: "mechanical",
};

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

  it("applyObservation succeeds when dimension_name has _2 suffix matching a real dimension", async () => {
    const goalId = "goal-dedup-int";
    const goal = makeGoal({ id: goalId, dimensions: [makeDimension({ name: "todo_count", label: "Todo Count" })] });
    await stateManager.saveGoal(goal);

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
    await expect(engine.applyObservation(goalId, entry)).resolves.not.toThrow();

    // The goal dimension should have been updated
    const updated = await stateManager.loadGoal(goalId);
    expect(updated).not.toBeNull();
    const dim = updated!.dimensions.find((d) => d.name === "todo_count");
    expect(dim).not.toBeUndefined();
    expect(dim!.current_value).toBe(8);
  });

  it("applyObservation throws when stripped name still has no match in goal dimensions", async () => {
    const goalId = "goal-dedup-unknown";
    const goal = makeGoal({ id: goalId }); // only has "dim1"
    await stateManager.saveGoal(goal);

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

    await expect(engine.applyObservation(goalId, entry)).rejects.toThrow(
      /dimension "unknown_metric_2" not found/
    );
  });
});
