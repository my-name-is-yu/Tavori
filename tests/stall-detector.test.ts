import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state/state-manager.js";
import { StallDetector } from "../src/drive/stall-detector.js";
import { ProgressPredictor } from "../src/drive/progress-predictor.js";
import type { StallState } from "../src/types/stall.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function makeGapHistory(values: number[]): Array<{ normalized_gap: number }> {
  return values.map((v) => ({ normalized_gap: v }));
}

// ─── Test Setup ───

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

// ─── checkDimensionStall ───

describe("checkDimensionStall", () => {
  it("returns null when gap is improving (decreasing)", () => {
    // 6 entries: gap going from 0.8 to 0.3
    const history = makeGapHistory([0.8, 0.7, 0.6, 0.5, 0.4, 0.3]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).toBeNull();
  });

  it("returns StallReport when gap has not decreased over N (default=5) loops", () => {
    // Flat gap for 6 entries (oldest=0.5, latest=0.5)
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("dimension_stall");
    expect(result!.goal_id).toBe("goal-1");
    expect(result!.dimension_name).toBe("dim-a");
    expect(result!.decay_factor).toBe(0.6);
  });

  it("returns StallReport when gap slightly increased (got worse)", () => {
    // Gap went up from 0.4 to 0.5 over the window
    const history = makeGapHistory([0.4, 0.42, 0.45, 0.48, 0.5, 0.5]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("dimension_stall");
  });

  it("returns null when history is too short (fewer than N+1 entries)", () => {
    // Default N=5, need at least 6 entries
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).toBeNull();
  });

  it("uses N=6 for 'immediate' feedback category", () => {
    // N=6 means need 7 entries; flat over 7 entries → stall
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history, "immediate");
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("dimension_stall");
  });

  it("uses N=6 for 'immediate': 4 entries is insufficient history → no stall", () => {
    // N=6 → need 7 entries; 4 entries is not enough data
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history, "immediate");
    expect(result).toBeNull();
  });

  it("uses N=6 for 'immediate': improving over 7 entries → no stall", () => {
    const history = makeGapHistory([0.5, 0.45, 0.40, 0.35, 0.30, 0.25, 0.20]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history, "immediate");
    expect(result).toBeNull();
  });

  it("uses N=10 for 'long_term' feedback category", () => {
    // N=10 means need 11 entries; only 6 available → not enough data
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history, "long_term");
    expect(result).toBeNull();
  });

  it("uses N=10 for 'long_term': stall detected with 11 flat entries", () => {
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history, "long_term");
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("dimension_stall");
  });

  it("uses N=5 for 'medium_term' feedback category", () => {
    // N=5 means need 6 entries; improving → no stall
    const history = makeGapHistory([0.5, 0.48, 0.46, 0.44, 0.42, 0.40]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history, "medium_term");
    expect(result).toBeNull();
  });

  it("falls back to N=5 for unknown feedback category", () => {
    // Unknown category → N=5 (default)
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history, "unknown_category");
    expect(result).not.toBeNull();
  });

  it("should not stall within 5 iterations if no progress (new 6-iteration threshold)", () => {
    // Default category N=5 → need 6 entries to detect stall.
    // 5 flat entries (indices 0-4) = only 5 entries → insufficient history → no stall.
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).toBeNull();
  });

  it("should stall after 6 iterations of no progress", () => {
    // Default category N=5 → need 6 entries (N+1=6) → 6 flat entries → stall.
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("dimension_stall");
  });

  it("does not reset stall detection for trivial improvement below 0.05 delta", () => {
    // Improvement of only 0.001 (from 0.5 to 0.499) — below MIN_IMPROVEMENT_DELTA → still stall
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.499]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("dimension_stall");
  });

  it("resets stall detection for meaningful improvement of >= 0.05 delta", () => {
    // Improvement of 0.10 (from 0.5 to 0.40) — at or above MIN_IMPROVEMENT_DELTA → no stall
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.40]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).toBeNull();
  });
});

// ─── checkTimeExceeded ───

