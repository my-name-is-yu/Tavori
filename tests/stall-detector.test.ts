import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state-manager.js";
import { StallDetector } from "../src/stall-detector.js";
import type { StallState } from "../src/types/stall.js";

// ─── Test helpers ───

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `motiva-stall-test-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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

  it("uses N=3 for 'immediate' feedback category", () => {
    // N=3 means need 4 entries; flat over 4 entries → stall
    const history = makeGapHistory([0.5, 0.5, 0.5, 0.5]);
    const result = detector.checkDimensionStall("goal-1", "dim-a", history, "immediate");
    expect(result).not.toBeNull();
    expect(result!.stall_type).toBe("dimension_stall");
  });

  it("uses N=3 for 'immediate': improving over 4 entries → no stall", () => {
    const history = makeGapHistory([0.5, 0.4, 0.3, 0.2]);
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
  it("returns default state when no state persisted", () => {
    const state = detector.getStallState("goal-1");
    expect(state.goal_id).toBe("goal-1");
    expect(state.dimension_escalation).toEqual({});
    expect(state.global_escalation).toBe(0);
    expect(state.decay_factors).toEqual({});
    expect(state.recovery_loops).toEqual({});
  });

  it("round-trips: save and load StallState", () => {
    const stateToSave: StallState = {
      goal_id: "goal-2",
      dimension_escalation: { "dim-a": 2, "dim-b": 1 },
      global_escalation: 1,
      decay_factors: { "dim-a": 0.6 },
      recovery_loops: { "dim-b": 3 },
    };

    detector.saveStallState("goal-2", stateToSave);
    const loaded = detector.getStallState("goal-2");

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
  it("returns 0 for a fresh goal/dimension", () => {
    expect(detector.getEscalationLevel("goal-1", "dim-a")).toBe(0);
  });

  it("increments escalation level from 0 to 1", () => {
    const newLevel = detector.incrementEscalation("goal-1", "dim-a");
    expect(newLevel).toBe(1);
    expect(detector.getEscalationLevel("goal-1", "dim-a")).toBe(1);
  });

  it("increments escalation level through full lifecycle", () => {
    expect(detector.incrementEscalation("goal-1", "dim-a")).toBe(1);
    expect(detector.incrementEscalation("goal-1", "dim-a")).toBe(2);
    expect(detector.incrementEscalation("goal-1", "dim-a")).toBe(3);
  });

  it("caps escalation at 3", () => {
    detector.incrementEscalation("goal-1", "dim-a");
    detector.incrementEscalation("goal-1", "dim-a");
    detector.incrementEscalation("goal-1", "dim-a");
    const capped = detector.incrementEscalation("goal-1", "dim-a"); // attempt 4th
    expect(capped).toBe(3);
    expect(detector.getEscalationLevel("goal-1", "dim-a")).toBe(3);
  });

  it("resets escalation to 0", () => {
    detector.incrementEscalation("goal-1", "dim-a");
    detector.incrementEscalation("goal-1", "dim-a");
    detector.resetEscalation("goal-1", "dim-a");
    expect(detector.getEscalationLevel("goal-1", "dim-a")).toBe(0);
  });

  it("does not affect other dimensions when resetting", () => {
    detector.incrementEscalation("goal-1", "dim-a");
    detector.incrementEscalation("goal-1", "dim-b");
    detector.resetEscalation("goal-1", "dim-a");
    expect(detector.getEscalationLevel("goal-1", "dim-a")).toBe(0);
    expect(detector.getEscalationLevel("goal-1", "dim-b")).toBe(1);
  });

  it("persists escalation across detector instances", () => {
    detector.incrementEscalation("goal-1", "dim-a");
    detector.incrementEscalation("goal-1", "dim-a");

    // Create a new detector using the same stateManager
    const detector2 = new StallDetector(stateManager);
    expect(detector2.getEscalationLevel("goal-1", "dim-a")).toBe(2);
  });

  it("escalation is independent per goal", () => {
    detector.incrementEscalation("goal-1", "dim-a");
    detector.incrementEscalation("goal-1", "dim-a");
    expect(detector.getEscalationLevel("goal-2", "dim-a")).toBe(0);
  });

  it("can increment multiple dimensions independently", () => {
    detector.incrementEscalation("goal-1", "dim-a");
    detector.incrementEscalation("goal-1", "dim-a");
    detector.incrementEscalation("goal-1", "dim-b");
    expect(detector.getEscalationLevel("goal-1", "dim-a")).toBe(2);
    expect(detector.getEscalationLevel("goal-1", "dim-b")).toBe(1);
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
