import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state/state-manager.js";
import { SatisficingJudge } from "../src/drive/satisficing-judge.js";
import type { Goal, Dimension } from "../src/types/goal.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";

// ─── Fixtures ───

function makeDimension(overrides: Partial<Dimension> = {}): Dimension {
  return {
    name: "test_dim",
    label: "Test Dimension",
    current_value: 30,
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

/**
 * Write task history entries for a goal into the StateManager backing directory.
 * Each entry mimics the format written by await TaskLifecycle.appendTaskHistory().
 */
async function writeTaskHistory(
  stateManager: StateManager,
  goalId: string,
  entries: Array<{
    primary_dimension: string;
    actual_elapsed_ms: number | null;
    estimated_duration_ms: number | null;
    status?: string;
  }>
): Promise<void> {
  const history = entries.map((e, i) => ({
    task_id: `task-${i}`,
    status: e.status ?? "completed",
    primary_dimension: e.primary_dimension,
    consecutive_failure_count: 0,
    completed_at: new Date().toISOString(),
    actual_elapsed_ms: e.actual_elapsed_ms,
    estimated_duration_ms: e.estimated_duration_ms,
  }));
  await stateManager.writeRaw(`tasks/${goalId}/task-history.json`, history);
}

// ─── Setup ───

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

// ─── Tests ───

describe("Condition 3: resource undershoot", () => {
  it("triggers when 3+ tasks complete at <50% of estimated time and progress <50%", async () => {
    // current_value=30, threshold min=100 → progress=30%
    const goal = makeGoal({
      dimensions: [makeDimension({ current_value: 30, threshold: { type: "min", value: 100 } })],
    });
    await stateManager.saveGoal(goal);

    // 3 tasks: actual=20min, estimated=60min (actual is ~33% of estimated → undershoot)
    await writeTaskHistory(stateManager, goal.id, [
      { primary_dimension: "test_dim", actual_elapsed_ms: 20 * 60_000, estimated_duration_ms: 60 * 60_000 },
      { primary_dimension: "test_dim", actual_elapsed_ms: 18 * 60_000, estimated_duration_ms: 60 * 60_000 },
      { primary_dimension: "test_dim", actual_elapsed_ms: 22 * 60_000, estimated_duration_ms: 60 * 60_000 },
    ]);

    const proposals = await judge.detectThresholdAdjustmentNeeded(goal, new Map());

    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.reason).toBe("resource_undershoot");
    expect(p.dimension_name).toBe("test_dim");
    expect(p.goal_id).toBe(goal.id);
  });

  it("does NOT trigger when fewer than 3 tasks have timing data", async () => {
    const goal = makeGoal({
      dimensions: [makeDimension({ current_value: 30, threshold: { type: "min", value: 100 } })],
    });
    await stateManager.saveGoal(goal);

    // Only 2 tasks — not enough
    await writeTaskHistory(stateManager, goal.id, [
      { primary_dimension: "test_dim", actual_elapsed_ms: 10 * 60_000, estimated_duration_ms: 60 * 60_000 },
      { primary_dimension: "test_dim", actual_elapsed_ms: 12 * 60_000, estimated_duration_ms: 60 * 60_000 },
    ]);

    const proposals = await judge.detectThresholdAdjustmentNeeded(goal, new Map());
    const undershootProposals = proposals.filter((p) => p.reason === "resource_undershoot");
    expect(undershootProposals).toHaveLength(0);
  });

  it("does NOT trigger when actual time is >= 50% of estimated (no undershoot)", async () => {
    const goal = makeGoal({
      dimensions: [makeDimension({ current_value: 30, threshold: { type: "min", value: 100 } })],
    });
    await stateManager.saveGoal(goal);

    // actual=55min, estimated=60min → ~92% of estimated → no undershoot
    await writeTaskHistory(stateManager, goal.id, [
      { primary_dimension: "test_dim", actual_elapsed_ms: 55 * 60_000, estimated_duration_ms: 60 * 60_000 },
      { primary_dimension: "test_dim", actual_elapsed_ms: 58 * 60_000, estimated_duration_ms: 60 * 60_000 },
      { primary_dimension: "test_dim", actual_elapsed_ms: 52 * 60_000, estimated_duration_ms: 60 * 60_000 },
    ]);

    const proposals = await judge.detectThresholdAdjustmentNeeded(goal, new Map());
    const undershootProposals = proposals.filter((p) => p.reason === "resource_undershoot");
    expect(undershootProposals).toHaveLength(0);
  });

  it("does NOT trigger when progress >= 50% (goal not stagnant)", async () => {
    // current_value=80, threshold min=100 → progress=80%
    const goal = makeGoal({
      dimensions: [makeDimension({ current_value: 80, threshold: { type: "min", value: 100 } })],
    });
    await stateManager.saveGoal(goal);

    // Tasks are undershooting time-wise, but goal is already 80% done
    await writeTaskHistory(stateManager, goal.id, [
      { primary_dimension: "test_dim", actual_elapsed_ms: 10 * 60_000, estimated_duration_ms: 60 * 60_000 },
      { primary_dimension: "test_dim", actual_elapsed_ms: 12 * 60_000, estimated_duration_ms: 60 * 60_000 },
      { primary_dimension: "test_dim", actual_elapsed_ms: 11 * 60_000, estimated_duration_ms: 60 * 60_000 },
    ]);

    const proposals = await judge.detectThresholdAdjustmentNeeded(goal, new Map());
    const undershootProposals = proposals.filter((p) => p.reason === "resource_undershoot");
    expect(undershootProposals).toHaveLength(0);
  });

  it("proposal has reason='resource_undershoot' and proposed_threshold = 85% of current", async () => {
    const goal = makeGoal({
      dimensions: [makeDimension({ current_value: 10, threshold: { type: "min", value: 200 } })],
    });
    await stateManager.saveGoal(goal);

    await writeTaskHistory(stateManager, goal.id, [
      { primary_dimension: "test_dim", actual_elapsed_ms: 5 * 60_000, estimated_duration_ms: 60 * 60_000 },
      { primary_dimension: "test_dim", actual_elapsed_ms: 6 * 60_000, estimated_duration_ms: 60 * 60_000 },
      { primary_dimension: "test_dim", actual_elapsed_ms: 4 * 60_000, estimated_duration_ms: 60 * 60_000 },
    ]);

    const proposals = await judge.detectThresholdAdjustmentNeeded(goal, new Map());
    const p = proposals.find((p) => p.reason === "resource_undershoot");
    expect(p).toBeDefined();
    expect(p!.reason).toBe("resource_undershoot");
    expect(p!.current_threshold).toBe(200);
    expect(p!.proposed_threshold).toBeCloseTo(200 * 0.85, 5);
    expect(p!.evidence).toContain("goal progress at");
    expect(p!.evidence).toContain("ms estimated");
  });

  it("ignores history entries with null timing data (treats as no timing available)", async () => {
    const goal = makeGoal({
      dimensions: [makeDimension({ current_value: 30, threshold: { type: "min", value: 100 } })],
    });
    await stateManager.saveGoal(goal);

    // Mix: 2 with timing, 3 without — should NOT trigger (need 3 with timing)
    await writeTaskHistory(stateManager, goal.id, [
      { primary_dimension: "test_dim", actual_elapsed_ms: 10 * 60_000, estimated_duration_ms: 60 * 60_000 },
      { primary_dimension: "test_dim", actual_elapsed_ms: null, estimated_duration_ms: null },
      { primary_dimension: "test_dim", actual_elapsed_ms: null, estimated_duration_ms: null },
      { primary_dimension: "test_dim", actual_elapsed_ms: null, estimated_duration_ms: null },
      { primary_dimension: "test_dim", actual_elapsed_ms: 12 * 60_000, estimated_duration_ms: 60 * 60_000 },
    ]);

    const proposals = await judge.detectThresholdAdjustmentNeeded(goal, new Map());
    const undershootProposals = proposals.filter((p) => p.reason === "resource_undershoot");
    expect(undershootProposals).toHaveLength(0);
  });

  it("ignores history entries with zero estimated_duration_ms", async () => {
    const goal = makeGoal({
      dimensions: [makeDimension({ current_value: 30, threshold: { type: "min", value: 100 } })],
    });
    await stateManager.saveGoal(goal);

    // 3 entries but estimated=0 → filtered out by > 0 guard
    await writeTaskHistory(stateManager, goal.id, [
      { primary_dimension: "test_dim", actual_elapsed_ms: 1, estimated_duration_ms: 0 },
      { primary_dimension: "test_dim", actual_elapsed_ms: 1, estimated_duration_ms: 0 },
      { primary_dimension: "test_dim", actual_elapsed_ms: 1, estimated_duration_ms: 0 },
    ]);

    const proposals = await judge.detectThresholdAdjustmentNeeded(goal, new Map());
    const undershootProposals = proposals.filter((p) => p.reason === "resource_undershoot");
    expect(undershootProposals).toHaveLength(0);
  });
});

describe("Regression: conditions 1 and 2 still work after condition 3 addition", () => {
  it("condition 1 (high_failure_no_progress) still fires with >= 3 failures and < 10% progress", async () => {
    const goal = makeGoal({
      dimensions: [makeDimension({ current_value: 1, threshold: { type: "min", value: 100 } })],
    });
    await stateManager.saveGoal(goal);

    const failureCounts = new Map([["test_dim", 5]]);
    const proposals = await judge.detectThresholdAdjustmentNeeded(goal, failureCounts);

    const cond1 = proposals.find((p) => p.reason === "high_failure_no_progress");
    expect(cond1).toBeDefined();
    expect(cond1!.dimension_name).toBe("test_dim");
  });

  it("condition 2 (bottleneck_dimension) still fires when all other dims satisfied and this one < 30%", async () => {
    const goal = makeGoal({
      dimensions: [
        makeDimension({ name: "dim_a", current_value: 100, threshold: { type: "min", value: 100 } }),
        makeDimension({ name: "dim_b", current_value: 20, threshold: { type: "min", value: 100 } }),
      ],
    });
    await stateManager.saveGoal(goal);

    const proposals = await judge.detectThresholdAdjustmentNeeded(goal, new Map());
    const cond2 = proposals.find((p) => p.reason === "bottleneck_dimension");
    expect(cond2).toBeDefined();
    expect(cond2!.dimension_name).toBe("dim_b");
  });

  it("condition 3 coexists with condition 1 without duplication", async () => {
    // Dim has 3+ failures AND task history with undershoot — condition 1 fires first,
    // condition 3 should NOT add a duplicate proposal for the same dimension.
    const goal = makeGoal({
      dimensions: [makeDimension({ current_value: 1, threshold: { type: "min", value: 100 } })],
    });
    await stateManager.saveGoal(goal);

    await writeTaskHistory(stateManager, goal.id, [
      { primary_dimension: "test_dim", actual_elapsed_ms: 5 * 60_000, estimated_duration_ms: 60 * 60_000 },
      { primary_dimension: "test_dim", actual_elapsed_ms: 5 * 60_000, estimated_duration_ms: 60 * 60_000 },
      { primary_dimension: "test_dim", actual_elapsed_ms: 5 * 60_000, estimated_duration_ms: 60 * 60_000 },
    ]);

    const failureCounts = new Map([["test_dim", 5]]);
    const proposals = await judge.detectThresholdAdjustmentNeeded(goal, failureCounts);

    // Only one proposal per dimension (condition 1 fires first, condition 3 skips)
    const dimProposals = proposals.filter((p) => p.dimension_name === "test_dim");
    expect(dimProposals).toHaveLength(1);
  });
});