describe("checkTimeExceeded", () => {
  it("returns null when no started_at", () => {
    const task = {
      goal_id: "goal-1",
      started_at: null,
      estimated_duration: { value: 1, unit: "hours" },
    };
    expect(detector.checkTimeExceeded(task)).toBeNull();
  });

  it("returns null when elapsed time is within estimate×2 threshold", () => {
    // Estimate = 1 hour, threshold = 2 hours, started 1 hour ago
    const startedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const task = {
      goal_id: "goal-1",
      started_at: startedAt,
      estimated_duration: { value: 1, unit: "hours" },
    };
    expect(detector.checkTimeExceeded(task)).toBeNull();
  });

  it("returns StallReport when elapsed time exceeds estimate×2", () => {
    // Estimate = 1 hour → threshold = 2 hours; started 3 hours ago
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const task = {
      task_id: "task-123",
      goal_id: "goal-1",
      started_at: startedAt,
      estimated_duration: { value: 1, unit: "hours" },
    };
    const result = detector.checkTimeExceeded(task);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("time_exceeded");
    expect(result!.task_id).toBe("task-123");
    expect(result!.suggested_cause).toBe("external_dependency");
  });

  it("uses default 2 hours for 'coding' category (no estimate)", () => {
    // Started 1 hour ago → within 2h threshold → no stall
    const startedAt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const task = { goal_id: "goal-1", started_at: startedAt, task_category: "coding" };
    expect(detector.checkTimeExceeded(task)).toBeNull();
  });

  it("returns StallReport for 'coding' after exceeding 2 hours", () => {
    // Started 3 hours ago → exceeds 2h threshold
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const task = { goal_id: "goal-1", started_at: startedAt, task_category: "coding" };
    const result = detector.checkTimeExceeded(task);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("time_exceeded");
  });

  it("uses default 2 hours for 'implementation' category", () => {
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const task = { goal_id: "goal-1", started_at: startedAt, task_category: "implementation" };
    const result = detector.checkTimeExceeded(task);
    expect(result).not.toBeNull();
  });

  it("uses default 4 hours for 'research' category", () => {
    // Started 3 hours ago → within 4h → no stall
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const task = { goal_id: "goal-1", started_at: startedAt, task_category: "research" };
    expect(detector.checkTimeExceeded(task)).toBeNull();
  });

  it("returns StallReport for 'research' after exceeding 4 hours", () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const task = { goal_id: "goal-1", started_at: startedAt, task_category: "research" };
    const result = detector.checkTimeExceeded(task);
    expect(result).not.toBeNull();
  });

  it("uses default 4 hours for 'investigation' category", () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const task = { goal_id: "goal-1", started_at: startedAt, task_category: "investigation" };
    const result = detector.checkTimeExceeded(task);
    expect(result).not.toBeNull();
  });

  it("uses fallback 3 hours for unknown category", () => {
    // Started 2 hours ago → within 3h → no stall
    const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const task = { goal_id: "goal-1", started_at: startedAt, task_category: "other" };
    expect(detector.checkTimeExceeded(task)).toBeNull();
  });

  it("returns StallReport for unknown category after exceeding 3 hours", () => {
    const startedAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const task = { goal_id: "goal-1", started_at: startedAt };
    const result = detector.checkTimeExceeded(task);
    expect(result).not.toBeNull();
  });

  it("handles duration in minutes correctly (estimate × 2)", () => {
    // Estimate = 60 minutes (1 hour) → threshold = 2 hours; started 3 hours ago
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const task = {
      goal_id: "goal-1",
      started_at: startedAt,
      estimated_duration: { value: 60, unit: "minutes" },
    };
    const result = detector.checkTimeExceeded(task);
    expect(result).not.toBeNull();
  });

  it("handles duration in days correctly (estimate × 2)", () => {
    // Estimate = 1 day → threshold = 2 days; started 1 day ago → no stall
    const startedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const task = {
      goal_id: "goal-1",
      started_at: startedAt,
      estimated_duration: { value: 1, unit: "days" },
    };
    expect(detector.checkTimeExceeded(task)).toBeNull();
  });
});

// ─── checkConsecutiveFailures ───

describe("checkConsecutiveFailures", () => {
  it("returns null when count is below threshold (< 3)", () => {
    expect(detector.checkConsecutiveFailures("goal-1", "dim-a", 2)).toBeNull();
  });

  it("returns null when count is 0", () => {
    expect(detector.checkConsecutiveFailures("goal-1", "dim-a", 0)).toBeNull();
  });

  it("returns StallReport when count equals threshold (3)", () => {
    const result = detector.checkConsecutiveFailures("goal-1", "dim-a", 3);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("consecutive_failure");
    expect(result!.goal_id).toBe("goal-1");
    expect(result!.dimension_name).toBe("dim-a");
    expect(result!.suggested_cause).toBe("approach_failure");
  });

  it("returns StallReport when count exceeds threshold (5)", () => {
    const result = detector.checkConsecutiveFailures("goal-1", "dim-a", 5);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("consecutive_failure");
  });
});

// ─── checkGlobalStall ───

describe("checkGlobalStall", () => {
  it("returns null for empty dimension map", () => {
    const result = detector.checkGlobalStall("goal-1", new Map());
    expect(result).toBeNull();
  });

  it("returns null when at least one dimension is improving", () => {
    const dims = new Map([
      ["dim-a", makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5])],
      ["dim-b", makeGapHistory([0.5, 0.4, 0.3, 0.2, 0.1, 0.05])], // improving
    ]);
    const result = detector.checkGlobalStall("goal-1", dims);
    expect(result).toBeNull();
  });

  it("returns StallReport when all dimensions are flat for 5 loops", () => {
    const dims = new Map([
      ["dim-a", makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5])],
      ["dim-b", makeGapHistory([0.3, 0.3, 0.3, 0.3, 0.3, 0.3])],
    ]);
    const result = detector.checkGlobalStall("goal-1", dims);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("global_stall");
    expect(result!.goal_id).toBe("goal-1");
    expect(result!.suggested_cause).toBe("goal_infeasible");
  });

  it("returns null when a dimension has insufficient history", () => {
    const dims = new Map([
      ["dim-a", makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5])],
      ["dim-b", makeGapHistory([0.5, 0.5])], // too short
    ]);
    const result = detector.checkGlobalStall("goal-1", dims);
    expect(result).toBeNull();
  });

  it("respects custom loopThreshold", () => {
    // loopThreshold=3: need 4 entries; all flat over 4 entries → stall
    const dims = new Map([
      ["dim-a", makeGapHistory([0.5, 0.5, 0.5, 0.5])],
      ["dim-b", makeGapHistory([0.3, 0.3, 0.3, 0.3])],
    ]);
    const result = detector.checkGlobalStall("goal-1", dims, 3);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("global_stall");
  });
});

