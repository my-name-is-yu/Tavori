import { describe, it, expect, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { LoopSupervisor } from "../executor/loop-supervisor.js";
import { EventBus } from "../queue/event-bus.js";
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

function makeSupervisor(coreLoopImpl?: (...args: any[]) => Promise<LoopResult> | never, extra: Record<string, unknown> = {}) {
  const stateFile = path.join(os.tmpdir(), `sv-${Date.now()}-${Math.random()}.json`);
  const eventBus = new EventBus();
  const mockCoreLoop = { run: vi.fn().mockImplementation(coreLoopImpl ?? (() => Promise.resolve(makeLoopResult()))), stop: vi.fn() };
  const deps = {
    coreLoopFactory: () => mockCoreLoop as any,
    eventBus,
    driveSystem: { shouldActivate: vi.fn(), prioritizeGoals: vi.fn(), startWatcher: vi.fn(), stopWatcher: vi.fn(), writeEvent: vi.fn() } as any,
    stateManager: { getBaseDir: vi.fn().mockReturnValue(os.tmpdir()) } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    onEscalation: vi.fn(),
    ...extra,
  };
  const supervisor = new LoopSupervisor(deps, {
    concurrency: 2, pollIntervalMs: 20, maxCrashCount: 3,
    crashBackoffBaseMs: 50, stateFilePath: stateFile,
  });
  return { supervisor, deps, eventBus: deps.eventBus as EventBus, mockCoreLoop, stateFile, onEscalation: deps.onEscalation };
}

function makeDurableSupervisor(coreLoopImpl?: (...args: any[]) => Promise<LoopResult> | never, extra: Record<string, unknown> = {}) {
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
  });
  return {
    supervisor,
    deps,
    journalQueue,
    goalLeaseManager,
    mockCoreLoop,
    runtimeRoot,
  };
}

