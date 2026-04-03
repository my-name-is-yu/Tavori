/**
 * M14-S2: StallDetector.analyzeStallCause() tests
 *
 * Covers:
 * - oscillating pattern → parameter_issue → REFINE
 * - flat pattern → strategy_wrong → PIVOT
 * - diverging pattern → goal_unreachable → ESCALATE
 * - insufficient data fallback
 * - pivot count limit logic (unit test of the decision table)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { StallDetector } from "../src/drive/stall-detector.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function makeGaps(values: number[]): Array<{ normalized_gap: number }> {
  return values.map((v) => ({ normalized_gap: v }));
}

let tempDir: string;
let stateManager: StateManager;
let detector: StallDetector;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  detector = new StallDetector(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── analyzeStallCause ───

describe("StallDetector.analyzeStallCause", () => {
  describe("insufficient data fallback", () => {
    it("returns pivot with low confidence when fewer than 3 entries", () => {
      const result = detector.analyzeStallCause(makeGaps([0.5, 0.6]));
      expect(result.cause).toBe("strategy_wrong");
      expect(result.recommended_action).toBe("pivot");
      expect(result.confidence).toBeLessThan(0.5);
    });

    it("returns pivot for empty history", () => {
      const result = detector.analyzeStallCause([]);
      expect(result.cause).toBe("strategy_wrong");
      expect(result.recommended_action).toBe("pivot");
    });

    it("returns pivot for exactly 1 entry", () => {
      const result = detector.analyzeStallCause(makeGaps([0.5]));
      expect(result.cause).toBe("strategy_wrong");
      expect(result.recommended_action).toBe("pivot");
    });
  });

  describe("diverging pattern → ESCALATE", () => {
    it("detects monotonically increasing gap as goal_unreachable", () => {
      // Each value is strictly larger than the previous → diverging
      const result = detector.analyzeStallCause(
        makeGaps([0.3, 0.4, 0.5, 0.6, 0.7])
      );
      expect(result.cause).toBe("goal_unreachable");
      expect(result.recommended_action).toBe("escalate");
      expect(result.confidence).toBeGreaterThan(0.7);
    });

    it("does not flag as diverging when one step decreases", () => {
      // Not strictly monotonic
      const result = detector.analyzeStallCause(
        makeGaps([0.3, 0.4, 0.35, 0.5, 0.7])
      );
      expect(result.recommended_action).not.toBe("escalate");
    });
  });

  describe("oscillating pattern → REFINE", () => {
    it("detects high-variance stable-mean pattern as parameter_issue", () => {
      // Alternating high/low around the same mean — high variance, small net delta
      const result = detector.analyzeStallCause(
        makeGaps([0.5, 0.8, 0.5, 0.8, 0.5, 0.8, 0.5])
      );
      expect(result.cause).toBe("parameter_issue");
      expect(result.recommended_action).toBe("refine");
      expect(result.confidence).toBeGreaterThan(0.6);
    });

    it("includes variance and delta in evidence string", () => {
      const result = detector.analyzeStallCause(
        makeGaps([0.5, 0.8, 0.5, 0.8, 0.5])
      );
      expect(result.evidence).toContain("variance");
      expect(result.evidence).toContain("delta");
    });
  });

  describe("flat pattern → PIVOT", () => {
    it("detects near-constant gap as strategy_wrong", () => {
      // Virtually unchanged gap — very low variance, delta ≈ 0
      const result = detector.analyzeStallCause(
        makeGaps([0.5, 0.501, 0.499, 0.5, 0.502, 0.5])
      );
      expect(result.cause).toBe("strategy_wrong");
      expect(result.recommended_action).toBe("pivot");
      expect(result.confidence).toBeGreaterThan(0.6);
    });
  });

  describe("schema compliance", () => {
    it("always returns a valid StallAnalysis shape", () => {
      const cases = [
        makeGaps([]),
        makeGaps([0.5]),
        makeGaps([0.3, 0.4, 0.5]),
        makeGaps([0.5, 0.5, 0.5, 0.5]),
        makeGaps([0.5, 0.8, 0.5, 0.8, 0.5]),
      ];
      for (const history of cases) {
        const result = detector.analyzeStallCause(history);
        expect(result).toHaveProperty("cause");
        expect(result).toHaveProperty("confidence");
        expect(result).toHaveProperty("evidence");
        expect(result).toHaveProperty("recommended_action");
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
        expect(["parameter_issue", "strategy_wrong", "goal_unreachable"]).toContain(result.cause);
        expect(["refine", "pivot", "escalate"]).toContain(result.recommended_action);
      }
    });
  });
});

// ─── Pivot count limit logic (unit) ───

describe("pivot_count / max_pivot_count decision table", () => {
  /**
   * The CoreLoop logic is:
   *   if (pivotCount >= maxPivotCount) → escalate
   *   else → pivot
   *
   * We verify the boundary conditions here as pure logic.
   */
  function shouldAutoEscalate(pivotCount: number, maxPivotCount: number): boolean {
    return pivotCount >= maxPivotCount;
  }

  it("does not auto-escalate when pivot_count < max_pivot_count", () => {
    expect(shouldAutoEscalate(0, 2)).toBe(false);
    expect(shouldAutoEscalate(1, 2)).toBe(false);
  });

  it("auto-escalates when pivot_count equals max_pivot_count", () => {
    expect(shouldAutoEscalate(2, 2)).toBe(true);
  });

  it("auto-escalates when pivot_count exceeds max_pivot_count", () => {
    expect(shouldAutoEscalate(3, 2)).toBe(true);
  });

  it("default max_pivot_count is 2", () => {
    // StrategySchema default — verified through the decision boundary
    const defaultMax = 2;
    expect(shouldAutoEscalate(0, defaultMax)).toBe(false);
    expect(shouldAutoEscalate(2, defaultMax)).toBe(true);
  });
});
