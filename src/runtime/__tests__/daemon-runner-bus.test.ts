import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { DaemonRunner } from "../daemon-runner.js";
import { PIDManager } from "../pid-manager.js";
import { Logger } from "../logger.js";
import type { LoopResult } from "../../orchestrator/loop/core-loop.js";
import type { DaemonDeps } from "../daemon-runner.js";
import { createEnvelope } from "../types/envelope.js";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";
import { IngressGateway } from "../gateway/ingress-gateway.js";

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

function readRuntimeQueue(tmpDir: string): Record<string, any> {
  const queuePath = path.join(tmpDir, "runtime", "queue.json");
  return JSON.parse(fs.readFileSync(queuePath, "utf-8")) as Record<string, any>;
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

describe("DaemonRunner durable runtime wiring", () => {
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

  it("accepts gateway ingress into the runtime journal and dispatches external events", async () => {
    const mockEventServer = {
      setEnvelopeHook: vi.fn(),
      setCommandEnvelopeHook: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      startFileWatcher: vi.fn(),
      stopFileWatcher: vi.fn(),
      getPort: vi.fn().mockReturnValue(41700),
      setActiveWorkersProvider: vi.fn(),
    };

    let capturedHook: ((data: Record<string, unknown>) => void | Promise<void>) | undefined;
    mockEventServer.setEnvelopeHook.mockImplementation(
      (hook: (data: Record<string, unknown>) => void | Promise<void>) => {
        capturedHook = hook;
      }
    );

    const gateway = new IngressGateway();
    const deps = makeDeps(tmpDir, {
      gateway,
      eventServer: mockEventServer as any,
      config: { check_interval_ms: 50_000 },
    });

    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;
    currentStartPromise = daemon.start(["g-1"]);

    await waitFor(() => capturedHook !== undefined);

    await capturedHook?.({
      type: "external",
      source: "test-producer",
      timestamp: new Date().toISOString(),
      data: { goal_id: "g-1", kind: "external_ping" },
    });

    const writeEventMock = (deps.driveSystem as unknown as {
      writeEvent: ReturnType<typeof vi.fn>;
    }).writeEvent;
    await waitFor(() => writeEventMock.mock.calls.length > 0);
    await waitFor(() => {
      const queue = readRuntimeQueue(tmpDir);
      return Object.values(queue.records).some(
        (entry: any) =>
          entry.status === "completed" &&
          entry.envelope?.type === "event" &&
          entry.envelope?.name === "external"
      );
    });

    const queue = readRuntimeQueue(tmpDir);
    expect(Object.values(queue.records)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "completed",
          envelope: expect.objectContaining({
            type: "event",
            name: "external",
            source: "http",
          }),
        }),
      ])
    );
  });

  it("accepts HTTP command envelopes into the runtime journal and dispatches goal_start", async () => {
    const mockEventServer = {
      setEnvelopeHook: vi.fn(),
      setCommandEnvelopeHook: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      startFileWatcher: vi.fn(),
      stopFileWatcher: vi.fn(),
      getPort: vi.fn().mockReturnValue(41700),
      setActiveWorkersProvider: vi.fn(),
    };

    let capturedCommandHook:
      | ((envelope: import("../types/envelope.js").Envelope) => void | Promise<void>)
      | undefined;
    mockEventServer.setCommandEnvelopeHook.mockImplementation(
      (hook: (envelope: import("../types/envelope.js").Envelope) => void | Promise<void>) => {
        capturedCommandHook = hook;
      }
    );

    const deps = makeDeps(tmpDir, {
      eventServer: mockEventServer as any,
      config: { check_interval_ms: 50 },
    });

    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;
    currentStartPromise = daemon.start([]);

    await waitFor(() => capturedCommandHook !== undefined);

    await capturedCommandHook?.(
      createEnvelope({
        type: "command",
        name: "goal_start",
        source: "http",
        goal_id: "g-start",
        payload: { goalId: "g-start" },
      })
    );

    const runMock = (deps.coreLoop as unknown as { run: ReturnType<typeof vi.fn> }).run;
    await waitFor(() =>
      runMock.mock.calls.some((call: unknown[]) => call[0] === "g-start")
    );
    await waitFor(() => {
      const records = Object.values(readRuntimeQueue(tmpDir).records) as Array<{ status: string; envelope?: { type?: string; name?: string; goal_id?: string } }>;
      return (
        records.some(
          (entry) =>
            entry.status === "completed" &&
            entry.envelope?.type === "command" &&
            entry.envelope?.name === "goal_start" &&
            entry.envelope?.goal_id === "g-start"
        ) &&
        records.some(
          (entry) =>
            entry.status === "completed" &&
            entry.envelope?.type === "event" &&
            entry.envelope?.name === "goal_activated" &&
            entry.envelope?.goal_id === "g-start"
        )
      );
    });

    const queue = readRuntimeQueue(tmpDir);
    expect(Object.values(queue.records)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "completed",
          envelope: expect.objectContaining({
            type: "command",
            name: "goal_start",
            goal_id: "g-start",
          }),
        }),
        expect.objectContaining({
          status: "completed",
          envelope: expect.objectContaining({
            type: "event",
            name: "goal_activated",
            goal_id: "g-start",
          }),
        }),
      ])
    );
  });

  it("dispatches durable chat_message commands into DriveSystem events", async () => {
    const mockEventServer = {
      setEnvelopeHook: vi.fn(),
      setCommandEnvelopeHook: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      startFileWatcher: vi.fn(),
      stopFileWatcher: vi.fn(),
      getPort: vi.fn().mockReturnValue(41700),
      setActiveWorkersProvider: vi.fn(),
    };

    let capturedCommandHook:
      | ((envelope: import("../types/envelope.js").Envelope) => void | Promise<void>)
      | undefined;
    mockEventServer.setCommandEnvelopeHook.mockImplementation(
      (hook: (envelope: import("../types/envelope.js").Envelope) => void | Promise<void>) => {
        capturedCommandHook = hook;
      }
    );

    const deps = makeDeps(tmpDir, {
      eventServer: mockEventServer as any,
      config: { check_interval_ms: 50 },
    });

    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;
    currentStartPromise = daemon.start([]);

    await waitFor(() => capturedCommandHook !== undefined);

    await capturedCommandHook?.(
      createEnvelope({
        type: "command",
        name: "chat_message",
        source: "http",
        goal_id: "g-chat",
        payload: { goalId: "g-chat", message: "hello durable runtime" },
      })
    );

    const writeEventMock = (deps.driveSystem as unknown as {
      writeEvent: ReturnType<typeof vi.fn>;
    }).writeEvent;
    await waitFor(() => writeEventMock.mock.calls.length > 0);

    expect(writeEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "internal",
        source: "command-dispatcher",
        data: expect.objectContaining({
          goal_id: "g-chat",
          kind: "chat_message",
          message: "hello durable runtime",
        }),
      })
    );
  });

  it("records schedule activations in the runtime journal and dispatches goal activation", async () => {
    const mockEventServer = {
      setEnvelopeHook: vi.fn(),
      setCommandEnvelopeHook: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      startFileWatcher: vi.fn(),
      stopFileWatcher: vi.fn(),
      getPort: vi.fn().mockReturnValue(41700),
      setActiveWorkersProvider: vi.fn(),
    };
    const mockScheduleEngine = {
      tick: vi.fn().mockResolvedValue([
        {
          entry_id: "entry-1",
          status: "activated",
          goal_id: "g-42",
          activated_at: new Date().toISOString(),
        },
      ]),
    };

    const deps = makeDeps(tmpDir, {
      eventServer: mockEventServer as any,
      scheduleEngine: mockScheduleEngine as any,
      config: { check_interval_ms: 50 },
    });

    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;
    currentStartPromise = daemon.start([]);

    const runMock = (deps.coreLoop as unknown as { run: ReturnType<typeof vi.fn> }).run;
    await waitFor(() =>
      runMock.mock.calls.some((call: unknown[]) => call[0] === "g-42")
    );

    const queue = readRuntimeQueue(tmpDir);
    expect(Object.values(queue.records)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "completed",
          envelope: expect.objectContaining({
            type: "event",
            name: "schedule_activated",
            goal_id: "g-42",
            dedupe_key: "entry-1",
          }),
        }),
      ])
    );
  });

  it("records cron receipts in the runtime journal and marks the task fired after dispatch", async () => {
    const mockEventServer = {
      setEnvelopeHook: vi.fn(),
      setCommandEnvelopeHook: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      startFileWatcher: vi.fn(),
      stopFileWatcher: vi.fn(),
      getPort: vi.fn().mockReturnValue(41700),
      setActiveWorkersProvider: vi.fn(),
    };
    const mockCronScheduler = {
      getDueTasks: vi.fn().mockResolvedValue([
        {
          id: "task-1",
          cron: "*/5 * * * *",
          type: "goal",
          goal_id: "g-1",
        },
      ]),
      markFired: vi.fn().mockResolvedValue(undefined),
      expireOldTasks: vi.fn().mockResolvedValue(undefined),
    };

    const deps = makeDeps(tmpDir, {
      eventServer: mockEventServer as any,
      cronScheduler: mockCronScheduler as any,
      config: { check_interval_ms: 50 },
    });

    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;
    currentStartPromise = daemon.start([]);

    await waitFor(() => mockCronScheduler.markFired.mock.calls.length > 0);

    const queue = readRuntimeQueue(tmpDir);
    expect(Object.values(queue.records)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "completed",
          envelope: expect.objectContaining({
            type: "event",
            name: "cron_task_due",
            dedupe_key: "cron-task-1",
          }),
        }),
      ])
    );
    expect(mockCronScheduler.markFired).toHaveBeenCalledWith("task-1");
  });
});
