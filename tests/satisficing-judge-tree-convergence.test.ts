import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { SatisficingJudge } from "../src/drive/satisficing-judge.js";
import type { SatisficingStatus } from "../src/types/satisficing.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal, makeDimension } from "./helpers/fixtures.js";

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

// ─── Helpers ───

function makeConvergenceMap(entries: [string, SatisficingStatus][]): Map<string, SatisficingStatus> {
  return new Map(entries);
}

// ─── Tests ───

describe("judgeTreeCompletion: converged_satisficed propagation", () => {
  it("leaf node with converged_satisficed in convergenceStatuses map → is_complete: true", async () => {
    // Leaf goal with an unsatisfied dimension (current_value=5, threshold=min 100)
    const leaf = makeGoal({
      id: "leaf-1",
      children_ids: [],
      dimensions: [
        makeDimension({ name: "dim1", current_value: 5, threshold: { type: "min", value: 100 } }),
      ],
    });
    await stateManager.saveGoal(leaf);

    // Provide convergenceStatuses marking "leaf-1:dim1" as converged_satisficed
    const convergenceStatuses = makeConvergenceMap([["leaf-1:dim1", "converged_satisficed"]]);

    // Two calls required: double-confirmation guard applies even for converged_satisficed.
    await judge.judgeTreeCompletion("leaf-1", convergenceStatuses);  // first cycle: streak=1
    const result = await judge.judgeTreeCompletion("leaf-1", convergenceStatuses);  // second cycle: confirmed

    expect(result.is_complete).toBe(true);
    expect(result.blocking_dimensions).toHaveLength(0);
  });

  it("leaf node with converged_satisficed but no map supplied → is_complete: false (regression guard)", async () => {
    // Same unsatisfied dimension — without the map it must remain incomplete
    const leaf = makeGoal({
      id: "leaf-2",
      children_ids: [],
      dimensions: [
        makeDimension({ name: "dim1", current_value: 5, threshold: { type: "min", value: 100 } }),
      ],
    });
    await stateManager.saveGoal(leaf);

    // No convergenceStatuses passed
    const result = await judge.judgeTreeCompletion("leaf-2");

    expect(result.is_complete).toBe(false);
    expect(result.blocking_dimensions).toContain("dim1");
  });

  it("multi-level tree: child leaf has converged_satisficed → root returns is_complete: true", async () => {
    const leaf = makeGoal({
      id: "leaf-3",
      children_ids: [],
      dimensions: [
        makeDimension({ name: "progress", current_value: 3, threshold: { type: "min", value: 10 } }),
      ],
    });
    const root = makeGoal({
      id: "root-3",
      children_ids: ["leaf-3"],
      dimensions: [],
    });
    await stateManager.saveGoal(leaf);
    await stateManager.saveGoal(root);

    const convergenceStatuses = makeConvergenceMap([["leaf-3:progress", "converged_satisficed"]]);

    const result = await judge.judgeTreeCompletion("root-3", convergenceStatuses);

    expect(result.is_complete).toBe(true);
    expect(result.blocking_dimensions).toHaveLength(0);
  });

  it("tree with mixed children: one satisficed normally, one via converged_satisficed → root complete", async () => {
    // child-a: normally satisfied (current_value meets threshold)
    const childA = makeGoal({
      id: "child-a",
      children_ids: [],
      dimensions: [
        makeDimension({ name: "dim_a", current_value: 100, threshold: { type: "min", value: 100 }, confidence: 0.9 }),
      ],
    });
    // child-b: unsatisfied threshold, but converged_satisficed in the map
    const childB = makeGoal({
      id: "child-b",
      children_ids: [],
      dimensions: [
        makeDimension({ name: "dim_b", current_value: 7, threshold: { type: "min", value: 20 } }),
      ],
    });
    const root = makeGoal({
      id: "root-mix",
      children_ids: ["child-a", "child-b"],
      dimensions: [],
    });
    await stateManager.saveGoal(childA);
    await stateManager.saveGoal(childB);
    await stateManager.saveGoal(root);

    const convergenceStatuses = makeConvergenceMap([["child-b:dim_b", "converged_satisficed"]]);

    const result = await judge.judgeTreeCompletion("root-mix", convergenceStatuses);

    expect(result.is_complete).toBe(true);
    expect(result.blocking_dimensions).toHaveLength(0);
  });
});
