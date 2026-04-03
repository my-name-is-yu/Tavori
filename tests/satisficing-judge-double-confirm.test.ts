import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { SatisficingJudge } from "../src/drive/satisficing-judge.js";
import type { Dimension } from "../src/types/goal.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";

// ─── Test Fixtures ───

function makeSatisfiedDimension(overrides: Partial<Dimension> = {}): Dimension {
  return {
    name: "dim1",
    label: "Test Dimension",
    current_value: 100,
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

// ─── P0 Guard 4: Double-Confirmation Guard ───

describe("isGoalComplete - double-confirmation guard (§4.4)", () => {
  it("first cycle all dimensions met → is_complete: false (streak = 1, not yet confirmed)", () => {
    const goal = makeGoal({
      id: "goal-dc-1",
      dimensions: [
        makeSatisfiedDimension({ name: "dim1", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    const result = judge.isGoalComplete(goal);
    expect(result.is_complete).toBe(false);
    expect(result.blocking_dimensions).toHaveLength(0);
    expect(result.low_confidence_dimensions).toHaveLength(0);
  });

  it("second consecutive cycle all dimensions met → is_complete: true (streak = 2)", () => {
    const goal = makeGoal({
      id: "goal-dc-2",
      dimensions: [
        makeSatisfiedDimension({ name: "dim1", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    // First cycle: streak = 1
    judge.isGoalComplete(goal);
    // Second cycle: streak = 2 → complete
    const result = judge.isGoalComplete(goal);
    expect(result.is_complete).toBe(true);
    expect(result.blocking_dimensions).toHaveLength(0);
    expect(result.low_confidence_dimensions).toHaveLength(0);
  });

  it("first cycle met, second cycle NOT met → is_complete: false (streak reset)", () => {
    const goal = makeGoal({
      id: "goal-dc-3",
      dimensions: [
        makeSatisfiedDimension({ name: "dim1", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    // First cycle: all met, streak = 1
    judge.isGoalComplete(goal);

    // Second cycle: dimension no longer satisfied
    goal.dimensions[0].current_value = 50;
    const result = judge.isGoalComplete(goal);
    expect(result.is_complete).toBe(false);
    expect(result.blocking_dimensions).toContain("dim1");
  });

  it("after streak is reset by a failing cycle, two fresh consecutive cycles are needed again", () => {
    const goal = makeGoal({
      id: "goal-dc-4",
      dimensions: [
        makeSatisfiedDimension({ name: "dim1", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    // First cycle: streak = 1
    judge.isGoalComplete(goal);
    // Second cycle: dimension fails → streak reset to 0
    goal.dimensions[0].current_value = 50;
    judge.isGoalComplete(goal);
    // Third cycle: dimension satisfied again → streak = 1 (not complete yet)
    goal.dimensions[0].current_value = 100;
    const third = judge.isGoalComplete(goal);
    expect(third.is_complete).toBe(false);
    // Fourth cycle: streak = 2 → complete
    const fourth = judge.isGoalComplete(goal);
    expect(fourth.is_complete).toBe(true);
  });

  it("after completion confirmed, streak is reset (next call starts fresh)", () => {
    const goal = makeGoal({
      id: "goal-dc-5",
      dimensions: [
        makeSatisfiedDimension({ name: "dim1", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    // Two cycles → confirmed complete
    judge.isGoalComplete(goal);
    const confirmed = judge.isGoalComplete(goal);
    expect(confirmed.is_complete).toBe(true);

    // Next call starts fresh (streak was deleted after confirmation)
    const afterReset = judge.isGoalComplete(goal);
    expect(afterReset.is_complete).toBe(false);
    // One more cycle → complete again
    const second = judge.isGoalComplete(goal);
    expect(second.is_complete).toBe(true);
  });

  it("different goal IDs have independent streaks", () => {
    const goalA = makeGoal({
      id: "goal-dc-a",
      dimensions: [
        makeSatisfiedDimension({ name: "dim1", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    const goalB = makeGoal({
      id: "goal-dc-b",
      dimensions: [
        makeSatisfiedDimension({ name: "dim1", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });

    // Goal A: first cycle only
    judge.isGoalComplete(goalA);
    // Goal B: two cycles
    judge.isGoalComplete(goalB);
    const bResult = judge.isGoalComplete(goalB);

    // Goal A should still be incomplete (only 1 cycle)
    const aResult = judge.isGoalComplete(goalA);
    // Goal B should be complete
    expect(bResult.is_complete).toBe(true);
    // Goal A: this was its second cycle → complete
    expect(aResult.is_complete).toBe(true);
  });

  it("streak for goal A does not affect goal B even when both progress simultaneously", () => {
    const goalA = makeGoal({
      id: "goal-ind-a",
      dimensions: [
        makeSatisfiedDimension({ name: "dim1", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    const goalB = makeGoal({
      id: "goal-ind-b",
      dimensions: [
        makeSatisfiedDimension({ name: "dim1", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });

    // Goal A gets 2 cycles
    judge.isGoalComplete(goalA);
    const aComplete = judge.isGoalComplete(goalA);
    // Goal B only gets 1 cycle
    const bFirst = judge.isGoalComplete(goalB);

    expect(aComplete.is_complete).toBe(true);
    expect(bFirst.is_complete).toBe(false);
  });

  it("judgeTreeCompletion: two separate calls are needed across two cycles (no streak bypass)", async () => {
    // Regression guard for the previous double-call bug:
    // judgeTreeCompletion used to call isGoalComplete twice in one invocation,
    // bypassing the two-cycle guard. It must now only advance the streak by 1 per call.
    const goal = makeGoal({
      id: "goal-tree-dc",
      children_ids: [],  // leaf node — delegates to isGoalComplete
      dimensions: [
        makeSatisfiedDimension({ name: "dim1", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });

    // Pre-populate the goal in stateManager so judgeTreeCompletion can load it
    await stateManager.saveGoal(goal);

    // First call — streak advances to 1, must NOT be complete yet
    const firstResult = await judge.judgeTreeCompletion("goal-tree-dc");
    expect(firstResult.is_complete).toBe(false);

    // Second call (simulating next CoreLoop cycle) — streak advances to 2, now complete
    const secondResult = await judge.judgeTreeCompletion("goal-tree-dc");
    expect(secondResult.is_complete).toBe(true);
  });

  it("multiple dimensions all satisfied → same double-confirm behavior", () => {
    const goal = makeGoal({
      id: "goal-dc-multi",
      dimensions: [
        makeSatisfiedDimension({ name: "dim1", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
        makeSatisfiedDimension({ name: "dim2", current_value: 10, threshold: { type: "max", value: 10 }, confidence: 0.9 }),
      ],
    });
    // First cycle: not complete
    const first = judge.isGoalComplete(goal);
    expect(first.is_complete).toBe(false);
    // Second cycle: complete
    const second = judge.isGoalComplete(goal);
    expect(second.is_complete).toBe(true);
  });
});