describe("LoopSupervisor", () => {
  // ─── 1. start() pushes goal_activated and workers pick them up ───

  it("start() calls coreLoop.run for initial goals", async () => {
    const { supervisor, mockCoreLoop } = makeSupervisor();
    await supervisor.start(["g1"]);
    await new Promise((r) => setTimeout(r, 80));
    await supervisor.shutdown();
    expect(mockCoreLoop.run).toHaveBeenCalledWith("g1", expect.anything());
  });

  // ─── 2. Goal Exclusivity: coalescing ───

  it("coalesces duplicate goal_activated via requestExtend (re-runs)", async () => {
    let callCount = 0;
    const eventBus = new EventBus();
    const { supervisor, mockCoreLoop } = makeSupervisor((async (goalId: string) => {
      callCount++;
      if (callCount === 1) {
        eventBus.push(createEnvelope({ type: "event", name: "goal_activated",
          source: "test", goal_id: "g1", payload: {}, priority: "normal" }));
        await new Promise((r) => setTimeout(r, 30));
      }
      return makeLoopResult({ goalId });
    }) as unknown as () => Promise<LoopResult>, { eventBus } as any);
    await supervisor.start(["g1"]);
    await new Promise((r) => setTimeout(r, 200));
    await supervisor.shutdown();
    expect(mockCoreLoop.run).toHaveBeenCalledTimes(2);
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
    const stateFile = path.join(os.tmpdir(), `sv-susp-${Date.now()}.json`);
    const eventBus = new EventBus();
    const sv = new LoopSupervisor(
      {
        coreLoopFactory: () => crashingLoop as any,
        eventBus,
        driveSystem: { shouldActivate: vi.fn(), prioritizeGoals: vi.fn(), startWatcher: vi.fn(), stopWatcher: vi.fn(), writeEvent: vi.fn() } as any,
        stateManager: { getBaseDir: vi.fn().mockReturnValue(os.tmpdir()) } as any,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
        onEscalation,
      },
      { concurrency: 1, pollIntervalMs: 10, maxCrashCount: 1, crashBackoffBaseMs: 9999, stateFilePath: stateFile }
    );
    await sv.start(["g-susp"]);
    // Wait for first run to complete (crash → immediate suspend since maxCrashCount=1)
    const deadline = Date.now() + 1000;
    while (runCallCount === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 50)); // let executeWorker finish
    await sv.shutdown();
    expect(onEscalation).toHaveBeenCalledWith("g-susp", 1, "crash");
    expect(sv.getState().suspendedGoals).toContain("g-susp");
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
    const stateFile = path.join(os.tmpdir(), `sv-retry-${Date.now()}.json`);
    const eventBus = new EventBus();
    let runCallCount = 0;
    const wrappedRun = vi.fn().mockImplementation(async (...args: unknown[]) => {
      runCallCount++;
      return retryLoop.run(...args);
    });
    const sv = new LoopSupervisor(
      {
        coreLoopFactory: () => ({ run: wrappedRun, stop: vi.fn() }) as any,
        eventBus,
        driveSystem: { shouldActivate: vi.fn(), prioritizeGoals: vi.fn(), startWatcher: vi.fn(), stopWatcher: vi.fn(), writeEvent: vi.fn() } as any,
        stateManager: { getBaseDir: vi.fn().mockReturnValue(os.tmpdir()) } as any,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      },
      { concurrency: 1, pollIntervalMs: 10, maxCrashCount: 3, crashBackoffBaseMs: 9999, stateFilePath: stateFile }
    );
    await sv.start(["g-retry"]);
    // Wait for first run to crash
    const deadline = Date.now() + 1000;
    while (runCallCount === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 50));
    await sv.shutdown();
    const state = sv.getState();
    expect(state.crashCounts["g-retry"]).toBe(1);
    expect(state.suspendedGoals).not.toContain("g-retry");
  });

  // ─── 5. shutdown() ───

  it("shutdown() resolves after workers complete", async () => {
    const { supervisor } = makeSupervisor();
    await supervisor.start(["g1"]);
    await new Promise((r) => setTimeout(r, 40));
    await expect(supervisor.shutdown()).resolves.toBeUndefined();
  });

  it("shutdown() is safe without start()", async () => {
    const { supervisor } = makeSupervisor();
    await expect(supervisor.shutdown()).resolves.toBeUndefined();
  });

  // ─── 6. State persistence ───

  it("writes supervisor-state.json after execution", async () => {
    const { supervisor, stateFile } = makeSupervisor();
    await supervisor.start(["g1"]);
    await new Promise((r) => setTimeout(r, 100));
    await supervisor.shutdown();
    expect(fs.existsSync(stateFile)).toBe(true);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(state).toHaveProperty("workers");
    expect(state).toHaveProperty("crashCounts");
    fs.rmSync(stateFile, { force: true });
  });

  // ─── 7. Concurrency limit ───

  it("runs at most N workers simultaneously", async () => {
    let concurrent = 0; let max = 0;
    const { supervisor } = makeSupervisor(async () => {
      concurrent++; max = Math.max(max, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return makeLoopResult();
    });
    const sv = new LoopSupervisor((supervisor as any).deps, {
      concurrency: 2, pollIntervalMs: 20, maxCrashCount: 3,
      crashBackoffBaseMs: 50, stateFilePath: path.join(os.tmpdir(), `sv-conc-${Date.now()}.json`),
    });
    await sv.start(["g1", "g2", "g3"]);
    await new Promise((r) => setTimeout(r, 200));
    await sv.shutdown();
    expect(max).toBeLessThanOrEqual(2);
  });

  // ─── 8. Non-goal events are re-enqueued, not dropped ───

  it('non-goal events are re-enqueued after pollAndAssign', async () => {
    const { supervisor, eventBus } = makeSupervisor();
    // Do not start the supervisor (no poll timer), just call start then immediately push
    // a non-goal event and let the poll cycle run once via the timer
    await supervisor.start([]);

    // Push a non-goal event
    const nonGoalEnvelope = createEnvelope({
      type: 'event',
      name: 'cron_task_due',
      source: 'test',
      goal_id: undefined,
      payload: { taskId: 'task-1' },
      priority: 'normal',
    });
    eventBus.push(nonGoalEnvelope);

    // Wait for at least one poll cycle (pollIntervalMs=20)
    await new Promise((r) => setTimeout(r, 60));
    await supervisor.shutdown();

    // The non-goal event should still be in the bus (re-enqueued)
    const remaining = eventBus.pull();
    expect(remaining).toBeDefined();
    expect(remaining?.name).toBe('cron_task_due');
  });

  it('non-goal events do not consume idle worker slots', async () => {
    let goalRunCount = 0;
    const { supervisor, eventBus } = makeSupervisor((async (goalId: string) => {
      goalRunCount++;
      return makeLoopResult({ goalId });
    }) as unknown as () => Promise<LoopResult>);

    await supervisor.start([]);

    // Push a mix: non-goal event first, then a goal event
    eventBus.push(createEnvelope({
      type: 'event',
      name: 'schedule_activated',
      source: 'test',
      goal_id: undefined,
      payload: {},
      priority: 'normal',
    }));
    eventBus.push(createEnvelope({
      type: 'event',
      name: 'goal_activated',
      source: 'test',
      goal_id: 'g-mix',
      payload: {},
      priority: 'normal',
    }));

    // Wait for processing
    await new Promise((r) => setTimeout(r, 150));
    await supervisor.shutdown();

    // The goal should have been executed
    expect(goalRunCount).toBeGreaterThanOrEqual(1);

    // The schedule_activated event should have been re-enqueued and remain in the bus
    // (no consumer for it in this test, so it stays)
    // Drain bus to check
    const remaining: string[] = [];
    let env;
    while ((env = eventBus.pull()) !== undefined) {
      remaining.push(env.name);
    }
    // schedule_activated should appear among remaining events
    expect(remaining).toContain('schedule_activated');
  });

  it("claims durable goal activations and completes the queue record", async () => {
    const { supervisor, journalQueue, goalLeaseManager, mockCoreLoop, runtimeRoot } = makeDurableSupervisor(async (goalId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return makeLoopResult({ goalId });
    });

    try {
      await supervisor.start(["g-durable"]);
      await new Promise((resolve) => setTimeout(resolve, 220));
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
    const { supervisor, journalQueue, mockCoreLoop, runtimeRoot } = makeDurableSupervisor(async (goalId: string) => {
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
      await new Promise((resolve) => setTimeout(resolve, 220));
      await supervisor.shutdown();

      expect(mockCoreLoop.run).toHaveBeenCalledTimes(2);
      expect(journalQueue.snapshot().completed.length).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("applies crash backoff before retrying durable activations", async () => {
    let runCount = 0;
    const { supervisor, journalQueue, runtimeRoot } = makeDurableSupervisor(async () => {
      runCount += 1;
      if (runCount === 1) {
        throw new Error("boom");
      }
      return makeLoopResult({ goalId: "g-backoff" });
    });

    try {
      await supervisor.start(["g-backoff"]);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(runCount).toBe(1);
      const snapshotDuringBackoff = journalQueue.snapshot();
      expect(
        snapshotDuringBackoff.pending.normal.length + Object.keys(snapshotDuringBackoff.inflight).length
      ).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 1200));
      await supervisor.shutdown();

      expect(runCount).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("does not append a duplicate durable activation when startup finds a recovered pending goal", async () => {
    const { supervisor, journalQueue, runtimeRoot } = makeDurableSupervisor();
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
      await new Promise((resolve) => setTimeout(resolve, 120));
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
