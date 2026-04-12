import { describe, it, expect, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { LoopSupervisor } from "../executor/loop-supervisor.js";
import { JournalBackedQueue } from "../queue/journal-backed-queue.js";
import { createEnvelope } from "../types/envelope.js";
import type { LoopResult } from "../../orchestrator/loop/core-loop.js";
import { GoalLeaseManager } from "../goal-lease-manager.js";
import { StateManager } from "../../base/state/state-manager.js";
import { makeGoal } from "../../../tests/helpers/fixtures.js";

function makeLoopResult(o: Partial<LoopResult> = {}): LoopResult {
  return { goalId: "g", totalIterations: 1, finalStatus: "completed", iterations: [],
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), ...o };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

async function pollForJsonMatch<T>(
  filePath: string,
  predicate: (value: T) => boolean,
  timeoutMs = 2_000,
  intervalMs = 20
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(filePath)) {
        const value = JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
        if (predicate(value)) {
          return value;
        }
      }
    } catch {
      // Retry until stable.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for matching JSON in file: ${filePath}`);
}

function makeSupervisor(
  coreLoopImpl?: (...args: any[]) => Promise<LoopResult> | never,
  extra: Record<string, unknown> = {},
  config: Record<string, unknown> = {}
) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sv-durable-"));
  const stateFile = path.join(runtimeRoot, "supervisor-state.json");
  const journalQueue = new JournalBackedQueue({
    journalPath: path.join(runtimeRoot, "queue.json"),
  });
  const goalLeaseManager = new GoalLeaseManager(runtimeRoot, 40);
  const mockCoreLoop = { run: vi.fn().mockImplementation(coreLoopImpl ?? (() => Promise.resolve(makeLoopResult()))), stop: vi.fn() };
  const deps = {
    coreLoopFactory: () => mockCoreLoop as any,
    journalQueue,
    goalLeaseManager,
    driveSystem: { shouldActivate: vi.fn(), prioritizeGoals: vi.fn(), startWatcher: vi.fn(), stopWatcher: vi.fn(), writeEvent: vi.fn() } as any,
    stateManager: { getBaseDir: vi.fn().mockReturnValue(runtimeRoot) } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    onEscalation: vi.fn(),
    ...extra,
  };
  const supervisor = new LoopSupervisor(deps, {
    concurrency: 2,
    pollIntervalMs: 20,
    maxCrashCount: 3,
    crashBackoffBaseMs: 50,
    stateFilePath: stateFile,
    claimLeaseMs: 200,
    leaseRenewIntervalMs: 50,
    ...config,
  });
  return {
    supervisor,
    deps,
    stateFile,
    journalQueue,
    goalLeaseManager,
    mockCoreLoop,
    runtimeRoot,
  };
}