// ─── classifyStallCause ───

describe("classifyStallCause", () => {
  it("returns 'approach_failure' for dimension_stall with high-confidence dimensions", () => {
    const goal = { dimensions: [{ confidence: 0.8 }, { confidence: 0.9 }] };
    expect(detector.classifyStallCause("dimension_stall", goal)).toBe("approach_failure");
  });

  it("returns 'external_dependency' for time_exceeded", () => {
    const goal = { dimensions: [{ confidence: 0.8 }] };
    expect(detector.classifyStallCause("time_exceeded", goal)).toBe("external_dependency");
  });

  it("returns 'approach_failure' for consecutive_failure", () => {
    const goal = { dimensions: [{ confidence: 0.7 }] };
    expect(detector.classifyStallCause("consecutive_failure", goal)).toBe("approach_failure");
  });

  it("returns 'goal_infeasible' for global_stall", () => {
    const goal = { dimensions: [{ confidence: 0.8 }] };
    expect(detector.classifyStallCause("global_stall", goal)).toBe("goal_infeasible");
  });

  it("returns 'information_deficit' when any dimension has confidence < 0.5", () => {
    const goal = { dimensions: [{ confidence: 0.8 }, { confidence: 0.3 }] };
    expect(detector.classifyStallCause("dimension_stall", goal)).toBe("information_deficit");
  });

  it("returns 'information_deficit' even for time_exceeded if low-confidence dim exists", () => {
    const goal = { dimensions: [{ confidence: 0.4 }] };
    expect(detector.classifyStallCause("time_exceeded", goal)).toBe("information_deficit");
  });

  it("returns 'information_deficit' for global_stall with low-confidence dimension", () => {
    const goal = { dimensions: [{ confidence: 0.1 }] };
    expect(detector.classifyStallCause("global_stall", goal)).toBe("information_deficit");
  });

  it("returns 'approach_failure' as fallback for unknown stall type", () => {
    const goal = { dimensions: [{ confidence: 0.9 }] };
    expect(detector.classifyStallCause("unknown_type", goal)).toBe("approach_failure");
  });

  it("handles goal with no dimensions", () => {
    const goal = {};
    expect(detector.classifyStallCause("global_stall", goal)).toBe("goal_infeasible");
  });

  it("handles goal with dimensions lacking confidence property", () => {
    const goal = { dimensions: [{}] };
    expect(detector.classifyStallCause("dimension_stall", goal)).toBe("approach_failure");
  });
});

// ─── computeDecayFactor ───

describe("computeDecayFactor", () => {
  it("returns 0.6 when stalled (regardless of loopsSinceRecovery)", () => {
    expect(detector.computeDecayFactor(true, null)).toBe(0.6);
    expect(detector.computeDecayFactor(true, 0)).toBe(0.6);
    expect(detector.computeDecayFactor(true, 5)).toBe(0.6);
  });

  it("returns 1.0 when not stalled and no recovery (null)", () => {
    expect(detector.computeDecayFactor(false, null)).toBe(1.0);
  });

  it("returns 0.75 at 0 loops since recovery", () => {
    expect(detector.computeDecayFactor(false, 0)).toBe(0.75);
  });

  it("returns 0.75 at 1 loop since recovery (threshold 2 not reached)", () => {
    expect(detector.computeDecayFactor(false, 1)).toBe(0.75);
  });

  it("returns 0.90 at 2 loops since recovery", () => {
    expect(detector.computeDecayFactor(false, 2)).toBe(0.9);
  });

  it("returns 0.90 at 3 loops since recovery (threshold 4 not reached)", () => {
    expect(detector.computeDecayFactor(false, 3)).toBe(0.9);
  });

  it("returns 1.0 at 4 loops since recovery", () => {
    expect(detector.computeDecayFactor(false, 4)).toBe(1.0);
  });

  it("returns 1.0 at 10 loops since recovery", () => {
    expect(detector.computeDecayFactor(false, 10)).toBe(1.0);
  });
});

// ─── isSuppressed ───

