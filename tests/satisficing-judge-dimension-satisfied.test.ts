import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { SatisficingJudge } from "../src/drive/satisficing-judge.js";
import type { Dimension } from "../src/types/goal.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Test Fixtures ───

function makeDimension(overrides: Partial<Dimension> = {}): Dimension {
  return {
    name: "test_dim",
    label: "Test Dimension",
    current_value: 50,
    threshold: { type: "min", value: 100 },
    confidence: 0.9,
    observation_method: {
      type: "mechanical",
      source: "test",
      schedule: null,
      endpoint: null,
      confidence_tier: "mechanical",
    },
    last_updated: new Date().toISOString(),
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok",
    dimension_mapping: null,
    ...overrides,
  };
}

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;
let judge: SatisficingJudge;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  judge = new SatisficingJudge(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── isDimensionSatisfied ───

describe("isDimensionSatisfied", () => {
  describe("min threshold", () => {
    it("satisfied when current_value >= threshold", () => {
      const dim = makeDimension({
        current_value: 100,
        threshold: { type: "min", value: 100 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.is_satisfied).toBe(true);
      expect(result.dimension_name).toBe("test_dim");
    });

    it("satisfied when current_value exceeds threshold", () => {
      const dim = makeDimension({
        current_value: 150,
        threshold: { type: "min", value: 100 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.is_satisfied).toBe(true);
    });

    it("not satisfied when current_value < threshold", () => {
      const dim = makeDimension({
        current_value: 80,
        threshold: { type: "min", value: 100 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.is_satisfied).toBe(false);
    });

    it("not satisfied when current_value is null", () => {
      const dim = makeDimension({
        current_value: null,
        threshold: { type: "min", value: 100 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.is_satisfied).toBe(false);
      expect(result.effective_progress).toBe(0);
    });
  });

  describe("max threshold", () => {
    it("satisfied when current_value <= threshold", () => {
      const dim = makeDimension({
        current_value: 0.03,
        threshold: { type: "max", value: 0.05 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.is_satisfied).toBe(true);
    });

    it("satisfied when current_value equals threshold", () => {
      const dim = makeDimension({
        current_value: 0.05,
        threshold: { type: "max", value: 0.05 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.is_satisfied).toBe(true);
    });

    it("not satisfied when current_value > threshold", () => {
      const dim = makeDimension({
        current_value: 0.08,
        threshold: { type: "max", value: 0.05 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.is_satisfied).toBe(false);
    });
  });

  describe("range threshold", () => {
    const threshold = { type: "range" as const, low: 36.0, high: 37.0 };

    it("satisfied when current_value is within range", () => {
      const dim = makeDimension({ current_value: 36.5, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(true);
    });

    it("satisfied at lower bound", () => {
      const dim = makeDimension({ current_value: 36.0, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(true);
    });

    it("satisfied at upper bound", () => {
      const dim = makeDimension({ current_value: 37.0, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(true);
    });

    it("not satisfied below range", () => {
      const dim = makeDimension({ current_value: 35.5, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(false);
    });

    it("not satisfied above range", () => {
      const dim = makeDimension({ current_value: 37.5, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(false);
    });
  });

  describe("present threshold", () => {
    const threshold = { type: "present" as const };

    it("satisfied for truthy number", () => {
      const dim = makeDimension({ current_value: 1, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(true);
    });

    it("satisfied for truthy string", () => {
      const dim = makeDimension({ current_value: "yes", threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(true);
    });

    it("satisfied for true boolean", () => {
      const dim = makeDimension({ current_value: true, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(true);
    });

    it("not satisfied for 0", () => {
      const dim = makeDimension({ current_value: 0, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(false);
    });

    it("not satisfied for false", () => {
      const dim = makeDimension({ current_value: false, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(false);
    });

    it("not satisfied for empty string", () => {
      const dim = makeDimension({ current_value: "", threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(false);
    });

    it("not satisfied for null", () => {
      const dim = makeDimension({ current_value: null, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(false);
    });
  });

  describe("match threshold", () => {
    const threshold = { type: "match" as const, value: "approved" };

    it("satisfied on exact string match", () => {
      const dim = makeDimension({ current_value: "approved", threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(true);
    });

    it("not satisfied on mismatch", () => {
      const dim = makeDimension({ current_value: "pending", threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(false);
    });

    it("not satisfied for null", () => {
      const dim = makeDimension({ current_value: null, threshold, confidence: 0.9 });
      expect(judge.isDimensionSatisfied(dim).is_satisfied).toBe(false);
    });
  });

  describe("confidence tiers", () => {
    it("confidence >= 0.85 → tier = high", () => {
      const dim = makeDimension({ confidence: 0.85 });
      expect(judge.isDimensionSatisfied(dim).confidence_tier).toBe("high");
    });

    it("confidence = 1.0 → tier = high", () => {
      const dim = makeDimension({ confidence: 1.0 });
      expect(judge.isDimensionSatisfied(dim).confidence_tier).toBe("high");
    });

    it("confidence = 0.70 → tier = medium", () => {
      const dim = makeDimension({ confidence: 0.70 });
      expect(judge.isDimensionSatisfied(dim).confidence_tier).toBe("medium");
    });

    it("confidence = 0.50 → tier = medium", () => {
      const dim = makeDimension({ confidence: 0.50 });
      expect(judge.isDimensionSatisfied(dim).confidence_tier).toBe("medium");
    });

    it("confidence = 0.30 → tier = low", () => {
      const dim = makeDimension({ confidence: 0.30 });
      expect(judge.isDimensionSatisfied(dim).confidence_tier).toBe("low");
    });

    it("confidence = 0.0 → tier = low", () => {
      const dim = makeDimension({ confidence: 0.0 });
      expect(judge.isDimensionSatisfied(dim).confidence_tier).toBe("low");
    });
  });

  describe("progress ceiling applied", () => {
    it("high confidence: ceiling = 1.0, no cap on perfect progress", () => {
      const dim = makeDimension({
        current_value: 100,
        threshold: { type: "min", value: 100 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.progress_ceiling).toBe(1.0);
      expect(result.effective_progress).toBe(1.0);
    });

    it("medium confidence: ceiling = 0.85 caps progress at 0.85", () => {
      const dim = makeDimension({
        current_value: 100,
        threshold: { type: "min", value: 100 },
        confidence: 0.70,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.progress_ceiling).toBe(0.85);
      expect(result.effective_progress).toBe(0.85);
    });

    it("low confidence: ceiling = 0.60 caps progress at 0.60", () => {
      const dim = makeDimension({
        current_value: 100,
        threshold: { type: "min", value: 100 },
        confidence: 0.30,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.progress_ceiling).toBe(0.60);
      expect(result.effective_progress).toBe(0.60);
    });

    it("partial progress below ceiling is not capped", () => {
      // 50/100 = 0.5 actual progress; with high confidence ceiling = 1.0, stays at 0.5
      const dim = makeDimension({
        current_value: 50,
        threshold: { type: "min", value: 100 },
        confidence: 0.9,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.effective_progress).toBeCloseTo(0.5);
    });

    it("partial progress above medium ceiling gets capped", () => {
      // 90/100 = 0.9 actual progress; medium confidence ceiling = 0.85
      const dim = makeDimension({
        current_value: 90,
        threshold: { type: "min", value: 100 },
        confidence: 0.70,
      });
      const result = judge.isDimensionSatisfied(dim);
      expect(result.effective_progress).toBe(0.85);
    });
  });
});