describe("LoopSupervisor", () => {
  // ─── 1. start() pushes goal_activated and workers pick them up ───

  it("start() calls coreLoop.run for initial goals", async () => {
    const { supervisor, mockCoreLoop, runtimeRoot } = makeSupervisor();
    try {
      await supervisor.start(["g1"]);
      await new Promise((r) => setTimeout(r, 80));
      await supervisor.shutdown();
      expect(mockCoreLoop.run).toHaveBeenCalledWith("g1", expect.anything());
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  // ─── 2. Goal Exclusivity: coalescing ───

  it("coalesces duplicate goal_activated via requestExtend (re-runs)", async () => {
    let callCount = 0;
    const { supervisor, mockCoreLoop, journalQueue, runtimeRoot } = makeSupervisor((async (goalId: string) => {
      callCount++;
      if (callCount === 1) {
        journalQueue.accept(createEnvelope({ type: "event", name: "goal_activated",
          source: "test", goal_id: "g1", payload: {}, priority: "normal" }));
        await new Promise((r) => setTimeout(r, 30));
      }
      return makeLoopResult({ goalId });
    }) as unknown as () => Promise<LoopResult>);
    try {
      await supervisor.start(["g1"]);
      await new Promise((r) => setTimeout(r, 200));
      await supervisor.shutdown();
      expect(mockCoreLoop.run).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  // ─── 3. Suspended goals are skipped ───

  it("goal is added to suspendedGoals after max crashes reached", async () => {
    // Use a mock coreLoop that crashes exactly maxCrashCount times
    // Then verify the goal appears in getState().suspendedGoals
    const onEscalation = vi.fn();
    let runCallCount = 0;
    const crashingLoop = {
      run: vi.fn().mockImplementation(async () => {
        runCallCount++;
        throw new Error("crash");
      }),
      stop: vi.fn(),
    };
    const { supervisor, runtimeRoot } = makeSupervisor(
      crashingLoop.run as unknown as (...args: any[]) => Promise<LoopResult>,
      {
        coreLoopFactory: () => crashingLoop as any,
        onEscalation,
      },
      { concurrency: 1, pollIntervalMs: 10, maxCrashCount: 1, crashBackoffBaseMs: 9999 }
    );
    try {
      await supervisor.start(["g-susp"]);
      const deadline = Date.now() + 1000;
      while (runCallCount === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 50));
      await supervisor.shutdown();
      expect(onEscalation).toHaveBeenCalledWith("g-susp", 1, "crash");
      expect(supervisor.getState().suspendedGoals).toContain("g-susp");
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  // ─── 4. Crash recovery re-queues under threshold ───

  it("crash under threshold increments crashCount and does not suspend", async () => {
    // Verify that after one crash (under maxCrashCount=3):
    // - crashCounts["g-retry"] === 1
    // - goal is NOT in suspendedGoals
    // - a re-queue envelope is scheduled (eventBus will receive it after backoff)
    const retryLoop = {
      run: vi.fn().mockRejectedValue(new Error("transient")),
      stop: vi.fn(),
    };
    let runCallCount = 0;
    const wrappedRun = vi.fn().mockImplementation(async (...args: unknown[]) => {
      runCallCount++;
      return retryLoop.run(...args);
    });
    const { supervisor, runtimeRoot } = makeSupervisor(
      wrappedRun as unknown as (...args: any[]) => Promise<LoopResult>,
      { coreLoopFactory: () => ({ run: wrappedRun, stop: vi.fn() }) as any },
      { concurrency: 1, pollIntervalMs: 10, maxCrashCount: 3, crashBackoffBaseMs: 9999 }
    );
    try {
      await supervisor.start(["g-retry"]);
      const deadline = Date.now() + 1000;
      while (runCallCount === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 50));
      await supervisor.shutdown();
      const state = supervisor.getState();
      expect(state.crashCounts["g-retry"]).toBe(1);
      expect(state.suspendedGoals).not.toContain("g-retry");
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("resets crash counts after a successful run", async () => {
    let runCount = 0;
    const { supervisor, runtimeRoot } = makeSupervisor(async (goalId: string) => {
      runCount += 1;
      if (runCount === 1) {
        throw new Error("transient");
      }
      return makeLoopResult({ goalId });
    });

    try {
      await supervisor.start(["g-reset"]);
      await waitFor(() => runCount >= 2, 10_000);
      await supervisor.shutdown();

      expect(supervisor.getState().crashCounts["g-reset"]).toBeUndefined();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  // ─── 5. shutdown() ───

  it("shutdown() resolves after workers complete", async () => {
    const { supervisor, runtimeRoot } = makeSupervisor();
    try {
      await supervisor.start(["g1"]);
      await new Promise((r) => setTimeout(r, 40));
      await expect(supervisor.shutdown()).resolves.toBeUndefined();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("shutdown() is safe without start()", async () => {
    const { supervisor, runtimeRoot } = makeSupervisor();
    try {
      await expect(supervisor.shutdown()).resolves.toBeUndefined();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  // ─── 6. State persistence ───

  it("writes supervisor-state.json after execution", async () => {
    const { supervisor, stateFile, runtimeRoot } = makeSupervisor();
    try {
      await supervisor.start(["g1"]);
      await new Promise((r) => setTimeout(r, 100));
      await supervisor.shutdown();
      expect(fs.existsSync(stateFile)).toBe(true);
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      expect(state).toHaveProperty("workers");
      expect(state).toHaveProperty("crashCounts");
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("does not restore suspended goals from a previous supervisor process", async () => {
    const { runtimeRoot, deps } = makeSupervisor();
    const stateFile = path.join(runtimeRoot, "supervisor-state.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        workers: [],
        crashCounts: { "g-suspended": 3 },
        suspendedGoals: ["g-suspended"],
        updatedAt: Date.now(),
      })
    );

    const recoveredSupervisor = new LoopSupervisor(deps, {
      concurrency: 1,
      pollIntervalMs: 20,
      maxCrashCount: 3,
      crashBackoffBaseMs: 50,
      stateFilePath: stateFile,
      claimLeaseMs: 200,
      leaseRenewIntervalMs: 50,
    });

    try {
      await recoveredSupervisor.start(["g-suspended"]);
      await waitFor(() => deps.coreLoopFactory().run.mock.calls.some((call: unknown[]) => call[0] === "g-suspended"));
      await recoveredSupervisor.shutdown();

      expect(recoveredSupervisor.getState().suspendedGoals).not.toContain("g-suspended");
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("persists active worker state while work is in flight", async () => {
    const { supervisor, stateFile, runtimeRoot } = makeSupervisor(async (goalId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return makeLoopResult({ goalId, totalIterations: 2 });
    });
    try {
      await supervisor.start(["g-live"]);
      const state = await pollForJsonMatch<{ workers: Array<{ goalId: string | null; startedAt: number }> }>(
        stateFile,
        (value) => value.workers.some((worker) => worker.goalId === "g-live" && worker.startedAt > 0)
      );
      expect(state.workers.some((worker) => worker.goalId === "g-live")).toBe(true);
      await supervisor.shutdown();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  // ─── 7. Concurrency limit ───

  it("runs at most N workers simultaneously", async () => {
    let concurrent = 0; let max = 0;
    const { deps, runtimeRoot } = makeSupervisor(async () => {
      concurrent++; max = Math.max(max, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return makeLoopResult();
    });
    const sv = new LoopSupervisor(deps, {
      concurrency: 2, pollIntervalMs: 20, maxCrashCount: 3,
      crashBackoffBaseMs: 50, stateFilePath: path.join(runtimeRoot, "sv-conc.json"),
      claimLeaseMs: 200,
      leaseRenewIntervalMs: 50,
    });
    try {
      await sv.start(["g1", "g2", "g3"]);
      await new Promise((r) => setTimeout(r, 200));
      await sv.shutdown();
      expect(max).toBeLessThanOrEqual(2);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  // ─── 8. Non-goal events are re-enqueued, not dropped ───

  it('non-goal events remain pending because the supervisor only claims goal activations', async () => {
    const { supervisor, journalQueue, runtimeRoot } = makeSupervisor();
    try {
      await supervisor.start([]);

      journalQueue.accept(createEnvelope({
        type: 'event',
        name: 'cron_task_due',
        source: 'test',
        goal_id: undefined,
        payload: { taskId: 'task-1' },
        priority: 'normal',
      }));

      await new Promise((r) => setTimeout(r, 60));
      await supervisor.shutdown();

      const snapshot = journalQueue.snapshot();
      expect(snapshot.pending.normal).toHaveLength(1);
      expect(snapshot.pending.normal[0]).toBeDefined();
      const queueState = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "queue.json"), "utf8"));
      expect(queueState.records[snapshot.pending.normal[0]].envelope.name).toBe('cron_task_due');
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('non-goal events do not consume idle worker slots', async () => {
    let goalRunCount = 0;
    const { supervisor, journalQueue, runtimeRoot } = makeSupervisor((async (goalId: string) => {
      goalRunCount++;
      return makeLoopResult({ goalId });
    }) as unknown as () => Promise<LoopResult>);
    try {
      await supervisor.start([]);

      journalQueue.accept(createEnvelope({
        type: 'event',
        name: 'schedule_activated',
        source: 'test',
        goal_id: undefined,
        payload: {},
        priority: 'normal',
      }));
      journalQueue.accept(createEnvelope({
        type: 'event',
        name: 'goal_activated',
        source: 'test',
        goal_id: 'g-mix',
        payload: {},
        priority: 'normal',
      }));

      await waitFor(() => {
        const snapshot = journalQueue.snapshot();
        const queueState = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "queue.json"), "utf8"));
        return (
          goalRunCount >= 1 &&
          snapshot.pending.normal
            .map((messageId) => queueState.records[messageId].envelope.name)
            .includes("schedule_activated")
        );
      });
      await supervisor.shutdown();

      expect(goalRunCount).toBeGreaterThanOrEqual(1);
      const snapshot = journalQueue.snapshot();
      const queueState = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "queue.json"), "utf8"));
      expect(
        snapshot.pending.normal.map((messageId) => queueState.records[messageId].envelope.name)
      ).toContain('schedule_activated');
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("claims durable goal activations and completes the queue record", async () => {
    const { supervisor, journalQueue, goalLeaseManager, mockCoreLoop, runtimeRoot } = makeSupervisor(async (goalId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return makeLoopResult({ goalId });
    });

    try {
      await supervisor.start(["g-durable"]);
      await waitFor(() => {
        const snapshot = journalQueue.snapshot();
        return (
          mockCoreLoop.run.mock.calls.some((call: unknown[]) => call[0] === "g-durable") &&
          snapshot.completed.length >= 1 &&
          journalQueue.inflightSize() === 0
        );
      });
      await supervisor.shutdown();

      expect(mockCoreLoop.run).toHaveBeenCalledWith("g-durable", expect.anything());
      expect(journalQueue.snapshot().completed.length).toBeGreaterThanOrEqual(1);
      expect(journalQueue.inflightSize()).toBe(0);
      expect(await goalLeaseManager.read("g-durable")).toBeNull();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("coalesces duplicate durable goal activations via requestExtend", async () => {
    let runCount = 0;
    const { supervisor, journalQueue, mockCoreLoop, runtimeRoot } = makeSupervisor(async (goalId: string) => {
      runCount += 1;
      if (runCount === 1) {
        journalQueue.accept(createEnvelope({
          type: "event",
          name: "goal_activated",
          source: "test",
          goal_id: "g-durable",
          payload: {},
          priority: "normal",
        }));
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return makeLoopResult({ goalId });
    });

    try {
      await supervisor.start(["g-durable"]);
      await waitFor(() => {
        const snapshot = journalQueue.snapshot();
        return mockCoreLoop.run.mock.calls.length >= 2 && snapshot.completed.length >= 2;
      });
      await supervisor.shutdown();

      expect(mockCoreLoop.run).toHaveBeenCalledTimes(2);
      expect(journalQueue.snapshot().completed.length).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("applies crash backoff before retrying durable activations", async () => {
    let runCount = 0;
    const { supervisor, journalQueue, runtimeRoot } = makeSupervisor(
      async () => {
        runCount += 1;
        if (runCount === 1) {
          throw new Error("boom");
        }
        return makeLoopResult({ goalId: "g-backoff" });
      },
      {},
      { crashBackoffBaseMs: 1_000 }
    );

    try {
      await supervisor.start(["g-backoff"]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(runCount).toBe(1);
      const snapshotDuringBackoff = journalQueue.snapshot();
      expect(
        snapshotDuringBackoff.pending.normal.length + Object.keys(snapshotDuringBackoff.inflight).length
      ).toBe(1);

      await waitFor(() => runCount >= 2, 3_000);
      await supervisor.shutdown();

      expect(runCount).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("does not append a duplicate durable activation when startup finds a recovered pending goal", async () => {
    const { supervisor, journalQueue, runtimeRoot } = makeSupervisor();
    journalQueue.accept(createEnvelope({
      type: "event",
      name: "goal_activated",
      source: "recovered",
      goal_id: "g-dedupe",
      payload: {},
      priority: "normal",
      dedupe_key: "goal_activated:g-dedupe",
    }));

    try {
      await supervisor.start(["g-dedupe"]);
      await waitFor(() => {
        const snapshot = journalQueue.snapshot();
        return (
          snapshot.completed.length === 1 &&
          snapshot.pending.normal.length === 0 &&
          Object.keys(snapshot.inflight).length === 0
        );
      });
      await supervisor.shutdown();

      const snapshot = journalQueue.snapshot();
      expect(snapshot.completed).toHaveLength(1);
      expect(snapshot.pending.normal).toHaveLength(0);
      expect(snapshot.inflight).toEqual({});
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("blocks state commits when durable execution ownership becomes stale", async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sv-fence-"));
    const stateDir = path.join(runtimeRoot, "state");
    const stateManager = new StateManager(stateDir);
    await stateManager.init();
    await stateManager.saveGoal(makeGoal({ id: "g-fenced", title: "before" }));

    const journalQueue = new JournalBackedQueue({
      journalPath: path.join(runtimeRoot, "queue.json"),
    });
    const goalLeaseManager = new GoalLeaseManager(runtimeRoot, 40);
    const mockCoreLoop = {
      run: vi.fn().mockImplementation(async (goalId: string) => {
        const goal = await stateManager.loadGoal(goalId);
        await new Promise((resolve) => setTimeout(resolve, 80));
        await stateManager.saveGoal({ ...goal!, title: "after" });
        return makeLoopResult({ goalId });
      }),
      stop: vi.fn(),
    };

    const supervisor = new LoopSupervisor(
      {
        coreLoopFactory: () => mockCoreLoop as any,
        journalQueue,
        goalLeaseManager,
        driveSystem: { shouldActivate: vi.fn(), prioritizeGoals: vi.fn(), startWatcher: vi.fn(), stopWatcher: vi.fn(), writeEvent: vi.fn() } as any,
        stateManager,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      },
      {
        concurrency: 1,
        pollIntervalMs: 10,
        maxCrashCount: 1,
        crashBackoffBaseMs: 9999,
        stateFilePath: path.join(runtimeRoot, "supervisor-state.json"),
        claimLeaseMs: 40,
        leaseRenewIntervalMs: 50,
      }
    );

    try {
      await supervisor.start(["g-fenced"]);
      await new Promise((resolve) => setTimeout(resolve, 220));
      await supervisor.shutdown();

      const goal = await stateManager.loadGoal("g-fenced");
      expect(goal?.title).toBe("before");
      expect(journalQueue.inflightSize()).toBe(1);
      expect(mockCoreLoop.run).toHaveBeenCalled();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("allows a second supervisor to take over after claim and lease expiry", async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sv-takeover-"));
    const stateDir = path.join(runtimeRoot, "state");
    const stateManagerA = new StateManager(stateDir);
    const stateManagerB = new StateManager(stateDir);
    await stateManagerA.init();
    await stateManagerB.init();
    await stateManagerA.saveGoal(makeGoal({ id: "g-restart", title: "seed" }));

    const journalQueue = new JournalBackedQueue({
      journalPath: path.join(runtimeRoot, "queue.json"),
    });
    const goalLeaseManager = new GoalLeaseManager(runtimeRoot, 40);

    const coreLoopA = {
      run: vi.fn().mockImplementation(async (goalId: string) => {
        const goal = await stateManagerA.loadGoal(goalId);
        await new Promise((resolve) => setTimeout(resolve, 120));
        await stateManagerA.saveGoal({ ...goal!, title: "first-owner" });
        return makeLoopResult({ goalId });
      }),
      stop: vi.fn(),
    };
    const coreLoopB = {
      run: vi.fn().mockImplementation(async (goalId: string) => {
        const goal = await stateManagerB.loadGoal(goalId);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await stateManagerB.saveGoal({ ...goal!, title: "second-owner" });
        return makeLoopResult({ goalId });
      }),
      stop: vi.fn(),
    };

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    const supervisorA = new LoopSupervisor(
      {
        coreLoopFactory: () => coreLoopA as any,
        journalQueue,
        goalLeaseManager,
        driveSystem: { shouldActivate: vi.fn(), prioritizeGoals: vi.fn(), startWatcher: vi.fn(), stopWatcher: vi.fn(), writeEvent: vi.fn() } as any,
        stateManager: stateManagerA,
        logger,
      },
      {
        concurrency: 1,
        pollIntervalMs: 10,
        maxCrashCount: 3,
        crashBackoffBaseMs: 9999,
        stateFilePath: path.join(runtimeRoot, "supervisor-a.json"),
        claimLeaseMs: 40,
        leaseRenewIntervalMs: 1000,
      }
    );
    const supervisorB = new LoopSupervisor(
      {
        coreLoopFactory: () => coreLoopB as any,
        journalQueue,
        goalLeaseManager,
        driveSystem: { shouldActivate: vi.fn(), prioritizeGoals: vi.fn(), startWatcher: vi.fn(), stopWatcher: vi.fn(), writeEvent: vi.fn() } as any,
        stateManager: stateManagerB,
        logger,
      },
      {
        concurrency: 1,
        pollIntervalMs: 10,
        maxCrashCount: 3,
        crashBackoffBaseMs: 9999,
        stateFilePath: path.join(runtimeRoot, "supervisor-b.json"),
        claimLeaseMs: 200,
        leaseRenewIntervalMs: 50,
      }
    );

    try {
      await supervisorA.start(["g-restart"]);
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(journalQueue.sweepExpiredClaims().reclaimed).toBe(1);

      await supervisorB.start([]);
      await new Promise((resolve) => setTimeout(resolve, 260));

      await supervisorA.shutdown();
      await supervisorB.shutdown();

      const finalGoal = await stateManagerA.loadGoal("g-restart");
      expect(finalGoal?.title).toBe("second-owner");
      expect(coreLoopA.run).toHaveBeenCalledTimes(1);
      expect(coreLoopB.run).toHaveBeenCalledTimes(1);
      expect(journalQueue.snapshot().completed).toHaveLength(1);
      expect(journalQueue.inflightSize()).toBe(0);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
});