describe("isSuppressed", () => {
  it("returns false when plateauUntil is null", () => {
    expect(detector.isSuppressed(null)).toBe(false);
  });

  it("returns true when plateauUntil is in the future", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
    expect(detector.isSuppressed(future)).toBe(true);
  });

  it("returns false when plateauUntil is in the past", () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    expect(detector.isSuppressed(past)).toBe(false);
  });

  it("returns false when plateauUntil is exactly now (boundary)", () => {
    // Using a time slightly in the past to avoid flakiness
    const slightlyPast = new Date(Date.now() - 1000).toISOString();
    expect(detector.isSuppressed(slightlyPast)).toBe(false);
  });
});

// ─── getStallState / saveStallState ───

describe("getStallState / saveStallState", () => {
  it("returns default state when no state persisted", async () => {
    const state = await detector.getStallState("goal-1");
    expect(state.goal_id).toBe("goal-1");
    expect(state.dimension_escalation).toEqual({});
    expect(state.global_escalation).toBe(0);
    expect(state.decay_factors).toEqual({});
    expect(state.recovery_loops).toEqual({});
  });

  it("round-trips: save and load StallState", async () => {
    const stateToSave: StallState = {
      goal_id: "goal-2",
      dimension_escalation: { "dim-a": 2, "dim-b": 1 },
      global_escalation: 1,
      decay_factors: { "dim-a": 0.6 },
      recovery_loops: { "dim-b": 3 },
    };

    await detector.saveStallState("goal-2", stateToSave);
    const loaded = await detector.getStallState("goal-2");

    expect(loaded.goal_id).toBe("goal-2");
    expect(loaded.dimension_escalation["dim-a"]).toBe(2);
    expect(loaded.dimension_escalation["dim-b"]).toBe(1);
    expect(loaded.global_escalation).toBe(1);
    expect(loaded.decay_factors["dim-a"]).toBe(0.6);
    expect(loaded.recovery_loops["dim-b"]).toBe(3);
  });
});

// ─── getEscalationLevel / incrementEscalation / resetEscalation ───

describe("escalation lifecycle", () => {
  it("returns 0 for a fresh goal/dimension", async () => {
    expect(await detector.getEscalationLevel("goal-1", "dim-a")).toBe(0);
  });

  it("increments escalation level from 0 to 1", async () => {
    const newLevel = await detector.incrementEscalation("goal-1", "dim-a");
    expect(newLevel).toBe(1);
    expect(await detector.getEscalationLevel("goal-1", "dim-a")).toBe(1);
  });

  it("increments escalation level through full lifecycle", async () => {
    expect(await detector.incrementEscalation("goal-1", "dim-a")).toBe(1);
    expect(await detector.incrementEscalation("goal-1", "dim-a")).toBe(2);
    expect(await detector.incrementEscalation("goal-1", "dim-a")).toBe(3);
  });

  it("caps escalation at 3", async () => {
    await detector.incrementEscalation("goal-1", "dim-a");
    await detector.incrementEscalation("goal-1", "dim-a");
    await detector.incrementEscalation("goal-1", "dim-a");
    const capped = await detector.incrementEscalation("goal-1", "dim-a"); // attempt 4th
    expect(capped).toBe(3);
    expect(await detector.getEscalationLevel("goal-1", "dim-a")).toBe(3);
  });

  it("resets escalation to 0", async () => {
    await detector.incrementEscalation("goal-1", "dim-a");
    await detector.incrementEscalation("goal-1", "dim-a");
    await detector.resetEscalation("goal-1", "dim-a");
    expect(await detector.getEscalationLevel("goal-1", "dim-a")).toBe(0);
  });

  it("does not affect other dimensions when resetting", async () => {
    await detector.incrementEscalation("goal-1", "dim-a");
    await detector.incrementEscalation("goal-1", "dim-b");
    await detector.resetEscalation("goal-1", "dim-a");
    expect(await detector.getEscalationLevel("goal-1", "dim-a")).toBe(0);
    expect(await detector.getEscalationLevel("goal-1", "dim-b")).toBe(1);
  });

  it("persists escalation across detector instances", async () => {
    await detector.incrementEscalation("goal-1", "dim-a");
    await detector.incrementEscalation("goal-1", "dim-a");

    // Create a new detector using the same stateManager
    const detector2 = new StallDetector(stateManager);
    expect(await detector2.getEscalationLevel("goal-1", "dim-a")).toBe(2);
  });

  it("escalation is independent per goal", async () => {
    await detector.incrementEscalation("goal-1", "dim-a");
    await detector.incrementEscalation("goal-1", "dim-a");
    expect(await detector.getEscalationLevel("goal-2", "dim-a")).toBe(0);
  });

  it("can increment multiple dimensions independently", async () => {
    await detector.incrementEscalation("goal-1", "dim-a");
    await detector.incrementEscalation("goal-1", "dim-a");
    await detector.incrementEscalation("goal-1", "dim-b");
    expect(await detector.getEscalationLevel("goal-1", "dim-a")).toBe(2);
    expect(await detector.getEscalationLevel("goal-1", "dim-b")).toBe(1);
  });
});

// ─── StallReport shape validation ───

