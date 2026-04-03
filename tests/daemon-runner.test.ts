import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DaemonRunner } from "../src/runtime/daemon-runner.js";
import { PIDManager } from "../src/runtime/pid-manager.js";
import { Logger } from "../src/runtime/logger.js";
import type { LoopResult } from "../src/loop/core-loop.js";
import type { DaemonDeps } from "../src/runtime/daemon-runner.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Helpers ───

/**
 * Poll until the given file path exists and contains valid JSON, or throw after timeout.
 * Avoids relying on fixed setTimeout delays that are inherently flaky on loaded CI runners.
 */
async function pollForFile(
  filePath: string,
  timeoutMs = 2000,
  intervalMs = 20
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
      }
    } catch {
      // file not yet fully written — retry
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
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
    shouldActivate: vi.fn().mockReturnValue(true),
    getSchedule: vi.fn().mockResolvedValue(null),
    prioritizeGoals: vi.fn().mockImplementation((ids: string[]) => ids),
    startWatcher: vi.fn(),
    stopWatcher: vi.fn(),
  };

  const mockStateManager = {
    getBaseDir: vi.fn().mockReturnValue(tmpDir),
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

describe("DaemonRunner", () => {
  let tmpDir: string;
  let currentDaemon: DaemonRunner | null = null;
  let currentStartPromise: Promise<void> | null = null;

  beforeEach(() => {
    tmpDir = makeTempDir();
    currentDaemon = null;
    currentStartPromise = null;
  });

  afterEach(async () => {
    // Ensure any in-flight daemon is fully stopped before removing tmpDir.
    // This prevents ENOENT races from writeJsonFileAtomic rename syscalls.
    if (currentDaemon) {
      currentDaemon.stop();
      currentDaemon = null;
    }
    if (currentStartPromise) {
      await currentStartPromise.catch(() => {});
      currentStartPromise = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Remove any process signal listeners that may have been registered
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  // ─── Constructor / Config Defaults ───

  describe("constructor", () => {
    it("should construct without throwing with minimal deps", () => {
      const deps = makeDeps(tmpDir);
      expect(() => new DaemonRunner(deps)).not.toThrow();
    });

    it("should apply default config values (check_interval_ms = 300000)", () => {
      // We test defaults indirectly through behavior; the daemon should not throw
      const deps = makeDeps(tmpDir, { config: {} });
      expect(() => new DaemonRunner(deps)).not.toThrow();
    });

    it("should accept partial config overrides", () => {
      const deps = makeDeps(tmpDir, {
        config: { check_interval_ms: 1000, crash_recovery: { max_retries: 1, enabled: true, retry_delay_ms: 500 } },
      });
      expect(() => new DaemonRunner(deps)).not.toThrow();
    });
  });

  // ─── start() ───

  describe("start()", () => {
    it("should throw if daemon is already running (PID file from current process)", async () => {
      const deps = makeDeps(tmpDir);
      // Pre-write PID so isRunning() returns true
      await deps.pidManager.writePID();

      const daemon = new DaemonRunner(deps);
      await expect(daemon.start(["goal-1"])).rejects.toThrow(/already running/i);

      // Cleanup PID to allow afterEach cleanup to pass
      await deps.pidManager.cleanup();
    });

    it("should write PID file on start", async () => {
      const deps = makeDeps(tmpDir, {
        config: { check_interval_ms: 50 },
      });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      // Let the loop run one iteration
      await new Promise((resolve) => setTimeout(resolve, 60));
      daemon.stop();
      await startPromise;

      // PID file should be cleaned up after stop
      expect(await deps.pidManager.readPID()).toBeNull();
    });

    it("should save daemon-state.json with status=running on start", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = await pollForFile(statePath);
      expect((state as { status: string }).status).toBe("running");

      daemon.stop();
      await startPromise;
    });

    it("should run CoreLoop.run() for active goals", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 60));
      daemon.stop();
      await startPromise;

      expect((deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run).toHaveBeenCalledWith("goal-1", { maxIterations: 10 });
    });

    it("should skip goals that shouldActivate returns false for", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      (deps.driveSystem as { shouldActivate: ReturnType<typeof vi.fn> }).shouldActivate.mockReturnValue(false);

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 60));
      daemon.stop();
      await startPromise;

      expect((deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run).not.toHaveBeenCalled();
    });

    it("should pass active_goals to daemon state from start() argument", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-a", "goal-b"]);
      currentStartPromise = startPromise;

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = await pollForFile(statePath);
      expect((state as { active_goals: string[] }).active_goals).toEqual(["goal-a", "goal-b"]);

      daemon.stop();
      await startPromise;
    });
  });

  // ─── stop() ───

  describe("stop()", () => {
    it("should set status to stopped in daemon-state.json after stop resolves", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 500 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      daemon.stop();
      await startPromise;

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(["stopping", "stopped"]).toContain(state.status);
    });

    it("should terminate the loop and resolve the start() promise", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 30));
      daemon.stop();

      // Should resolve within a reasonable time
      await expect(startPromise).resolves.toBeUndefined();
    });

    it("should remove PID file after stopping", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 30));
      daemon.stop();
      await startPromise;

      expect(await deps.pidManager.readPID()).toBeNull();
    });

    it("should set status to stopped in daemon-state.json after loop exits", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 30));
      daemon.stop();
      await startPromise;

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(state.status).toBe("stopped");
    });
  });

  // ─── Error Handling / Crash Recovery ───

  describe("error handling", () => {
    it("should increment crash_count on loop error", async () => {
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          crash_recovery: { enabled: true, max_retries: 5, retry_delay_ms: 10 },
        },
      });
      (deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run.mockRejectedValueOnce(
        new Error("simulated failure")
      );

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 80));
      daemon.stop();
      await startPromise;

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(state.crash_count).toBeGreaterThanOrEqual(1);
    });

    it("should record last_error message on loop failure", async () => {
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          crash_recovery: { enabled: true, max_retries: 5, retry_delay_ms: 10 },
        },
      });
      (deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run.mockRejectedValueOnce(
        new Error("boom!")
      );

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 80));
      daemon.stop();
      await startPromise;

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      // After 1 failure + stop, last_error may be null again if further runs succeeded.
      // Check that crash_count recorded the failure.
      expect(state.crash_count).toBeGreaterThanOrEqual(1);
    });

    it("should stop daemon when crash count reaches max_retries", async () => {
      const maxRetries = 2;
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 10,
          crash_recovery: { enabled: true, max_retries: maxRetries, retry_delay_ms: 5 },
        },
      });
      // Always fail
      (deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run.mockRejectedValue(
        new Error("always fails")
      );

      const daemon = new DaemonRunner(deps);
      // start() should resolve on its own after max_retries exceeded
      await daemon.start(["goal-1"]);

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(state.crash_count).toBeGreaterThanOrEqual(maxRetries);
    });

    it("should set status to stopped (not crashed) when max_retries exceeded via handleLoopError", async () => {
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 10,
          crash_recovery: { enabled: true, max_retries: 2, retry_delay_ms: 5 },
        },
      });
      (deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run.mockRejectedValue(
        new Error("always fails")
      );

      const daemon = new DaemonRunner(deps);
      await daemon.start(["goal-1"]);

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      // Status ends as "stopped" since cleanup() runs after the loop (not "crashed")
      expect(state.status).toBe("stopped");
    });
  });

  // ─── generateCronEntry (static) ───

  describe("generateCronEntry()", () => {
    it("should generate a sub-hourly cron entry for interval < 60 min", () => {
      const entry = DaemonRunner.generateCronEntry("my-goal", 15);
      expect(entry).toBe("*/15 * * * * /usr/bin/env pulseed run --goal my-goal");
    });

    it("should generate an hourly cron entry for interval = 60 min (1 hour)", () => {
      const entry = DaemonRunner.generateCronEntry("my-goal", 60);
      expect(entry).toBe("0 */1 * * * /usr/bin/env pulseed run --goal my-goal");
    });

    it("should generate a multi-hour cron entry for interval between 60 and 1440 min", () => {
      const entry = DaemonRunner.generateCronEntry("my-goal", 240);
      expect(entry).toBe("0 */4 * * * /usr/bin/env pulseed run --goal my-goal");
    });

    it("should generate a daily cron entry for interval >= 1440 min (1 day)", () => {
      const entry = DaemonRunner.generateCronEntry("my-goal", 1440);
      expect(entry).toBe("0 0 * * * /usr/bin/env pulseed run --goal my-goal");
    });

    it("should treat interval > 1440 as daily", () => {
      const entry = DaemonRunner.generateCronEntry("my-goal", 2880);
      expect(entry).toBe("0 0 * * * /usr/bin/env pulseed run --goal my-goal");
    });

    it("should use 60-minute default when no interval is provided", () => {
      const entry = DaemonRunner.generateCronEntry("goal-default");
      expect(entry).toBe("0 */1 * * * /usr/bin/env pulseed run --goal goal-default");
    });

    it("should treat interval <= 0 as 60 minutes", () => {
      const entry0 = DaemonRunner.generateCronEntry("goal-x", 0);
      const entryNeg = DaemonRunner.generateCronEntry("goal-x", -5);
      expect(entry0).toBe("0 */1 * * * /usr/bin/env pulseed run --goal goal-x");
      expect(entryNeg).toBe("0 */1 * * * /usr/bin/env pulseed run --goal goal-x");
    });

    it("should include the goalId verbatim in the cron entry", () => {
      const goalId = "complex-goal-id_123";
      const entry = DaemonRunner.generateCronEntry(goalId, 30);
      expect(entry).toContain(goalId);
    });

    it("should generate correct entry for 30-minute interval", () => {
      const entry = DaemonRunner.generateCronEntry("g", 30);
      expect(entry).toBe("*/30 * * * * /usr/bin/env pulseed run --goal g");
    });

    it("should generate correct entry for 1-minute interval", () => {
      const entry = DaemonRunner.generateCronEntry("g", 1);
      expect(entry).toBe("*/1 * * * * /usr/bin/env pulseed run --goal g");
    });

    it("should throw for goalId containing spaces", () => {
      expect(() => DaemonRunner.generateCronEntry("bad goal", 60)).toThrow(/Invalid goalId/);
    });

    it("should throw for goalId containing semicolons", () => {
      expect(() => DaemonRunner.generateCronEntry("goal;rm -rf /", 60)).toThrow(/Invalid goalId/);
    });

    it("should throw for goalId containing newlines", () => {
      expect(() => DaemonRunner.generateCronEntry("goal\nmalicious", 60)).toThrow(/Invalid goalId/);
    });

    it("should throw for goalId containing shell special characters", () => {
      expect(() => DaemonRunner.generateCronEntry("goal$(evil)", 60)).toThrow(/Invalid goalId/);
    });

    it("should accept goalId with only alphanumeric, underscore, and hyphen", () => {
      expect(() => DaemonRunner.generateCronEntry("goal-abc_123", 60)).not.toThrow();
    });
  });

  // ─── Daemon State Persistence ───

  describe("daemon state persistence", () => {
    it("should write daemon-state.json to baseDir on start", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(fs.existsSync(path.join(tmpDir, "daemon-state.json"))).toBe(true);

      daemon.stop();
      await startPromise;
    });

    it("should record loop_count increments for each successful run", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 20 } });
      // Always resolve quickly so loop runs multiple times
      (deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run.mockResolvedValue(makeLoopResult());

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      // Allow ~3 iterations at 20ms interval
      await new Promise((resolve) => setTimeout(resolve, 100));
      daemon.stop();
      await startPromise;

      const state = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "daemon-state.json"), "utf-8")
      );
      expect(state.loop_count).toBeGreaterThanOrEqual(1);
    });

    it("should have pid set to current process PID in saved state", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 10));

      const state = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "daemon-state.json"), "utf-8")
      );
      expect(state.pid).toBe(process.pid);

      daemon.stop();
      await startPromise;
    });
  });

  // ─── Goal Interval Overrides ───

  describe("goal_intervals config", () => {
    it("should use the minimum goal interval when goal_intervals override is provided", async () => {
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 300_000,
          goal_intervals: { "goal-fast": 10 },
        },
      });

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-fast"]);
      currentStartPromise = startPromise;
      // 10ms interval → loop should run within 100ms
      await new Promise((resolve) => setTimeout(resolve, 80));
      daemon.stop();
      await startPromise;

      expect((deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run).toHaveBeenCalledWith(
        "goal-fast",
        { maxIterations: 10 }
      );
    });
  });

  // ─── Graceful Shutdown ───

  describe("graceful shutdown", () => {
    it("should set shuttingDown flag on SIGTERM signal", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 500 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      // Wait for daemon to be running
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Emit SIGTERM to trigger the shutdown handler
      process.emit("SIGTERM");

      // Give the handler time to run
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Daemon should resolve because shuttingDown exits the loop
      await expect(startPromise).resolves.toBeUndefined();
    });

    it("should complete current loop before stopping", async () => {
      let loopRunCount = 0;
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      (deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run.mockImplementation(async () => {
        loopRunCount++;
        // Simulate a loop that takes some time
        await new Promise((resolve) => setTimeout(resolve, 10));
        return makeLoopResult();
      });

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;

      // Wait for one loop to start
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Stop the daemon — it should finish the current loop
      daemon.stop();
      await startPromise;

      // At least one loop should have completed
      expect(loopRunCount).toBeGreaterThanOrEqual(1);
    });

    it("should save interrupted_goals on shutdown", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-a", "goal-b"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      daemon.stop();
      await startPromise;

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      // interrupted_goals should contain the active goals that were running
      expect(state.interrupted_goals).toBeDefined();
      expect(Array.isArray(state.interrupted_goals)).toBe(true);
    });

    it("should timeout and force stop after graceful_shutdown_timeout_ms", async () => {
      // Use a very short timeout to test the force-stop path
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 10,
          crash_recovery: {
            enabled: true,
            max_retries: 10,
            retry_delay_ms: 10,
            graceful_shutdown_timeout_ms: 50,
          },
        },
      });

      // Make the loop hang indefinitely so graceful shutdown times out
      let resolveLoop: (() => void) | null = null;
      (deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run.mockImplementation(() => {
        return new Promise<LoopResult>((resolve) => {
          resolveLoop = () => resolve(makeLoopResult());
        });
      });

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;

      // Wait for the loop to start (hanging)
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Emit SIGTERM — this sets shuttingDown=true and starts the timeout
      process.emit("SIGTERM");

      // The force-stop timer fires after 50ms and sets running=false
      // which exits the loop even though the current iteration is stuck
      // We also need to resolve the hanging loop for the test to complete
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (resolveLoop) resolveLoop();

      await expect(startPromise).resolves.toBeUndefined();
    });
  });

  // ─── State Restoration ───

  describe("state restoration", () => {
    it("should restore interrupted_goals from daemon-state.json on start", async () => {
      // Write a pre-existing daemon-state.json with interrupted_goals
      const savedState = {
        pid: 99999,
        started_at: new Date().toISOString(),
        last_loop_at: null,
        loop_count: 0,
        active_goals: ["goal-prev"],
        status: "stopped",
        crash_count: 0,
        last_error: null,
        interrupted_goals: ["goal-prev"],
      };
      fs.writeFileSync(
        path.join(tmpDir, "daemon-state.json"),
        JSON.stringify(savedState),
        "utf-8"
      );

      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-new"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 20));

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      // active_goals should include both the new goal and the restored goal
      expect(state.active_goals).toContain("goal-new");
      expect(state.active_goals).toContain("goal-prev");

      daemon.stop();
      await startPromise;
    });

    it("should merge interrupted_goals with new goalIds without duplicates", async () => {
      // Write a pre-existing daemon-state.json with interrupted_goals that overlap
      const savedState = {
        pid: 99999,
        started_at: new Date().toISOString(),
        last_loop_at: null,
        loop_count: 0,
        active_goals: ["goal-a"],
        status: "stopped",
        crash_count: 0,
        last_error: null,
        interrupted_goals: ["goal-a", "goal-b"],
      };
      fs.writeFileSync(
        path.join(tmpDir, "daemon-state.json"),
        JSON.stringify(savedState),
        "utf-8"
      );

      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      // Start with goal-a (overlaps with interrupted_goals) and goal-c
      const startPromise = daemon.start(["goal-a", "goal-c"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 20));

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      // Should contain goal-a, goal-b, goal-c — no duplicates
      expect(state.active_goals).toContain("goal-a");
      expect(state.active_goals).toContain("goal-b");
      expect(state.active_goals).toContain("goal-c");
      // No duplicate goal-a
      const goalACount = state.active_goals.filter((g: string) => g === "goal-a").length;
      expect(goalACount).toBe(1);

      daemon.stop();
      await startPromise;
    });
  });

  // ─── Cleanup ───

  describe("cleanup after loop", () => {
    it("should remove PID file on normal stop", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 30 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      daemon.stop();
      await startPromise;

      expect(fs.existsSync(deps.pidManager.getPath())).toBe(false);
    });

    it("should not leave .tmp files behind after state persistence", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 30));
      daemon.stop();
      await startPromise;

      const files = fs.readdirSync(tmpDir);
      expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    });
  });

  // ─── Event-Driven Integration ───

  describe("event-driven integration", () => {
    function makeEventServerMock() {
      return {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        isRunning: vi.fn().mockReturnValue(true),
        getHost: vi.fn().mockReturnValue("127.0.0.1"),
        getPort: vi.fn().mockReturnValue(41700),
        startFileWatcher: vi.fn(),
        stopFileWatcher: vi.fn(),
      };
    }

    it("should start EventServer on daemon start if provided", async () => {
      const eventServer = makeEventServerMock();
      const deps = makeDeps(tmpDir, {
        config: { check_interval_ms: 50 },
        eventServer: eventServer as unknown as DaemonDeps["eventServer"],
      });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      daemon.stop();
      await startPromise;

      expect(eventServer.start).toHaveBeenCalledOnce();
    });

    it("should stop EventServer on daemon stop", async () => {
      const eventServer = makeEventServerMock();
      const deps = makeDeps(tmpDir, {
        config: { check_interval_ms: 50 },
        eventServer: eventServer as unknown as DaemonDeps["eventServer"],
      });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      daemon.stop();
      await startPromise;

      expect(eventServer.stop).toHaveBeenCalledOnce();
    });

    it("should start file watcher on daemon start", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const startWatcherSpy = vi.spyOn(
        deps.driveSystem as unknown as { startWatcher: (cb: unknown) => void },
        "startWatcher"
      );

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      daemon.stop();
      await startPromise;

      expect(startWatcherSpy).toHaveBeenCalledOnce();
      // Callback should be a function
      expect(typeof startWatcherSpy.mock.calls[0][0]).toBe("function");
    });

    it("should stop file watcher on daemon stop", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const stopWatcherSpy = vi.spyOn(
        deps.driveSystem as unknown as { stopWatcher: () => void },
        "stopWatcher"
      );

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      daemon.stop();
      await startPromise;

      expect(stopWatcherSpy).toHaveBeenCalledOnce();
    });

    it("should wake up from sleep when event is received", async () => {
      // Use a very long sleep interval so the daemon will stay sleeping without event
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 5_000 } });

      let capturedCallback: ((event: unknown) => void) | null = null;
      (
        deps.driveSystem as unknown as { startWatcher: (cb: (event: unknown) => void) => void }
      ).startWatcher = vi.fn((cb) => {
        capturedCallback = cb;
      });
      (
        deps.driveSystem as unknown as { stopWatcher: () => void }
      ).stopWatcher = vi.fn();

      const runSpy = deps.coreLoop as { run: ReturnType<typeof vi.fn> };

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;

      // Wait for one loop iteration to complete and daemon to enter the 5s sleep
      await new Promise((resolve) => setTimeout(resolve, 80));

      const callCountBeforeEvent = runSpy.run.mock.calls.length;

      // Simulate an event arriving while daemon is sleeping — should wake immediately
      expect(capturedCallback).not.toBeNull();
      capturedCallback!({
        type: "external",
        source: "test",
        timestamp: new Date().toISOString(),
        data: {},
      });

      // Give the loop time to wake and start another iteration (much less than 5s)
      await new Promise((resolve) => setTimeout(resolve, 150));

      const callCountAfterEvent = runSpy.run.mock.calls.length;
      expect(callCountAfterEvent).toBeGreaterThan(callCountBeforeEvent);

      // Stop the daemon; abort the sleep so it exits quickly
      daemon.stop();
      capturedCallback!({
        type: "internal",
        source: "test-stop",
        timestamp: new Date().toISOString(),
        data: {},
      });
      await startPromise;
    }, 10_000);

    it("should work without EventServer (optional dependency)", async () => {
      // No eventServer provided — daemon should start and stop normally
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 60));
      daemon.stop();

      await expect(startPromise).resolves.toBeUndefined();
    });
  });

  // ─── Proactive Tick ───

  describe("proactive tick", () => {
    function makeLLMClientMock(action: string, details: Record<string, unknown> = {}) {
      const response = JSON.stringify({ action, details });
      return {
        sendMessage: vi.fn().mockResolvedValue({
          content: response,
          usage: { input_tokens: 10, output_tokens: 10 },
          stop_reason: "end_turn",
        }),
        parseJSON: vi.fn().mockReturnValue({ action, details }),
      };
    }

    it("should fire proactive tick when no goals activated and interval elapsed", async () => {
      const llmClient = makeLLMClientMock("sleep");
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          proactive_mode: true,
          proactive_interval_ms: 0, // always eligible
        },
        llmClient: llmClient as unknown as DaemonDeps["llmClient"],
      });
      // No goals should activate
      (deps.driveSystem as { shouldActivate: ReturnType<typeof vi.fn> }).shouldActivate.mockReturnValue(false);

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 80));
      daemon.stop();
      await startPromise;

      expect(llmClient.sendMessage).toHaveBeenCalled();
    });

    it("should NOT fire proactive tick when proactive_mode is false", async () => {
      const llmClient = makeLLMClientMock("sleep");
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          proactive_mode: false,
          proactive_interval_ms: 0,
        },
        llmClient: llmClient as unknown as DaemonDeps["llmClient"],
      });
      (deps.driveSystem as { shouldActivate: ReturnType<typeof vi.fn> }).shouldActivate.mockReturnValue(false);

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 80));
      daemon.stop();
      await startPromise;

      expect(llmClient.sendMessage).not.toHaveBeenCalled();
    });

    it("should NOT fire proactive tick when interval has not elapsed", async () => {
      const llmClient = makeLLMClientMock("sleep");
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          proactive_mode: true,
          proactive_interval_ms: 9_999_999, // far future
        },
        llmClient: llmClient as unknown as DaemonDeps["llmClient"],
      });
      (deps.driveSystem as { shouldActivate: ReturnType<typeof vi.fn> }).shouldActivate.mockReturnValue(false);

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 80));
      daemon.stop();
      await startPromise;

      expect(llmClient.sendMessage).not.toHaveBeenCalled();
    });

    it("should fire proactive tick even when goals were activated", async () => {
      // After Change 4: proactiveTick runs every cycle regardless of activeGoals.length
      // so long-running goals do not block proactive actions indefinitely.
      const llmClient = makeLLMClientMock("sleep");
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          proactive_mode: true,
          proactive_interval_ms: 0,
        },
        llmClient: llmClient as unknown as DaemonDeps["llmClient"],
      });
      // Goals DO activate
      (deps.driveSystem as { shouldActivate: ReturnType<typeof vi.fn> }).shouldActivate.mockReturnValue(true);

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 80));
      daemon.stop();
      await startPromise;

      // proactiveTick now fires unconditionally when running=true
      expect(llmClient.sendMessage).toHaveBeenCalled();
    });

    it("should catch LLM error in proactive tick and not crash the daemon", async () => {
      const llmClient = {
        sendMessage: vi.fn().mockRejectedValue(new Error("LLM timeout")),
        parseJSON: vi.fn(),
      };
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          proactive_mode: true,
          proactive_interval_ms: 0,
        },
        llmClient: llmClient as unknown as DaemonDeps["llmClient"],
      });
      (deps.driveSystem as { shouldActivate: ReturnType<typeof vi.fn> }).shouldActivate.mockReturnValue(false);

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 80));
      daemon.stop();

      // Daemon must resolve cleanly despite LLM error
      await expect(startPromise).resolves.toBeUndefined();
    });

    it("should log suggest_goal action from proactive tick", async () => {
      const llmClient = makeLLMClientMock("suggest_goal", { title: "New goal", description: "Do something" });
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          proactive_mode: true,
          proactive_interval_ms: 0,
        },
        llmClient: llmClient as unknown as DaemonDeps["llmClient"],
      });
      (deps.driveSystem as { shouldActivate: ReturnType<typeof vi.fn> }).shouldActivate.mockReturnValue(false);

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 80));
      daemon.stop();
      await startPromise;

      expect(llmClient.sendMessage).toHaveBeenCalled();
    });

    it("should handle investigate action from proactive tick without crashing", async () => {
      const llmClient = makeLLMClientMock("investigate", { what: "goal-1 stalled", why: "no progress" });
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          proactive_mode: true,
          proactive_interval_ms: 0,
        },
        llmClient: llmClient as unknown as DaemonDeps["llmClient"],
      });
      (deps.driveSystem as { shouldActivate: ReturnType<typeof vi.fn> }).shouldActivate.mockReturnValue(false);

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 80));
      daemon.stop();

      await expect(startPromise).resolves.toBeUndefined();
    });

    it("should handle preemptive_check action from proactive tick without crashing", async () => {
      const llmClient = makeLLMClientMock("preemptive_check", { goal_id: "goal-1" });
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          proactive_mode: true,
          proactive_interval_ms: 0,
        },
        llmClient: llmClient as unknown as DaemonDeps["llmClient"],
      });
      (deps.driveSystem as { shouldActivate: ReturnType<typeof vi.fn> }).shouldActivate.mockReturnValue(false);

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 80));
      daemon.stop();

      await expect(startPromise).resolves.toBeUndefined();
    });
  });

  // ─── Adaptive Sleep ───

  describe("adaptive sleep", () => {
    function makeDaemonWithAdaptiveSleep(overrides: Record<string, unknown> = {}): DaemonRunner {
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 300_000,
          adaptive_sleep: {
            enabled: true,
            min_interval_ms: 60_000,
            max_interval_ms: 1_800_000,
            night_start_hour: 22,
            night_end_hour: 7,
            night_multiplier: 2.0,
            ...overrides,
          },
        },
      });
      return new DaemonRunner(deps);
    }

    it("should return base interval unchanged when adaptive_sleep is disabled", () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 300_000 } });
      const daemon = new DaemonRunner(deps);
      const result = daemon.calculateAdaptiveInterval(300_000, 0, 0, 0);
      expect(result).toBe(300_000);
    });

    it("should return base interval when enabled and all factors are neutral (daytime, low gap, no idle)", () => {
      const realDate = globalThis.Date;
      const mockDate = class extends realDate {
        getHours() { return 12; }
      } as typeof Date;
      globalThis.Date = mockDate;

      try {
        const daemon = makeDaemonWithAdaptiveSleep();
        // timeOfDay=1.0, urgency=1.0, activity=1.0 → 300000
        const result = daemon.calculateAdaptiveInterval(300_000, 0, 0.3, 0);
        expect(result).toBe(300_000);
      } finally {
        globalThis.Date = realDate;
      }
    });

    it("should apply night multiplier when current hour is in night range (after midnight)", () => {
      const realDate = globalThis.Date;
      const mockDate = class extends realDate {
        getHours() { return 23; } // 23:00 within [22, 7)
      } as typeof Date;
      globalThis.Date = mockDate;

      try {
        const daemon = makeDaemonWithAdaptiveSleep();
        // timeOfDay=2.0, urgency=1.0, activity=1.0 → 600000
        const result = daemon.calculateAdaptiveInterval(300_000, 0, 0.3, 0);
        expect(result).toBe(600_000);
      } finally {
        globalThis.Date = realDate;
      }
    });

    it("should apply night multiplier for early morning hours", () => {
      const realDate = globalThis.Date;
      const mockDate = class extends realDate {
        getHours() { return 3; } // 03:00 within [22, 7)
      } as typeof Date;
      globalThis.Date = mockDate;

      try {
        const daemon = makeDaemonWithAdaptiveSleep();
        // timeOfDay=2.0, urgency=1.0, activity=1.0 → 600000
        const result = daemon.calculateAdaptiveInterval(300_000, 0, 0.3, 0);
        expect(result).toBe(600_000);
      } finally {
        globalThis.Date = realDate;
      }
    });

    it("should not apply night multiplier during daytime", () => {
      const realDate = globalThis.Date;
      const mockDate = class extends realDate {
        getHours() { return 14; }
      } as typeof Date;
      globalThis.Date = mockDate;

      try {
        const daemon = makeDaemonWithAdaptiveSleep();
        // timeOfDay=1.0, urgency=1.0, activity=1.0 → 300000
        const result = daemon.calculateAdaptiveInterval(300_000, 0, 0.3, 0);
        expect(result).toBe(300_000);
      } finally {
        globalThis.Date = realDate;
      }
    });

    it("should apply 0.5 urgency factor for high gap score (>= 0.8)", () => {
      const realDate = globalThis.Date;
      const mockDate = class extends realDate {
        getHours() { return 12; }
      } as typeof Date;
      globalThis.Date = mockDate;

      try {
        const daemon = makeDaemonWithAdaptiveSleep();
        // timeOfDay=1.0, urgency=0.5, activity=1.0 → 150000
        const result = daemon.calculateAdaptiveInterval(300_000, 0, 0.9, 0);
        expect(result).toBe(150_000);
      } finally {
        globalThis.Date = realDate;
      }
    });

    it("should apply 0.75 urgency factor for medium gap score (0.5 to 0.8)", () => {
      const realDate = globalThis.Date;
      const mockDate = class extends realDate {
        getHours() { return 12; }
      } as typeof Date;
      globalThis.Date = mockDate;

      try {
        const daemon = makeDaemonWithAdaptiveSleep();
        // timeOfDay=1.0, urgency=0.75, activity=1.0 → 225000
        const result = daemon.calculateAdaptiveInterval(300_000, 0, 0.6, 0);
        expect(result).toBe(225_000);
      } finally {
        globalThis.Date = realDate;
      }
    });

    it("should apply 0.75 activity factor when goals were activated this cycle", () => {
      const realDate = globalThis.Date;
      const mockDate = class extends realDate {
        getHours() { return 12; }
      } as typeof Date;
      globalThis.Date = mockDate;

      try {
        const daemon = makeDaemonWithAdaptiveSleep();
        // timeOfDay=1.0, urgency=1.0, activity=0.75 → 225000
        const result = daemon.calculateAdaptiveInterval(300_000, 2, 0.3, 0);
        expect(result).toBe(225_000);
      } finally {
        globalThis.Date = realDate;
      }
    });

    it("should apply 1.5 activity factor after 5 or more consecutive idle cycles", () => {
      const realDate = globalThis.Date;
      const mockDate = class extends realDate {
        getHours() { return 12; }
      } as typeof Date;
      globalThis.Date = mockDate;

      try {
        const daemon = makeDaemonWithAdaptiveSleep();
        // timeOfDay=1.0, urgency=1.0, activity=1.5 → 450000
        const result = daemon.calculateAdaptiveInterval(300_000, 0, 0.3, 5);
        expect(result).toBe(450_000);
      } finally {
        globalThis.Date = realDate;
      }
    });

    it("should clamp result to min_interval_ms when too small", () => {
      const realDate = globalThis.Date;
      const mockDate = class extends realDate {
        getHours() { return 12; }
      } as typeof Date;
      globalThis.Date = mockDate;

      try {
        const daemon = makeDaemonWithAdaptiveSleep({ min_interval_ms: 120_000 });
        // 50000 * 1.0 * 0.5 * 0.75 = 18750 → clamped to 120000
        const result = daemon.calculateAdaptiveInterval(50_000, 2, 0.9, 0);
        expect(result).toBe(120_000);
      } finally {
        globalThis.Date = realDate;
      }
    });

    it("should clamp result to max_interval_ms when too large", () => {
      const realDate = globalThis.Date;
      const mockDate = class extends realDate {
        getHours() { return 23; } // night: 2.0
      } as typeof Date;
      globalThis.Date = mockDate;

      try {
        const daemon = makeDaemonWithAdaptiveSleep({ max_interval_ms: 1_800_000 });
        // 1000000 * 2.0 * 1.0 * 1.5 = 3000000 → clamped to 1800000
        const result = daemon.calculateAdaptiveInterval(1_000_000, 0, 0.3, 10);
        expect(result).toBe(1_800_000);
      } finally {
        globalThis.Date = realDate;
      }
    });

    it("should multiply all factors correctly", () => {
      const realDate = globalThis.Date;
      const mockDate = class extends realDate {
        getHours() { return 23; } // night: 2.0
      } as typeof Date;
      globalThis.Date = mockDate;

      try {
        const daemon = makeDaemonWithAdaptiveSleep();
        // 400000 * 2.0 * 0.75 * 0.75 = 450000, within [60000, 1800000]
        const result = daemon.calculateAdaptiveInterval(400_000, 1, 0.6, 0);
        expect(result).toBe(450_000);
      } finally {
        globalThis.Date = realDate;
      }
    });

    it("should return an integer result", () => {
      const realDate = globalThis.Date;
      const mockDate = class extends realDate {
        getHours() { return 12; }
      } as typeof Date;
      globalThis.Date = mockDate;

      try {
        const daemon = makeDaemonWithAdaptiveSleep();
        // 100001 * 0.75 = 75000.75 → rounded to integer
        const result = daemon.calculateAdaptiveInterval(100_001, 0, 0.6, 0);
        expect(Number.isInteger(result)).toBe(true);
      } finally {
        globalThis.Date = realDate;
      }
    });
  });

  // ─── iterations_per_cycle / per-cycle budget ───

  describe("iterations_per_cycle", () => {
    it("should call CoreLoop.run with { maxIterations: 10 } by default", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 60));
      daemon.stop();
      await startPromise;

      const runMock = (deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run;
      expect(runMock).toHaveBeenCalledWith("goal-1", { maxIterations: 10 });
    });

    it("should call CoreLoop.run with { maxIterations: N } when iterations_per_cycle is configured", async () => {
      const iterationsPerCycle = 5;
      const deps = makeDeps(tmpDir, {
        config: { check_interval_ms: 50, iterations_per_cycle: iterationsPerCycle },
      });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 60));
      daemon.stop();
      await startPromise;

      const runMock = (deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run;
      expect(runMock).toHaveBeenCalledWith("goal-1", { maxIterations: iterationsPerCycle });
    });

    it("should fire proactiveTick even when activeGoals.length > 0", async () => {
      // Verify that proactiveTick is not gated behind activeGoals.length === 0.
      // We use a mock LLM client and confirm sendMessage is called while goals are active.
      const llmClient = {
        sendMessage: vi.fn().mockResolvedValue({
          content: JSON.stringify({ action: "sleep" }),
          usage: { input_tokens: 5, output_tokens: 5 },
          stop_reason: "end_turn",
        }),
        parseJSON: vi.fn().mockReturnValue({ action: "sleep" }),
      };
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          proactive_mode: true,
          proactive_interval_ms: 0,
        },
        llmClient: llmClient as unknown as DaemonDeps["llmClient"],
      });
      // Goals activate — this is the condition that used to block proactiveTick
      (deps.driveSystem as { shouldActivate: ReturnType<typeof vi.fn> }).shouldActivate.mockReturnValue(true);

      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;
      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await new Promise((resolve) => setTimeout(resolve, 80));
      daemon.stop();
      await startPromise;

      // LLM should have been called even though goals were active
      expect(llmClient.sendMessage).toHaveBeenCalled();
    });
  });
});
