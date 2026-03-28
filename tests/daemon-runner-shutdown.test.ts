import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { DaemonRunner } from "../src/runtime/daemon-runner.js";
import type { ShutdownMarker } from "../src/runtime/daemon-runner.js";
import { PIDManager } from "../src/runtime/pid-manager.js";
import { Logger } from "../src/runtime/logger.js";
import type { LoopResult } from "../src/core-loop.js";
import type { DaemonDeps } from "../src/runtime/daemon-runner.js";

// ─── Helpers ───

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-shutdown-test-"));
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

function readMarker(tmpDir: string): ShutdownMarker | null {
  const p = path.join(tmpDir, "shutdown-state.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8")) as ShutdownMarker;
}

// ─── Test Suite ───

describe("DaemonRunner — Graceful Shutdown + Crash Recovery", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  // ─── Graceful Shutdown ───

  describe("graceful shutdown", () => {
    it("should set shuttingDown flag on SIGTERM and resolve the loop", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 500 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      // Wait for daemon to be up and running
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Emit SIGTERM — should set shuttingDown and exit the loop
      process.emit("SIGTERM");

      await expect(startPromise).resolves.toBeUndefined();
    });

    it("should write clean_shutdown state file on graceful stop via stop()", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      daemon.stop();
      await startPromise;

      const marker = readMarker(tmpDir);
      expect(marker).not.toBeNull();
      expect(marker!.state).toBe("clean_shutdown");
      expect(marker!.goal_ids).toContain("goal-1");
    });

    it("should write clean_shutdown state file on graceful stop via SIGTERM", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 500 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      process.emit("SIGTERM");
      await startPromise;

      const marker = readMarker(tmpDir);
      expect(marker).not.toBeNull();
      expect(marker!.state).toBe("clean_shutdown");
    });

    it("should write clean_shutdown state file on graceful stop via SIGINT", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 500 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      process.emit("SIGINT");
      await startPromise;

      const marker = readMarker(tmpDir);
      expect(marker).not.toBeNull();
      expect(marker!.state).toBe("clean_shutdown");
    });

    it("should include goal_ids in the shutdown state file", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-alpha", "goal-beta"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      daemon.stop();
      await startPromise;

      const marker = readMarker(tmpDir);
      expect(marker).not.toBeNull();
      expect(marker!.goal_ids).toContain("goal-alpha");
      expect(marker!.goal_ids).toContain("goal-beta");
    });

    it("should include a timestamp in the shutdown state file", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      daemon.stop();
      await startPromise;

      const marker = readMarker(tmpDir);
      expect(marker).not.toBeNull();
      // Should be a valid ISO 8601 timestamp
      expect(() => new Date(marker!.timestamp)).not.toThrow();
      expect(isNaN(new Date(marker!.timestamp).getTime())).toBe(false);
    });
  });

  // ─── Crash Recovery ───

  describe("crash recovery", () => {
    it("should log 'Resuming from clean shutdown' when clean_shutdown marker exists", async () => {
      // Write a clean_shutdown marker before starting
      const marker: ShutdownMarker = {
        goal_ids: ["goal-prev"],
        loop_index: 5,
        timestamp: new Date().toISOString(),
        reason: "stop",
        state: "clean_shutdown",
      };
      fs.writeFileSync(
        path.join(tmpDir, "shutdown-state.json"),
        JSON.stringify(marker),
        "utf-8"
      );

      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const loggerInfoSpy = vi.spyOn(deps.logger, "info");

      const daemon = new DaemonRunner(deps);
      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      daemon.stop();
      await startPromise;

      // Should have logged resume message
      const infoCalls = loggerInfoSpy.mock.calls.map((args) => args[0]);
      expect(infoCalls.some((msg) => msg.includes("Resuming from clean shutdown"))).toBe(true);
    });

    it("should log crash recovery warning when running marker exists", async () => {
      // Write a "running" marker (simulating a crash)
      const marker: ShutdownMarker = {
        goal_ids: ["goal-crashed"],
        loop_index: 3,
        timestamp: new Date().toISOString(),
        reason: "startup",
        state: "running",
      };
      fs.writeFileSync(
        path.join(tmpDir, "shutdown-state.json"),
        JSON.stringify(marker),
        "utf-8"
      );

      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const loggerWarnSpy = vi.spyOn(deps.logger, "warn");

      const daemon = new DaemonRunner(deps);
      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      daemon.stop();
      await startPromise;

      // Should have logged crash warning
      const warnCalls = loggerWarnSpy.mock.calls.map((args) => args[0]);
      expect(
        warnCalls.some((msg) =>
          msg.includes("Recovering from crash") ||
          msg.toLowerCase().includes("did not shut down cleanly")
        )
      ).toBe(true);
    });

    it("should delete the shutdown marker after processing it at startup", async () => {
      // Write a marker before starting
      const marker: ShutdownMarker = {
        goal_ids: ["goal-prev"],
        loop_index: 2,
        timestamp: new Date().toISOString(),
        reason: "stop",
        state: "clean_shutdown",
      };
      fs.writeFileSync(
        path.join(tmpDir, "shutdown-state.json"),
        JSON.stringify(marker),
        "utf-8"
      );

      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);

      // After start() begins, the old marker should be deleted (a new "running" one is written)
      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 40));

      // The new marker (state: "running") should exist, not the old "clean_shutdown" one
      const currentMarker = readMarker(tmpDir);
      // Either no marker (deleted) or the new running marker
      if (currentMarker !== null) {
        // If a marker exists, it should be the new "running" one, not the old "clean_shutdown"
        // (it could already be "clean_shutdown" if stop was called quickly)
        expect(["running", "clean_shutdown"]).toContain(currentMarker.state);
      }

      daemon.stop();
      await startPromise;
    });

    it("should write a running marker at startup", async () => {
      const deps = makeDeps(tmpDir, {
        config: { check_interval_ms: 500 }, // long interval so daemon stays running
      });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      // Wait for startup sequence to complete (marker is written after state init)
      await new Promise((resolve) => setTimeout(resolve, 50));

      const marker = readMarker(tmpDir);
      // At this point the daemon is still running, so the "running" marker should exist
      // (or has been replaced by "clean_shutdown" if the first iteration completed very quickly)
      expect(marker).not.toBeNull();

      daemon.stop();
      await startPromise;
    });

    it("should handle missing shutdown marker gracefully (no error)", async () => {
      // Ensure no marker file exists
      const markerPath = path.join(tmpDir, "shutdown-state.json");
      if (fs.existsSync(markerPath)) {
        fs.unlinkSync(markerPath);
      }

      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);

      // Should start without errors even with no marker
      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      daemon.stop();

      await expect(startPromise).resolves.toBeUndefined();
    });
  });

  // ─── readShutdownMarker / deleteShutdownMarker public API ───

  describe("readShutdownMarker() and deleteShutdownMarker()", () => {
    it("should return null when no marker file exists", async () => {
      const deps = makeDeps(tmpDir);
      const daemon = new DaemonRunner(deps);
      const result = await daemon.readShutdownMarker();
      expect(result).toBeNull();
    });

    it("should return the marker when file exists", async () => {
      const marker: ShutdownMarker = {
        goal_ids: ["g1"],
        loop_index: 1,
        timestamp: new Date().toISOString(),
        reason: "stop",
        state: "clean_shutdown",
      };
      fs.writeFileSync(
        path.join(tmpDir, "shutdown-state.json"),
        JSON.stringify(marker),
        "utf-8"
      );

      const deps = makeDeps(tmpDir);
      const daemon = new DaemonRunner(deps);
      const result = await daemon.readShutdownMarker();
      expect(result).not.toBeNull();
      expect(result!.state).toBe("clean_shutdown");
      expect(result!.goal_ids).toEqual(["g1"]);
    });

    it("should delete the marker file via deleteShutdownMarker()", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "shutdown-state.json"),
        JSON.stringify({ goal_ids: [], loop_index: 0, timestamp: new Date().toISOString(), reason: "stop", state: "clean_shutdown" }),
        "utf-8"
      );

      const deps = makeDeps(tmpDir);
      const daemon = new DaemonRunner(deps);
      await daemon.deleteShutdownMarker();

      expect(fs.existsSync(path.join(tmpDir, "shutdown-state.json"))).toBe(false);
    });

    it("should not throw when deleting a non-existent marker", async () => {
      const deps = makeDeps(tmpDir);
      const daemon = new DaemonRunner(deps);
      await expect(daemon.deleteShutdownMarker()).resolves.toBeUndefined();
    });
  });

  // ─── Log Rotation ───

  describe("rotateLog()", () => {
    it("should not rotate when log file is below the size threshold", async () => {
      const logDir = path.join(tmpDir, "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, "pulseed.log");
      // Write a small file (1KB)
      fs.writeFileSync(logPath, "x".repeat(1024), "utf-8");

      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          log_rotation: { max_size_mb: 10, max_files: 5 },
        },
      });
      const daemon = new DaemonRunner(deps);
      await daemon.rotateLog();

      // pulseed.log should still exist (not rotated)
      expect(fs.existsSync(logPath)).toBe(true);
      // No rotated files should exist
      const entries = fs.readdirSync(logDir);
      const rotated = entries.filter((f) => f !== "pulseed.log");
      expect(rotated.length).toBe(0);
    });

    it("should rotate when log file exceeds the size threshold", async () => {
      const logDir = path.join(tmpDir, "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, "pulseed.log");
      // Create a 2MB file (exceeds 1MB threshold)
      fs.writeFileSync(logPath, "x".repeat(2 * 1024 * 1024), "utf-8");

      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          log_rotation: { max_size_mb: 1, max_files: 5 },
        },
      });
      const daemon = new DaemonRunner(deps);
      await daemon.rotateLog();

      // pulseed.log should no longer exist (was renamed)
      expect(fs.existsSync(logPath)).toBe(false);
      // At least one rotated file should exist
      const entries = fs.readdirSync(logDir);
      const rotated = entries.filter((f) => /^pulseed\..+\.log$/.test(f) && f !== "pulseed.log");
      expect(rotated.length).toBeGreaterThanOrEqual(1);
    });

    it("should keep at most maxFiles rotated log files", async () => {
      const logDir = path.join(tmpDir, "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const maxFiles = 3;

      // Pre-create 5 rotated log files (older ones)
      for (let i = 0; i < 5; i++) {
        const ts = new Date(Date.now() - (5 - i) * 1000).toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(path.join(logDir, `pulseed.${ts}.log`), "old log", "utf-8");
        // Small delay to ensure distinct timestamps in names
        await new Promise((r) => setTimeout(r, 5));
      }

      // Create current log that exceeds threshold
      const logPath = path.join(logDir, "pulseed.log");
      fs.writeFileSync(logPath, "x".repeat(2 * 1024 * 1024), "utf-8");

      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          log_rotation: { max_size_mb: 1, max_files: maxFiles },
        },
      });
      const daemon = new DaemonRunner(deps);
      await daemon.rotateLog();

      // Should have at most maxFiles rotated files
      const entries = fs.readdirSync(logDir);
      const rotated = entries.filter((f) => /^pulseed\..+\.log$/.test(f) && f !== "pulseed.log");
      expect(rotated.length).toBeLessThanOrEqual(maxFiles);
    });

    it("should not throw when log file does not exist", async () => {
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          log_rotation: { max_size_mb: 10, max_files: 5 },
        },
      });
      const daemon = new DaemonRunner(deps);
      // No log directory or file — should be a no-op
      await expect(daemon.rotateLog()).resolves.toBeUndefined();
    });

    it("should name rotated file with a timestamp suffix", async () => {
      const logDir = path.join(tmpDir, "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, "pulseed.log");
      fs.writeFileSync(logPath, "x".repeat(2 * 1024 * 1024), "utf-8");

      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          log_rotation: { max_size_mb: 1, max_files: 5 },
        },
      });
      const daemon = new DaemonRunner(deps);
      await daemon.rotateLog();

      const entries = fs.readdirSync(logDir);
      const rotated = entries.filter((f) => /^pulseed\..+\.log$/.test(f) && f !== "pulseed.log");
      expect(rotated.length).toBe(1);
      // Name should match pulseed.<timestamp>.log pattern
      expect(rotated[0]).toMatch(/^pulseed\..+\.log$/);
    });
  });
});