describe("StallReport shape", () => {
  it("dimension_stall report has all required fields", () => {
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).not.toBeNull();
    expect(typeof result!.detected_at).toBe("string");
    expect(result!.escalation_level).toBeGreaterThanOrEqual(0);
    expect(result!.escalation_level).toBeLessThanOrEqual(3);
    expect(result!.decay_factor).toBe(0.6);
  });

  it("time_exceeded report has task_id when provided", () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const task = {
      task_id: "my-task-id",
      goal_id: "goal-1",
      started_at: startedAt,
      estimated_duration: { value: 1, unit: "hours" },
    };
    const result = detector.checkTimeExceeded(task);
    expect(result!.task_id).toBe("my-task-id");
    expect(result!.dimension_name).toBeNull();
  });

  it("consecutive_failure report includes dimension_name", () => {
    const result = detector.checkConsecutiveFailures("goal-1", "dim-x", 3);
    expect(result!.dimension_name).toBe("dim-x");
  });

  it("global_stall report has null dimension_name and task_id", () => {
    const dims = new Map([
      ["dim-a", makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5])],
    ]);
    const result = detector.checkGlobalStall("goal-1", dims);
    expect(result!.dimension_name).toBeNull();
    expect(result!.task_id).toBeNull();
  });
});

// ─── CharacterConfig integration — StallDetector ───

describe("StallDetector CharacterConfig integration", () => {
  let tempDir2: string;
  let stateManager2: StateManager;

  beforeEach(() => {
    tempDir2 = makeTempDir();
    stateManager2 = new StateManager(tempDir2);
  });

  afterEach(() => {
    fs.rmSync(tempDir2, { recursive: true, force: true });
  });

  it("constructor without characterConfig is backwards compatible (no error)", () => {
    expect(() => new StallDetector(stateManager2)).not.toThrow();
  });

  it("default config (stall_flexibility=1) uses N=6 for immediate category", () => {
    // stall_flexibility=1 → multiplier=1.0 → immediate N=6 (need 7 entries)
    const detectorDefault = new StallDetector(stateManager2);
    // 7 flat entries → stall with immediate (N=6, need 7 entries)
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const result = detectorDefault.checkDimensionStall("goal-1", "dim-a", history, "immediate");
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("dimension_stall");
  });

  it("default config (stall_flexibility=1) — medium_term N=5, need 6 entries", () => {
    const detectorDefault = new StallDetector(stateManager2);
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const result = detectorDefault.checkDimensionStall("goal-1", "dim-a", history, "medium_term");
    expect(result).not.toBeNull();
  });

  it("stall_flexibility=1 → N multiplier=1.0 (identical to no config)", () => {
    const detectorFlex1 = new StallDetector(stateManager2, {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 2,
    });
    // immediate N=6 → need 7 entries
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(detectorFlex1.checkDimensionStall("g", "d", history, "immediate")).not.toBeNull();
  });

  it("stall_flexibility=5 → multiplier=2.0 → immediate N=12 (need 13 entries)", () => {
    const detectorFlex5 = new StallDetector(stateManager2, {
      caution_level: 2,
      stall_flexibility: 5,
      communication_directness: 3,
      proactivity_level: 2,
    });
    // immediate base N=6 → adjusted N=round(6*2.0)=12 → need 13 entries
    // 7 flat entries: not enough data → null
    const shortHistory = makeGapHistory(new Array(7).fill(0.5));
    expect(detectorFlex5.checkDimensionStall("g", "d", shortHistory, "immediate")).toBeNull();
    // 13 flat entries: stall detected
    const longHistory = makeGapHistory(new Array(13).fill(0.5));
    expect(detectorFlex5.checkDimensionStall("g", "d", longHistory, "immediate")).not.toBeNull();
  });

  it("stall_flexibility=5 → long_term N=20 (need 21 entries)", () => {
    const detectorFlex5 = new StallDetector(stateManager2, {
      caution_level: 2,
      stall_flexibility: 5,
      communication_directness: 3,
      proactivity_level: 2,
    });
    // long_term base N=10 → adjusted N=round(10*2.0)=20 → need 21 entries
    // 11 flat entries: not enough data → null
    const shortHistory = makeGapHistory(new Array(11).fill(0.5));
    expect(detectorFlex5.checkDimensionStall("g", "d", shortHistory, "long_term")).toBeNull();
    // 21 flat entries: stall detected
    const longHistory = makeGapHistory(new Array(21).fill(0.5));
    expect(detectorFlex5.checkDimensionStall("g", "d", longHistory, "long_term")).not.toBeNull();
  });

  it("CONSECUTIVE_FAILURE_THRESHOLD is unchanged at stall_flexibility=1 (threshold=3)", () => {
    const detectorFlex1 = new StallDetector(stateManager2, {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 2,
    });
    expect(detectorFlex1.checkConsecutiveFailures("g", "d", 2)).toBeNull();
    expect(detectorFlex1.checkConsecutiveFailures("g", "d", 3)).not.toBeNull();
  });

  it("CONSECUTIVE_FAILURE_THRESHOLD is unchanged at stall_flexibility=5 (threshold still=3)", () => {
    const detectorFlex5 = new StallDetector(stateManager2, {
      caution_level: 2,
      stall_flexibility: 5,
      communication_directness: 3,
      proactivity_level: 2,
    });
    expect(detectorFlex5.checkConsecutiveFailures("g", "d", 2)).toBeNull();
    expect(detectorFlex5.checkConsecutiveFailures("g", "d", 3)).not.toBeNull();
  });

  it("ESCALATION_CAP is unchanged at any stall_flexibility (caps at 3)", async () => {
    const detectorFlex5 = new StallDetector(stateManager2, {
      caution_level: 2,
      stall_flexibility: 5,
      communication_directness: 3,
      proactivity_level: 2,
    });
    await detectorFlex5.incrementEscalation("g", "d");
    await detectorFlex5.incrementEscalation("g", "d");
    await detectorFlex5.incrementEscalation("g", "d");
    const capped = await detectorFlex5.incrementEscalation("g", "d");
    expect(capped).toBe(3);
  });

  it("stall_flexibility=3 → multiplier=1.5 → medium_term N=round(5*1.5)=8", () => {
    const detectorFlex3 = new StallDetector(stateManager2, {
      caution_level: 2,
      stall_flexibility: 3,
      communication_directness: 3,
      proactivity_level: 2,
    });
    // medium_term base N=5 → adjusted N=round(5*1.5)=8 → need 9 entries
    // 6 flat entries: not enough → null
    const shortHistory = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(detectorFlex3.checkDimensionStall("g", "d", shortHistory, "medium_term")).toBeNull();
    // 9 flat entries: stall detected
    const longHistory = makeGapHistory(new Array(9).fill(0.5));
    expect(detectorFlex3.checkDimensionStall("g", "d", longHistory, "medium_term")).not.toBeNull();
  });

  it("constructor with explicit DEFAULT values identical to omitting characterConfig", () => {
    const detectorDefault = new StallDetector(stateManager2);
    const detectorExplicit = new StallDetector(stateManager2, {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 2,
    });
    // Both should behave identically for immediate stall (N=6, need 7 entries)
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const r1 = detectorDefault.checkDimensionStall("g", "d", history, "immediate");
    const r2 = detectorExplicit.checkDimensionStall("g", "d", history, "immediate");
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.stall_type).toBe(r2!.stall_type);
  });
});

