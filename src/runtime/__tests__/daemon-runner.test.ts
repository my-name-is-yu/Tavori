import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DaemonRunner } from "../daemon-runner.js";
import { PIDManager } from "../pid-manager.js";
import { Logger } from "../logger.js";
import type { LoopResult } from "../../orchestrator/loop/core-loop.js";
import type { DaemonDeps } from "../daemon-runner.js";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";
import { JournalBackedQueue } from "../queue/journal-backed-queue.js";
import { GoalLeaseManager } from "../goal-lease-manager.js";
import { createEnvelope } from "../types/envelope.js";
import { runSupervisorMaintenanceCycleForDaemon } from "../daemon/maintenance.js";
import type { DaemonState } from "../../base/types/daemon.js";

async function pollForFile(
  filePath: string,
  timeoutMs = 2_000,
  intervalMs = 20
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
      }
    } catch {
      // Retry until stable.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
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

function makeLoopResult(overrides: Partial<LoopResult> = {}): LoopResult {
  return {
    goalId: "test-goal",
    totalIterations: 1,
    finalStatus: "completed",
    iterations: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps(tmpDir: string, overrides: Partial<DaemonDeps> = {}): DaemonDeps {
  const mockCoreLoop = {
    run: vi.fn().mockResolvedValue(makeLoopResult()),
    stop: vi.fn(),
  };

  const mockDriveSystem = {
    shouldActivate: vi.fn().mockReturnValue(false),
    getSchedule: vi.fn().mockResolvedValue(null),
    prioritizeGoals: vi.fn().mockImplementation((ids: string[]) => ids),
    startWatcher: vi.fn(),
    stopWatcher: vi.fn(),
    writeEvent: vi.fn().mockResolvedValue(undefined),
  };

  const mockStateManager = {
    getBaseDir: vi.fn().mockReturnValue(tmpDir),
    loadGoal: vi.fn().mockResolvedValue(null),
  };

  const pidManager = new PIDManager(tmpDir);
  const logger = new Logger({
    dir: path.join(tmpDir, "logs"),
    consoleOutput: false,
    level: "error",
  });

  return {
    coreLoop: mockCoreLoop as unknown as DaemonDeps["coreLoop"],
    driveSystem: mockDriveSystem as unknown as DaemonDeps["driveSystem"],
    stateManager: mockStateManager as unknown as DaemonDeps["stateManager"],
    pidManager,
    logger,
    ...overrides,
  };
}

function makeEventServerMock() {
  return {
    setEnvelopeHook: vi.fn(),
    setCommandEnvelopeHook: vi.fn(),
    setActiveWorkersProvider: vi.fn(),
    setApprovalBroker: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getPort: vi.fn().mockReturnValue(41700),
    startFileWatcher: vi.fn(),
    stopFileWatcher: vi.fn(),
    broadcast: vi.fn(),
    requestApproval: vi.fn().mockResolvedValue(true),
  };
}

function createPersistedStateFile(tmpDir: string, state: DaemonState): {
  filePath: string;
  saveDaemonState: () => Promise<void>;
} {
  const filePath = path.join(tmpDir, "daemon-state.json");
  fs.writeFileSync(filePath, JSON.stringify(state));

  return {
    filePath,
    saveDaemonState: async () => {
      fs.writeFileSync(filePath, JSON.stringify(state));
    },
  };
}

describe("DaemonRunner durable runtime", () => {
  let tmpDir: string;
  let currentDaemon: DaemonRunner | null = null;
  let currentStartPromise: Promise<void> | null = null;

  beforeEach(() => {
    tmpDir = makeTempDir();
    currentDaemon = null;
    currentStartPromise = null;
  });

  afterEach(async () => {
    if (currentDaemon) {
      currentDaemon.stop();
      currentDaemon = null;
    }
    if (currentStartPromise) {
      await currentStartPromise.catch(() => {});
      currentStartPromise = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  it("constructs with minimal deps and partial config overrides", () => {
    const deps = makeDeps(tmpDir, {
      config: {
        check_interval_ms: 1_000,
        crash_recovery: { enabled: true, max_retries: 1, retry_delay_ms: 500 },
      },
    });
    expect(() => new DaemonRunner(deps)).not.toThrow();
  });

  it("saves daemon-state.json with running status and active goals on start", async () => {
    const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start(["goal-a", "goal-b"]);
    currentStartPromise = startPromise;

    const state = await pollForFile(path.join(tmpDir, "daemon-state.json")) as {
      status: string;
      active_goals: string[];
    };
    expect(state.status).toBe("running");
    expect(state.active_goals).toEqual(["goal-a", "goal-b"]);

    daemon.stop();
    await startPromise;
  });

  it("writes stopped state, interrupted goals, and a clean shutdown marker on stop", async () => {
    const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start(["goal-1"]);
    currentStartPromise = startPromise;
    await pollForFile(path.join(tmpDir, "daemon-state.json"));

    daemon.stop();
    await startPromise;

    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, "daemon-state.json"), "utf-8"));
    expect(state.status).toBe("stopped");
    expect(state.interrupted_goals).toEqual(["goal-1"]);

    const marker = JSON.parse(fs.readFileSync(path.join(tmpDir, "shutdown-state.json"), "utf-8"));
    expect(marker.state).toBe("clean_shutdown");
    expect(marker.goal_ids).toEqual(["goal-1"]);
  });

  it("restores interrupted goals from the previous daemon state", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon-state.json"),
      JSON.stringify({
        pid: 12345,
        started_at: new Date().toISOString(),
        last_loop_at: null,
        loop_count: 0,
        active_goals: ["goal-old"],
        interrupted_goals: ["goal-old", "goal-extra"],
        status: "stopped",
        crash_count: 0,
        last_error: null,
      })
    );

    const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start(["goal-new", "goal-old"]);
    currentStartPromise = startPromise;

    const state = await pollForJsonMatch<{ active_goals: string[] }>(
      path.join(tmpDir, "daemon-state.json"),
      (value) => value.active_goals.includes("goal-extra")
    );
    expect(state.active_goals).toEqual(["goal-new", "goal-old", "goal-extra"]);

    daemon.stop();
    await startPromise;
  });

  it("starts and stops the event server when provided", async () => {
    const eventServer = makeEventServerMock();
    const deps = makeDeps(tmpDir, {
      config: { check_interval_ms: 50 },
      eventServer: eventServer as unknown as DaemonDeps["eventServer"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start(["goal-1"]);
    currentStartPromise = startPromise;
    await pollForFile(path.join(tmpDir, "daemon-state.json"));
    daemon.stop();
    await startPromise;

    expect(eventServer.start).toHaveBeenCalledOnce();
    expect(eventServer.stop).toHaveBeenCalledOnce();
  });

  it("initializes durable runtime state and does not create a PID file", async () => {
    const eventServer = makeEventServerMock();
    const deps = makeDeps(tmpDir, {
      config: { check_interval_ms: 50, runtime_journal_v2: true },
      eventServer: eventServer as unknown as DaemonDeps["eventServer"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start(["goal-1"]);
    currentStartPromise = startPromise;
    await waitFor(() => fs.existsSync(path.join(tmpDir, "runtime", "queue.json")));

    daemon.stop();
    await startPromise;

    const runtimeDir = path.join(tmpDir, "runtime");
    expect(fs.existsSync(path.join(runtimeDir, "approvals", "pending"))).toBe(true);
    expect(fs.existsSync(path.join(runtimeDir, "outbox"))).toBe(true);
    expect(fs.existsSync(path.join(runtimeDir, "health", "daemon.json"))).toBe(true);
    expect(fs.existsSync(path.join(runtimeDir, "queue.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "pulseed.pid"))).toBe(false);
  });

  it("holds the leader lock, emits runtime heartbeats, and releases leadership on stop", async () => {
    const eventServer = makeEventServerMock();
    const deps = makeDeps(tmpDir, {
      config: { check_interval_ms: 50, runtime_journal_v2: true },
      eventServer: eventServer as unknown as DaemonDeps["eventServer"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start(["goal-1"]);
    currentStartPromise = startPromise;

    const runtimeDir = path.join(tmpDir, "runtime");
    const leaderRecord = await pollForJsonMatch<{ pid: number; lease_until: number }>(
      path.join(runtimeDir, "leader", "leader.json"),
      (value) => value.pid === process.pid && value.lease_until > Date.now()
    );
    expect(leaderRecord.pid).toBe(process.pid);

    const healthRecord = await pollForJsonMatch<{ leader: boolean; details?: { pid?: number } }>(
      path.join(runtimeDir, "health", "daemon.json"),
      (value) => value.leader === true
    );
    expect(healthRecord.details?.pid).toBe(process.pid);

    daemon.stop();
    await startPromise;
    currentDaemon = null;
    currentStartPromise = null;

    expect(fs.existsSync(path.join(runtimeDir, "leader", "leader.json"))).toBe(false);
    const finalHealth = JSON.parse(fs.readFileSync(path.join(runtimeDir, "health", "daemon.json"), "utf-8"));
    expect(finalHealth.leader).toBe(false);
  });

  it("anchors a relative runtime_root to the daemon base dir", async () => {
    const eventServer = makeEventServerMock();
    const otherCwd = makeTempDir();
    const originalCwd = process.cwd();
    process.chdir(otherCwd);

    try {
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          runtime_journal_v2: true,
          runtime_root: "runtime-v2",
        },
        eventServer: eventServer as unknown as DaemonDeps["eventServer"],
      });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await waitFor(() => fs.existsSync(path.join(tmpDir, "runtime-v2", "health", "daemon.json")));
      await waitFor(() => {
        const statePath = path.join(tmpDir, "daemon-state.json");
        if (!fs.existsSync(statePath)) {
          return false;
        }
        const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as { status?: string };
        return state.status === "running";
      });

      daemon.stop();
      await startPromise;

      expect(fs.existsSync(path.join(tmpDir, "runtime-v2", "health", "daemon.json"))).toBe(true);
      expect(fs.existsSync(path.join(otherCwd, "runtime-v2", "health", "daemon.json"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(otherCwd, { recursive: true, force: true });
    }
  });

  it("reclaims expired queue claims on startup and resumes execution", async () => {
    const eventServer = makeEventServerMock();
    const runtimeDir = path.join(tmpDir, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });

    const queue = new JournalBackedQueue({
      journalPath: path.join(runtimeDir, "queue.json"),
    });
    const leaseManager = new GoalLeaseManager(runtimeDir, 1);
    const envelope = createEnvelope({
      type: "event",
      name: "goal_activated",
      source: "restart-test",
      goal_id: "g-recover",
      payload: {},
      priority: "normal",
    });
    queue.accept(envelope);
    const claim = queue.claim("worker-old", 1);
    expect(claim).not.toBeNull();
    await leaseManager.acquire("g-recover", {
      workerId: "worker-old",
      ownerToken: claim!.claimToken,
      attemptId: claim!.claimToken,
      leaseMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const deps = makeDeps(tmpDir, {
      config: { check_interval_ms: 50 },
      eventServer: eventServer as unknown as DaemonDeps["eventServer"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start([]);
    currentStartPromise = startPromise;

    const runMock = (deps.coreLoop as unknown as { run: ReturnType<typeof vi.fn> }).run;
    await waitFor(() => runMock.mock.calls.some((call: unknown[]) => call[0] === "g-recover"));

    daemon.stop();
    await startPromise;

    const persistedQueue = JSON.parse(
      fs.readFileSync(path.join(runtimeDir, "queue.json"), "utf-8")
    ) as {
      records: Record<string, { status: string; envelope?: { goal_id?: string; name?: string } }>;
    };
    expect(Object.values(persistedQueue.records)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "completed",
          envelope: expect.objectContaining({
            name: "goal_activated",
            goal_id: "g-recover",
          }),
        }),
      ])
    );
  });

  it("does not leave a stale PID file when runtime initialization fails", async () => {
    const eventServer = makeEventServerMock();
    const blockedPath = path.join(tmpDir, "not-a-directory");
    fs.writeFileSync(blockedPath, "block");

    const deps = makeDeps(tmpDir, {
      config: {
        check_interval_ms: 50,
        runtime_journal_v2: true,
        runtime_root: path.join("not-a-directory", "child"),
      },
      eventServer: eventServer as unknown as DaemonDeps["eventServer"],
    });
    const daemon = new DaemonRunner(deps);

    await expect(daemon.start(["goal-1"])).rejects.toThrow();
    expect(fs.existsSync(path.join(tmpDir, "pulseed.pid"))).toBe(false);
  });

  it("generates cron entries for daemon scheduling", () => {
    expect(DaemonRunner.generateCronEntry("goal-1", 15)).toContain("goal-1");
    expect(DaemonRunner.generateCronEntry("goal-1", 15)).toContain("*/15");
  });

  it("does not rewrite daemon-state.json during idle supervisor maintenance", async () => {
    const state: DaemonState = {
      pid: process.pid,
      started_at: new Date().toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: ["goal-1"],
      interrupted_goals: [],
      status: "running",
      crash_count: 0,
      last_error: null,
    };
    const { filePath, saveDaemonState } = createPersistedStateFile(tmpDir, state);
    const saveSpy = vi.fn(saveDaemonState);
    const driveSystem = {
      shouldActivate: vi.fn().mockResolvedValue(false),
      getSchedule: vi.fn().mockResolvedValue(null),
      prioritizeGoals: vi.fn().mockImplementation((ids: string[]) => ids),
    };

    const before = fs.statSync(filePath).mtimeMs;
    await runSupervisorMaintenanceCycleForDaemon({
      currentGoalIds: ["goal-1"],
      driveSystem: driveSystem as never,
      supervisor: null,
      processCronTasks: vi.fn().mockResolvedValue(undefined),
      processScheduleEntries: vi.fn().mockResolvedValue(undefined),
      proactiveTick: vi.fn().mockResolvedValue(undefined),
      saveDaemonState: saveSpy,
      state,
    });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(fs.statSync(filePath).mtimeMs).toBe(before);
  });

  it("persists daemon-state.json when supervisor maintenance changes active goals", async () => {
    const state: DaemonState = {
      pid: process.pid,
      started_at: new Date().toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      interrupted_goals: [],
      status: "running",
      crash_count: 0,
      last_error: null,
    };
    const { filePath, saveDaemonState } = createPersistedStateFile(tmpDir, state);
    const saveSpy = vi.fn(saveDaemonState);
    const driveSystem = {
      shouldActivate: vi.fn().mockResolvedValue(true),
      getSchedule: vi.fn().mockResolvedValue(null),
      prioritizeGoals: vi.fn().mockImplementation((ids: string[]) => ids),
    };
    const supervisor = {
      activateGoal: vi.fn((goalId: string) => {
        state.active_goals = [goalId];
      }),
    };

    await runSupervisorMaintenanceCycleForDaemon({
      currentGoalIds: ["goal-2"],
      driveSystem: driveSystem as never,
      supervisor,
      processCronTasks: vi.fn().mockResolvedValue(undefined),
      processScheduleEntries: vi.fn().mockResolvedValue(undefined),
      proactiveTick: vi.fn().mockResolvedValue(undefined),
      saveDaemonState: saveSpy,
      state,
    });

    expect(saveSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(filePath, "utf-8"))).toMatchObject({
      active_goals: ["goal-2"],
      status: "running",
    });
  });
});
