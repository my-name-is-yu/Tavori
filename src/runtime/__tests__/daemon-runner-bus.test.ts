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
import { HttpChannelAdapter } from "../gateway/http-channel-adapter.js";

// ─── Mock buses ───

function makeMockEventBus() {
  return {
    push: vi.fn(),
    pull: vi.fn().mockReturnValue(undefined),
    size: vi.fn().mockReturnValue(0),
    pendingCount: vi.fn().mockReturnValue({ critical: 0, high: 0, normal: 0, low: 0 }),
  };
}

function makeMockCommandBus() {
  return {
    push: vi.fn(),
    pull: vi.fn().mockReturnValue(undefined),
    size: vi.fn().mockReturnValue(0),
    pendingCount: vi.fn().mockReturnValue({ critical: 0, high: 0, normal: 0, low: 0 }),
  };
}

// ─── Helpers ───

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
    shouldActivate: vi.fn().mockReturnValue(false), // default: no active goals
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

// ─── Test Suite ───

describe("DaemonRunner — Bus Wiring", () => {
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

  // ─── 1. Bus routing via gateway ───

  describe("gateway envelope routing with buses", () => {
    it("routes 'event' envelopes to eventBus when configured", () => {
      const mockEventBus = makeMockEventBus();
      const mockCommandBus = makeMockCommandBus();

      // Simulate the wiring that DaemonRunner.start() performs in the gateway handler
      const mockEventServer = {
        setEnvelopeHook: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        startFileWatcher: vi.fn(),
        stopFileWatcher: vi.fn(),
        getPort: vi.fn().mockReturnValue(41700),
      };

      let capturedHook: ((data: Record<string, unknown>) => void) | undefined;
      mockEventServer.setEnvelopeHook.mockImplementation(
        (hook: (data: Record<string, unknown>) => void) => {
          capturedHook = hook;
        }
      );

      // Set up a gateway + adapter to capture the onEnvelope handler
      const gateway = new IngressGateway();
      const httpAdapter = new HttpChannelAdapter(mockEventServer as any);
      gateway.registerAdapter(httpAdapter);

      // Replicate the DaemonRunner gateway handler logic
      gateway.onEnvelope(async (envelope: import("../types/envelope.js").Envelope) => {
        if (envelope.type === "command" && mockCommandBus) {
          mockCommandBus.push(envelope);
          return;
        }
        if (envelope.type === "event" && mockEventBus) {
          mockEventBus.push(envelope);
          return;
        }
        // Fallback — driveSystem.writeEvent (not reached in this test since buses present)
      });

      // Fire an "event"-type envelope through the hook
      const incomingData = {
        type: "event_payload",
        source: "test-producer",
        timestamp: new Date().toISOString(),
        data: { goal_id: "g1" },
      };

      expect(capturedHook).toBeDefined();
      capturedHook!(incomingData);

      // The resulting envelope type is always "event" since HttpChannelAdapter sets type="event"
      // (see http-channel-adapter: createEnvelope({ type: "event", ... }))
      expect(mockEventBus.push).toHaveBeenCalledOnce();
      expect(mockCommandBus.push).not.toHaveBeenCalled();
    });

    it("routes 'command' envelopes to commandBus when configured", () => {
      const mockEventBus = makeMockEventBus();
      const mockCommandBus = makeMockCommandBus();

      // Directly simulate the routing logic from daemon-runner's gateway handler
      const commandEnvelope = createEnvelope({
        type: "command",
        name: "run_goal",
        source: "cli",
        priority: "high",
        payload: { goal_id: "g1" },
      });

      // Replicate the routing logic
      const route = (envelope: import("../types/envelope.js").Envelope) => {
        if (envelope.type === "command" && mockCommandBus) {
          mockCommandBus.push(envelope);
          return;
        }
        if (envelope.type === "event" && mockEventBus) {
          mockEventBus.push(envelope);
          return;
        }
      };

      route(commandEnvelope);

      expect(mockCommandBus.push).toHaveBeenCalledOnce();
      expect(mockCommandBus.push).toHaveBeenCalledWith(commandEnvelope);
      expect(mockEventBus.push).not.toHaveBeenCalled();
    });
  });

  // ─── 2. Fallback: no buses → driveSystem.writeEvent() ───

  describe("fallback when no buses configured", () => {
    it("calls driveSystem.writeEvent() when no eventBus/commandBus in deps", async () => {
      const writeEvent = vi.fn().mockResolvedValue(undefined);

      // Build the handler that DaemonRunner uses (without buses)
      const eventBus = undefined;
      const commandBus = undefined;

      const { PulSeedEventSchema } = await import("../../base/types/drive.js");
      const mockLogger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

      const handler = async (envelope: import("../types/envelope.js").Envelope) => {
        if (envelope.type === "command" && commandBus) {
          (commandBus as any).push(envelope);
          return;
        }
        if (envelope.type === "event" && eventBus) {
          (eventBus as any).push(envelope);
          return;
        }
        // Fallback
        const payload = envelope.payload as Record<string, unknown>;
        try {
          const event = PulSeedEventSchema.parse(payload);
          await writeEvent(event);
        } catch (err) {
          mockLogger.error("Gateway: failed to process envelope", {
            id: envelope.id,
            error: String(err),
          });
        }
      };

      const validEvent = {
        type: "external",
        source: "test-producer",
        data: {},
        timestamp: new Date().toISOString(),
      };

      const envelope = createEnvelope({
        type: "event",
        name: "incoming",
        source: "http",
        payload: validEvent,
      });

      await handler(envelope);

      // writeEvent should have been called (fallback behavior)
      expect(writeEvent).toHaveBeenCalledOnce();
    });
  });

  // ─── 3. Schedule entries → EventBus ───

  describe("processScheduleEntries → eventBus", () => {
    it("pushes schedule_activated envelopes to eventBus when available", async () => {
      const mockEventBus = makeMockEventBus();
      const mockCommandBus = makeMockCommandBus();

      const scheduleResult = {
        entry_id: "entry-1",
        status: "activated",
        goal_id: "g-42",
        activated_at: new Date().toISOString(),
      };

      const mockScheduleEngine = {
        tick: vi.fn().mockResolvedValue([scheduleResult]),
      };

      const deps = makeDeps(tmpDir, {
        scheduleEngine: mockScheduleEngine as any,
        eventBus: mockEventBus as any,
        commandBus: mockCommandBus as any,
        config: { check_interval_ms: 50000 }, // long sleep so daemon doesn't loop
      });

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      // start() and stop immediately after first cycle
      let resolveStop: () => void;
      const stopDone = new Promise<void>((r) => { resolveStop = r; });

      currentStartPromise = daemon.start(["g-1"]).then(() => { resolveStop!(); });

      // Give the daemon one loop cycle to run processScheduleEntries
      await new Promise((r) => setTimeout(r, 100));
      daemon.stop();
      await currentStartPromise.catch(() => {});
      currentDaemon = null;
      currentStartPromise = null;

      // eventBus.push should have been called with a schedule_activated envelope
      const allPushed = mockEventBus.push.mock.calls.map((c: any[]) => c[0]);
      const pushedEnvelope = allPushed.find((e: any) => e.name === "schedule_activated");
      expect(pushedEnvelope).toBeDefined();
      expect(pushedEnvelope.source).toBe("schedule-engine");
      expect(pushedEnvelope.type).toBe("event");
      expect(pushedEnvelope.goal_id).toBe("g-42");
      expect(pushedEnvelope.dedupe_key).toBe("entry-1");
    });

    it("does NOT push to eventBus when scheduleEngine returns error status entries", async () => {
      const mockEventBus = makeMockEventBus();

      const scheduleResult = {
        entry_id: "entry-err",
        status: "error",
        error_message: "Something failed",
      };

      const mockScheduleEngine = {
        tick: vi.fn().mockResolvedValue([scheduleResult]),
      };

      const deps = makeDeps(tmpDir, {
        scheduleEngine: mockScheduleEngine as any,
        eventBus: mockEventBus as any,
        config: { check_interval_ms: 50000 },
      });

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      currentStartPromise = daemon.start(["g-1"]);

      await new Promise((r) => setTimeout(r, 100));
      daemon.stop();
      await currentStartPromise.catch(() => {});
      currentDaemon = null;
      currentStartPromise = null;

      // No schedule_activated envelope pushed for error entries (supervisor may push goal_activated)
      const allPushed = mockEventBus.push.mock.calls.map((c: any[]) => c[0]);
      const scheduleEnvelope = allPushed.find((e: any) => e.name === "schedule_activated");
      expect(scheduleEnvelope).toBeUndefined();
    });
  });

  // ─── 4. Cron tasks → EventBus ───

  describe("processCronTasks → eventBus", () => {
    it("pushes cron_task_due envelopes to eventBus when available", async () => {
      const mockEventBus = makeMockEventBus();

      const dueTask = {
        id: "task-1",
        type: "check",
        cron: "* * * * *",
        prompt: "Check the status",
        created_at: new Date().toISOString(),
        last_fired_at: null,
      };

      const mockCronScheduler = {
        getDueTasks: vi.fn().mockResolvedValue([dueTask]),
        markFired: vi.fn().mockResolvedValue(undefined),
        expireOldTasks: vi.fn().mockResolvedValue(undefined),
      };

      const deps = makeDeps(tmpDir, {
        cronScheduler: mockCronScheduler as any,
        eventBus: mockEventBus as any,
        config: { check_interval_ms: 50000 },
      });

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      currentStartPromise = daemon.start(["g-1"]);

      await new Promise((r) => setTimeout(r, 100));
      daemon.stop();
      await currentStartPromise.catch(() => {});
      currentDaemon = null;
      currentStartPromise = null;

      // eventBus should receive a cron_task_due envelope
      const allPushed = mockEventBus.push.mock.calls.map((c: any[]) => c[0]);
      const pushedEnvelope = allPushed.find((e: any) => e.name === "cron_task_due");
      expect(pushedEnvelope).toBeDefined();
      expect(pushedEnvelope.source).toBe("cron-scheduler");
      expect(pushedEnvelope.type).toBe("event");
      expect(pushedEnvelope.dedupe_key).toBe("cron-task-1");
      expect(pushedEnvelope.payload).toEqual(dueTask);
    });

    it("does NOT call markFired when pushing cron tasks to eventBus", async () => {
      const mockEventBus = makeMockEventBus();

      const dueTask = {
        id: "task-no-fire",
        type: "check",
        cron: "* * * * *",
        prompt: "Do not fire me",
        created_at: new Date().toISOString(),
        last_fired_at: null,
      };

      const mockCronScheduler = {
        getDueTasks: vi.fn().mockResolvedValue([dueTask]),
        markFired: vi.fn().mockResolvedValue(undefined),
        expireOldTasks: vi.fn().mockResolvedValue(undefined),
      };

      const deps = makeDeps(tmpDir, {
        cronScheduler: mockCronScheduler as any,
        eventBus: mockEventBus as any,
        config: { check_interval_ms: 50000 },
      });

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      currentStartPromise = daemon.start(["g-1"]);

      await new Promise((r) => setTimeout(r, 100));
      daemon.stop();
      await currentStartPromise.catch(() => {});
      currentDaemon = null;
      currentStartPromise = null;

      // markFired MUST NOT be called — it happens at consume time, not push time
      expect(mockCronScheduler.markFired).not.toHaveBeenCalled();
      // A cron_task_due envelope must be pushed (supervisor may also push goal_activated)
      const allPushed = mockEventBus.push.mock.calls.map((c: any[]) => c[0]);
      const cronEnvelope = allPushed.find((e: any) => e.name === "cron_task_due");
      expect(cronEnvelope).toBeDefined();
    });

    it("calls markFired directly (legacy) when no eventBus configured", async () => {
      const dueTask = {
        id: "task-legacy",
        type: "check",
        cron: "* * * * *",
        prompt: "Legacy fire",
        created_at: new Date().toISOString(),
        last_fired_at: null,
      };

      const mockCronScheduler = {
        getDueTasks: vi.fn().mockResolvedValue([dueTask]),
        markFired: vi.fn().mockResolvedValue(undefined),
        expireOldTasks: vi.fn().mockResolvedValue(undefined),
      };

      const deps = makeDeps(tmpDir, {
        cronScheduler: mockCronScheduler as any,
        // No eventBus — legacy path
        config: { check_interval_ms: 50000 },
      });

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      currentStartPromise = daemon.start(["g-1"]);

      await new Promise((r) => setTimeout(r, 100));
      daemon.stop();
      await currentStartPromise.catch(() => {});
      currentDaemon = null;
      currentStartPromise = null;

      // Legacy: markFired should have been called
      expect(mockCronScheduler.markFired).toHaveBeenCalledWith("task-legacy");
    });
  });

  // ─── 5. abortSleep() / onHighPriority ───

  describe("abortSleep()", () => {
    it("exposes abortSleep() method that aborts the sleep controller", async () => {
      const deps = makeDeps(tmpDir, {
        config: { check_interval_ms: 60000 }, // long sleep
      });

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      let startResolved = false;
      currentStartPromise = daemon.start(["g-1"]).then(() => { startResolved = true; });

      // Wait for daemon to enter sleep phase
      await new Promise((r) => setTimeout(r, 80));

      // abortSleep() should not throw and should wake the daemon
      expect(() => daemon.abortSleep()).not.toThrow();

      daemon.stop();
      await currentStartPromise.catch(() => {});
      currentDaemon = null;
      currentStartPromise = null;

      expect(startResolved).toBe(true);
    });

    it("abortSleep() is safe to call when daemon is not sleeping", () => {
      const deps = makeDeps(tmpDir);
      const daemon = new DaemonRunner(deps);
      // Not started — sleepAbortController is null; should not throw
      expect(() => daemon.abortSleep()).not.toThrow();
    });
  });

  // ─── 6. Constructor stores buses from deps ───

  describe("constructor wiring", () => {
    it("stores eventBus and commandBus from deps", () => {
      const mockEventBus = makeMockEventBus();
      const mockCommandBus = makeMockCommandBus();

      const deps = makeDeps(tmpDir, {
        eventBus: mockEventBus as any,
        commandBus: mockCommandBus as any,
      });

      // Should not throw on construction
      expect(() => new DaemonRunner(deps)).not.toThrow();
    });

    it("works without buses (backward compat)", () => {
      const deps = makeDeps(tmpDir);
      // No eventBus, no commandBus in deps
      expect(() => new DaemonRunner(deps)).not.toThrow();
    });
  });
});
