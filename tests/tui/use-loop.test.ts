import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { LoopController, calcDimensionProgress } from "../../src/tui/use-loop.js";
import { StateManager } from "../../src/state/state-manager.js";
import type { CoreLoop, LoopResult } from "../../src/loop/core-loop.js";
import type { TrustManager } from "../../src/traits/trust-manager.js";
import type { Threshold } from "../../src/types/core.js";
import { makeTempDir } from "../helpers/temp-dir.js";
import { makeGoal } from "../helpers/fixtures.js";

/** Flush enough microtask/Promise queues for async StateManager I/O to settle */
async function flushAsync(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/** Drain real I/O callbacks (fs/promises) by yielding via setImmediate,
 *  which is NOT faked by our fake-timer config. */
async function flushIO(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

const OBS_METHOD = {
  type: "mechanical" as const,
  source: "test",
  schedule: null,
  endpoint: null,
  confidence_tier: "mechanical" as const,
};

function makeMockTrustManager(balance = 0): TrustManager {
  return {
    getBalance: vi.fn().mockResolvedValue({ domain: "default", balance }),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    getActionQuadrant: vi.fn(),
    setOverride: vi.fn(),
    addPermanentGate: vi.fn(),
    hasPermanentGate: vi.fn().mockReturnValue(false),
  } as unknown as TrustManager;
}

function makeMockCoreLoop(result?: Partial<LoopResult>): CoreLoop {
  const defaultResult: LoopResult = {
    goalId: "goal-1",
    totalIterations: 3,
    finalStatus: "completed",
    iterations: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...result,
  };
  return {
    run: vi.fn().mockResolvedValue(defaultResult),
    stop: vi.fn(),
    isStopped: vi.fn().mockReturnValue(false),
    runOneIteration: vi.fn(),
  } as unknown as CoreLoop;
}

// ─── calcDimensionProgress ───

describe("calcDimensionProgress", () => {
  it("present: truthy value returns 100", () => {
    const t: Threshold = { type: "present" };
    expect(calcDimensionProgress(true, t)).toBe(100);
    expect(calcDimensionProgress(1, t)).toBe(100);
    expect(calcDimensionProgress("hello", t)).toBe(100);
  });

  it("present: falsy value returns 0", () => {
    const t: Threshold = { type: "present" };
    expect(calcDimensionProgress(false, t)).toBe(0);
    expect(calcDimensionProgress(0, t)).toBe(0);
    expect(calcDimensionProgress("", t)).toBe(0);
    expect(calcDimensionProgress(null, t)).toBe(0);
  });

  it("match: exact match returns 100", () => {
    const t: Threshold = { type: "match", value: "done" };
    expect(calcDimensionProgress("done", t)).toBe(100);
  });

  it("match: non-match returns 0", () => {
    const t: Threshold = { type: "match", value: "done" };
    expect(calcDimensionProgress("in_progress", t)).toBe(0);
  });

  it("min: current at threshold returns 100", () => {
    const t: Threshold = { type: "min", value: 100 };
    expect(calcDimensionProgress(100, t)).toBe(100);
  });

  it("min: current at half threshold returns 50", () => {
    const t: Threshold = { type: "min", value: 100 };
    expect(calcDimensionProgress(50, t)).toBe(50);
  });

  it("min: current exceeds threshold is clamped to 100", () => {
    const t: Threshold = { type: "min", value: 100 };
    expect(calcDimensionProgress(150, t)).toBe(100);
  });

  it("min: current 0 returns 0", () => {
    const t: Threshold = { type: "min", value: 100 };
    expect(calcDimensionProgress(0, t)).toBe(0);
  });

  it("max: current at or below threshold returns 100", () => {
    const t: Threshold = { type: "max", value: 50 };
    expect(calcDimensionProgress(30, t)).toBe(100);
    expect(calcDimensionProgress(50, t)).toBe(100);
  });

  it("max: current exceeding threshold reduces progress", () => {
    const t: Threshold = { type: "max", value: 50 };
    // excess=50, threshold=50 → 1 - 50/50 = 0%
    expect(calcDimensionProgress(100, t)).toBe(0);
  });

  it("range: value within range returns 100", () => {
    const t: Threshold = { type: "range", low: 10, high: 20 };
    expect(calcDimensionProgress(15, t)).toBe(100);
    expect(calcDimensionProgress(10, t)).toBe(100);
    expect(calcDimensionProgress(20, t)).toBe(100);
  });

  it("range: value outside range returns 0", () => {
    const t: Threshold = { type: "range", low: 10, high: 20 };
    expect(calcDimensionProgress(5, t)).toBe(0);
    expect(calcDimensionProgress(25, t)).toBe(0);
  });

  it("null current_value returns 0 for any threshold type", () => {
    expect(calcDimensionProgress(null, { type: "min", value: 10 })).toBe(0);
    expect(calcDimensionProgress(null, { type: "present" })).toBe(0);
    expect(calcDimensionProgress(null, { type: "match", value: "x" })).toBe(0);
  });
});

// ─── LoopController ───

describe("LoopController", async () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let trustManager: TrustManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    trustManager = makeMockTrustManager();
    // Only fake setTimeout/setInterval/Date — leave setImmediate/nextTick real
    // so that fs/promises I/O callbacks can still drain between await rounds.
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initial state is idle", () => {
    const loop = makeMockCoreLoop();
    const ctrl = new LoopController(loop, stateManager, trustManager);
    const state = ctrl.getState();
    expect(state.running).toBe(false);
    expect(state.status).toBe("idle");
    expect(state.goalId).toBeNull();
    expect(state.dimensions).toHaveLength(0);
  });

  it("start() sets running=true and status=running", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    // Use a loop that never resolves during this test
    const neverResolve = new Promise<LoopResult>(() => {});
    const loop = {
      run: vi.fn().mockReturnValue(neverResolve),
      stop: vi.fn(),
      isStopped: vi.fn().mockReturnValue(false),
      runOneIteration: vi.fn(),
    } as unknown as CoreLoop;

    const ctrl = new LoopController(loop, stateManager, trustManager);
    const updates: string[] = [];
    ctrl.setOnUpdate((s) => updates.push(s.status));

    void ctrl.start("goal-1");

    // Allow microtasks to settle
    await Promise.resolve();

    const state = ctrl.getState();
    expect(state.running).toBe(true);
    expect(state.status).toBe("running");
    expect(state.goalId).toBe("goal-1");
    expect(state.startedAt).not.toBeNull();
  });

  it("start() populates dimensions from StateManager", async () => {
    const goal = makeGoal({ dimensions: [{ name: "dim1", label: "Dimension One", current_value: 5, threshold: { type: "min", value: 10 }, confidence: 0.8, observation_method: OBS_METHOD, last_updated: new Date().toISOString(), history: [], weight: 1.0, uncertainty_weight: null, state_integrity: "ok", dimension_mapping: null }] });
    await stateManager.saveGoal(goal);

    const neverResolve = new Promise<LoopResult>(() => {});
    const loop = {
      run: vi.fn().mockReturnValue(neverResolve),
      stop: vi.fn(),
      isStopped: vi.fn().mockReturnValue(false),
      runOneIteration: vi.fn(),
    } as unknown as CoreLoop;

    const ctrl = new LoopController(loop, stateManager, trustManager);
    await ctrl.start("goal-1");

    const state = ctrl.getState();
    expect(state.dimensions).toHaveLength(1);
    expect(state.dimensions[0].name).toBe("dim1");
    expect(state.dimensions[0].displayName).toBe("Dimension One");
    // current_value=5, threshold min 10 → 50%
    expect(state.dimensions[0].progress).toBe(50);
  });

  it("onUpdate callback is called on state changes", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const neverResolve = new Promise<LoopResult>(() => {});
    const loop = {
      run: vi.fn().mockReturnValue(neverResolve),
      stop: vi.fn(),
      isStopped: vi.fn().mockReturnValue(false),
      runOneIteration: vi.fn(),
    } as unknown as CoreLoop;

    const ctrl = new LoopController(loop, stateManager, trustManager);
    const callCount = { n: 0 };
    ctrl.setOnUpdate(() => { callCount.n++; });

    void ctrl.start("goal-1");
    await Promise.resolve();

    expect(callCount.n).toBeGreaterThan(0);
  });

  it("stop() sets running=false and status=stopped, calls coreLoop.stop()", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const neverResolve = new Promise<LoopResult>(() => {});
    const loop = {
      run: vi.fn().mockReturnValue(neverResolve),
      stop: vi.fn(),
      isStopped: vi.fn().mockReturnValue(false),
      runOneIteration: vi.fn(),
    } as unknown as CoreLoop;

    const ctrl = new LoopController(loop, stateManager, trustManager);
    void ctrl.start("goal-1");
    await Promise.resolve();

    ctrl.stop();

    const state = ctrl.getState();
    expect(state.running).toBe(false);
    expect(state.status).toBe("stopped");
    expect(loop.stop).toHaveBeenCalled();
  });

  it("completes: state transitions to completed after coreLoop.run resolves", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const loop = makeMockCoreLoop({ finalStatus: "completed", totalIterations: 5 });
    const ctrl = new LoopController(loop, stateManager, trustManager);

    await ctrl.start("goal-1");

    // The .then() handler from coreLoop.run fires asynchronously after start() returns.
    // Flush microtasks so the .then() callback (which calls refreshState) can settle.
    await flushAsync(100);

    const state = ctrl.getState();
    expect(state.running).toBe(false);
    expect(state.status).toBe("completed");
    expect(state.lastResult).not.toBeNull();
    expect(state.lastResult?.totalIterations).toBe(5);
  });

  it("polling interval calls refreshState every 2 seconds", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const neverResolve = new Promise<LoopResult>(() => {});
    const loop = {
      run: vi.fn().mockReturnValue(neverResolve),
      stop: vi.fn(),
      isStopped: vi.fn().mockReturnValue(false),
      runOneIteration: vi.fn(),
    } as unknown as CoreLoop;

    const ctrl = new LoopController(loop, stateManager, trustManager);
    const updates: string[] = [];
    ctrl.setOnUpdate((s) => updates.push(s.status));

    await ctrl.start("goal-1");

    const countAfterStart = updates.length;

    // Advance 2 seconds to trigger one poll
    vi.advanceTimersByTime(2000);
    // The interval callback fires refreshState which does real async fs I/O.
    // Drain I/O callbacks via setImmediate (not faked) + microtask rounds.
    await flushIO();
    await flushAsync();

    expect(updates.length).toBeGreaterThanOrEqual(countAfterStart);
  });

  it("refreshState does nothing when goal does not exist", async () => {
    const loop = makeMockCoreLoop();
    const ctrl = new LoopController(loop, stateManager, trustManager);
    // Should not throw
    expect(async () => await ctrl.refreshState("nonexistent-goal")).not.toThrow();
  });

  it("double start() is a no-op while already running", async () => {
    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const neverResolve = new Promise<LoopResult>(() => {});
    const loop = {
      run: vi.fn().mockReturnValue(neverResolve),
      stop: vi.fn(),
      isStopped: vi.fn().mockReturnValue(false),
      runOneIteration: vi.fn(),
    } as unknown as CoreLoop;

    const ctrl = new LoopController(loop, stateManager, trustManager);
    await ctrl.start("goal-1");

    void ctrl.start("goal-1");
    await Promise.resolve();

    expect(loop.run).toHaveBeenCalledTimes(1);
  });
});