// ─── Zero-progress early detection ───

describe("zero-progress early detection", () => {
  it("detects zero-progress stall with sufficient history at gap=1.00", () => {
    const history = makeGapHistory([1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("dimension_stall");
    expect(result!.goal_id).toBe("goal-1");
    expect(result!.dimension_name).toBe("dim-a");
    expect(result!.decay_factor).toBe(0.6);
  });

  it("detects zero-progress in checkGlobalStall with sufficient history", () => {
    const dims = new Map([
      ["dim-a", makeGapHistory([1.0, 1.0, 1.0, 1.0, 1.0, 1.0])],
    ]);
    const result = detector.checkGlobalStall("goal-1", dims);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("global_stall");
    expect(result!.goal_id).toBe("goal-1");
  });

  it("does NOT trigger zero-progress when gap is below floor with insufficient history", () => {
    const history = makeGapHistory([0.89, 0.89, 0.89]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).toBeNull(); // insufficient history (3 < 6) and below GAP_FLOOR
  });

  it("does NOT trigger zero-progress when gap values vary too much", () => {
    // oldest=1.0, latest=0.9, diff=0.1 >= 0.05 → improvement detected → null
    const history = makeGapHistory([1.0, 0.9, 1.0, 0.9, 1.0, 0.9]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).toBeNull();
  });

  it("detects zero-progress at gap=0.98 (near but not exactly 1.00)", () => {
    const history = makeGapHistory([0.98, 0.98, 0.98, 0.98, 0.98, 0.98]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("dimension_stall");
  });

  it("does NOT trigger global stall when one dimension is zero-progress but another is improving", () => {
    // dim-a: stuck at 1.0, dim-b: improving from 1.0 to 0.5
    const dims = new Map([
      ["dim-a", makeGapHistory([1.0, 1.0, 1.0, 1.0, 1.0, 1.0])],
      ["dim-b", makeGapHistory([1.0, 0.9, 0.8, 0.7, 0.6, 0.5])],
    ]);
    const result = detector.checkGlobalStall("goal-1", dims);
    expect(result).toBeNull(); // dim-b improved, so no global stall
  });

  it("triggers global stall when ALL dimensions are zero-progress", () => {
    const dims = new Map([
      ["dim-a", makeGapHistory([1.0, 1.0, 1.0, 1.0, 1.0, 1.0])],
      ["dim-b", makeGapHistory([0.95, 0.95, 0.95, 0.95, 0.95, 0.95])],
    ]);
    const result = detector.checkGlobalStall("goal-1", dims);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("global_stall");
  });

  it("detects zero-progress at gap=0.90 after GAP_FLOOR lowered", () => {
    const history = makeGapHistory([0.90, 0.90, 0.90, 0.90, 0.90, 0.90]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("dimension_stall");
  });
});

// ─── Achieved-dimension guard (ACHIEVED_GAP_THRESHOLD) ───

describe("achieved-dimension guard", () => {
  // checkDimensionStall tests

  it("returns null when full window is at or below achieved threshold (0.02)", () => {
    // All 6 entries <= 0.02 → dimension is achieved → not a stall
    const history = makeGapHistory([0.02, 0.01, 0.01, 0.02, 0.00, 0.01]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).toBeNull();
  });

  it("returns null when full window is exactly at threshold (0.02)", () => {
    // Boundary: exactly 0.02 for all entries → achieved
    const history = makeGapHistory([0.02, 0.02, 0.02, 0.02, 0.02, 0.02]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).toBeNull();
  });

  it("does NOT skip when dimension is just above threshold (0.03 > 0.02)", () => {
    // Latest is 0.03 — just above threshold; still checked for stall
    const history = makeGapHistory([0.03, 0.03, 0.03, 0.03, 0.03, 0.03]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("dimension_stall");
  });

  it("does NOT skip when oscillating around threshold (some above, some below)", () => {
    // Entries alternate between 0.01 (below) and 0.05 (above) — not all achieved
    const history = makeGapHistory([0.01, 0.05, 0.01, 0.05, 0.01, 0.05]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    // Not all below threshold, so guard does not fire — check for stall normally
    // oldest=0.01, latest=0.05 → no improvement → stall
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("dimension_stall");
  });

  it("does NOT skip when only the latest entry is below threshold", () => {
    // Only last entry is 0.01; earlier entries are 0.50 — not full-window achieved
    const history = makeGapHistory([0.50, 0.50, 0.50, 0.50, 0.50, 0.01]);
    // oldest=0.50, latest=0.01 → improvement of 0.49 >= MIN_IMPROVEMENT_DELTA → null (improving)
    const result = detector.checkDimensionStall("goal-1", "dim-a", history);
    expect(result).toBeNull(); // null because of meaningful improvement, not achieved guard
  });

  // checkGlobalStall tests

  it("checkGlobalStall: returns null when all dimensions are achieved", () => {
    // Both dimensions have all-window gaps <= 0.02 → both achieved → no global stall
    const dims = new Map([
      ["dim-a", makeGapHistory([0.01, 0.01, 0.01, 0.01, 0.01, 0.01])],
      ["dim-b", makeGapHistory([0.02, 0.02, 0.02, 0.02, 0.02, 0.02])],
    ]);
    const result = detector.checkGlobalStall("goal-1", dims);
    expect(result).toBeNull();
  });

  it("checkGlobalStall: returns null when one dim achieved, one improving", () => {
    // dim-a achieved, dim-b improving — no global stall
    const dims = new Map([
      ["dim-a", makeGapHistory([0.01, 0.01, 0.01, 0.01, 0.01, 0.01])],
      ["dim-b", makeGapHistory([0.50, 0.45, 0.40, 0.35, 0.30, 0.20])], // improving by 0.30
    ]);
    const result = detector.checkGlobalStall("goal-1", dims);
    expect(result).toBeNull();
  });

  it("checkGlobalStall: returns global_stall when one dim achieved, one flat (non-achieved)", () => {
    // dim-a achieved; dim-b flat at 0.5 → non-achieved, non-improving → global stall
    const dims = new Map([
      ["dim-a", makeGapHistory([0.01, 0.01, 0.01, 0.01, 0.01, 0.01])],
      ["dim-b", makeGapHistory([0.50, 0.50, 0.50, 0.50, 0.50, 0.50])],
    ]);
    const result = detector.checkGlobalStall("goal-1", dims);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("global_stall");
    expect(result!.suggested_cause).toBe("goal_infeasible");
  });
});

// ─── ProgressPredictor integration ───

describe("StallDetector with ProgressPredictor", () => {
  let sm: StateManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sm = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("works as before (no predictor) — no regression for normal stall detection", () => {
    const det = new StallDetector(sm);
    // Flat history → normal stall
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const result = det.checkDimensionStall("g1", "d1", history);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("dimension_stall");
  });

  it("works as before (no predictor) — no false predicted stall on improving series", () => {
    const det = new StallDetector(sm);
    const history = makeGapHistory([0.8, 0.7, 0.6, 0.5, 0.4, 0.3]);
    const result = det.checkDimensionStall("g1", "d1", history);
    expect(result).toBeNull();
  });

  it("detects predicted_plateau when predictor says stable and confidence > 0.6", () => {
    const predictor = new ProgressPredictor();
    const det = new StallDetector(sm, undefined, predictor);
    // History: early improvement (oldest=0.8, latest=0.4 → diff=0.4 >= 0.05) so it
    // passes the improvement check and goes to the predictor.
    // Last 5 entries: [0.4, 0.4, 0.4, 0.4, 0.4] → slope=0, stable, R²=1.0 (confidence=1.0)
    const history = makeGapHistory([0.8, 0.4, 0.4, 0.4, 0.4, 0.4]);
    const result = det.checkDimensionStall("g1", "d1", history);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("predicted_plateau");
    expect(result!.goal_id).toBe("g1");
    expect(result!.dimension_name).toBe("d1");
  });

  it("detects predicted_regression when predictor says worsening and confidence > 0.6", () => {
    const predictor = new ProgressPredictor();
    const det = new StallDetector(sm, undefined, predictor);
    // History starts improving (oldest-latest >= 0.05) but recent tail is increasing
    // History: 0.8, 0.3, 0.4, 0.5, 0.6, 0.7 — oldest=0.8, latest=0.7, diff=0.1 >= 0.05
    // Last 5: [0.3, 0.4, 0.5, 0.6, 0.7] — slope = +0.1 (worsening), R² = 1.0
    const history = makeGapHistory([0.8, 0.3, 0.4, 0.5, 0.6, 0.7]);
    const result = det.checkDimensionStall("g1", "d1", history);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("predicted_regression");
    expect(result!.goal_id).toBe("g1");
    expect(result!.dimension_name).toBe("d1");
  });

  it("does NOT trigger predicted stall when confidence <= 0.6 (noisy data)", () => {
    const predictor = new ProgressPredictor();
    const det = new StallDetector(sm, undefined, predictor);
    // Improving overall (oldest-latest >= 0.05) but noisy trend — R² will be low
    // Use large but noisy improvement so predictor confidence is low
    const history = makeGapHistory([0.9, 0.2, 0.9, 0.2, 0.9, 0.3]);
    const result = det.checkDimensionStall("g1", "d1", history);
    // oldest=0.9, latest=0.3 → improvement=0.6 >= 0.05 → goes to predictor
    // noisy last 5: [0.2, 0.9, 0.2, 0.9, 0.3] → R² ≈ 0 → no predicted stall
    expect(result).toBeNull();
  });

  it("normal stall (dimension_stall) takes priority over predictor check", () => {
    const predictor = new ProgressPredictor();
    const det = new StallDetector(sm, undefined, predictor);
    // Flat history → falls through to normal dimension_stall, predictor never fires
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const result = det.checkDimensionStall("g1", "d1", history);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("dimension_stall"); // not predicted_plateau
  });

  it("returns null when predictor says improving (trend=improving, confidence > 0.6)", () => {
    const predictor = new ProgressPredictor();
    const det = new StallDetector(sm, undefined, predictor);
    // History: oldest=0.8, latest=0.3 → diff=0.5 >= 0.05 → passes improvement check, goes to predictor.
    // Last 5: [0.7, 0.6, 0.5, 0.4, 0.3] — monotonically decreasing → slope = -0.1 (improving)
    // trend="improving" → checkPredictedStall returns null at line 564
    const history = makeGapHistory([0.8, 0.7, 0.6, 0.5, 0.4, 0.3]);
    const result = det.checkDimensionStall("g1", "d1", history);
    expect(result).toBeNull();
  });
});

// ─── durationToHours: weeks and default fallback ───

describe("checkTimeExceeded — additional duration units", () => {
  it("handles duration in weeks correctly (estimate × 2)", () => {
    // Estimate = 1 week (168 hours) → threshold = 336 hours; started 400 hours ago → stall
    const startedAt = new Date(Date.now() - 400 * 60 * 60 * 1000).toISOString();
    const task = {
      goal_id: "goal-1",
      started_at: startedAt,
      estimated_duration: { value: 1, unit: "weeks" },
    };
    const result = detector.checkTimeExceeded(task);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("time_exceeded");
  });

  it("does not stall when within 2-week threshold (1 week estimate, 1 week elapsed)", () => {
    // Estimate = 1 week (168h) → threshold = 336h; started 100 hours ago → within threshold
    const startedAt = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const task = {
      goal_id: "goal-1",
      started_at: startedAt,
      estimated_duration: { value: 1, unit: "weeks" },
    };
    expect(detector.checkTimeExceeded(task)).toBeNull();
  });

  it("handles unknown duration unit (default fallback treats value as hours)", () => {
    // Unknown unit → value treated as hours; value=1 hour → threshold = 2 hours
    // started 3 hours ago → exceeds threshold
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const task = {
      goal_id: "goal-1",
      started_at: startedAt,
      estimated_duration: { value: 1, unit: "fortnights" }, // unknown unit
    };
    const result = detector.checkTimeExceeded(task);
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("time_exceeded");
  });

  it("does not stall for unknown unit when within fallback threshold", () => {
    // Unknown unit → value=10 hours → threshold = 20 hours; started 5 hours ago → ok
    const startedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const task = {
      goal_id: "goal-1",
      started_at: startedAt,
      estimated_duration: { value: 10, unit: "fortnights" },
    };
    expect(detector.checkTimeExceeded(task)).toBeNull();
  });
});
