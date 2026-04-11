import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import { PIDManager } from "../pid-manager.js";
import { RuntimeWatchdog } from "../watchdog.js";
import { RuntimeHealthStore } from "../store/index.js";
import { LeaderLockManager } from "../leader-lock-manager.js";

class FakeChildProcess extends EventEmitter {
  readonly kills: Array<NodeJS.Signals | number | undefined> = [];

  constructor(public readonly pid: number) {
    super();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    queueMicrotask(() => {
      this.emit("exit", signal === "SIGKILL" ? 137 : 0, typeof signal === "string" ? signal : null);
    });
    return true;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

async function writeLeaderRecord(runtimeRoot: string, pid: number, leaseUntil: number): Promise<void> {
  const leaderPath = path.join(runtimeRoot, "leader", "leader.json");
  await fsp.mkdir(path.dirname(leaderPath), { recursive: true });
  await fsp.writeFile(
    leaderPath,
    JSON.stringify({
      owner_token: `owner-${pid}`,
      pid,
      acquired_at: Date.now(),
      last_renewed_at: Date.now(),
      lease_until: leaseUntil,
    }),
    "utf-8"
  );
}

describe("RuntimeWatchdog", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      cleanupTempDir(tmpDir);
    }
  });

  it("restarts the child when the daemon heartbeat goes stale", async () => {
    tmpDir = makeTempDir();
    const runtimeRoot = path.join(tmpDir, "runtime");
    const pidManager = new PIDManager(tmpDir);
    const healthStore = new RuntimeHealthStore(runtimeRoot);
    const leaderLockManager = new LeaderLockManager(runtimeRoot, 60);
    await healthStore.ensureReady();

    const children: FakeChildProcess[] = [];
    const watchdog = new RuntimeWatchdog({
      pidManager,
      healthStore,
      leaderLockManager,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      startChild: () => {
        const child = new FakeChildProcess(10_000 + children.length);
        children.push(child);
        return child;
      },
      pollIntervalMs: 20,
      heartbeatTimeoutMs: 50,
      startupGraceMs: 40,
      restartBackoffMs: 10,
      maxRestartBackoffMs: 20,
      childShutdownGraceMs: 10,
    });

    const startPromise = watchdog.start();

    await waitFor(() => children.length === 1);
    await writeLeaderRecord(runtimeRoot, children[0]!.pid, Date.now() + 100);
    await healthStore.saveDaemonHealth({
      status: "ok",
      leader: true,
      checked_at: Date.now(),
      kpi: {
        process_alive: { status: "ok", checked_at: Date.now(), last_ok_at: Date.now() },
        command_acceptance: { status: "degraded", checked_at: Date.now(), last_degraded_at: Date.now() },
        task_execution: { status: "degraded", checked_at: Date.now(), last_degraded_at: Date.now() },
      },
      details: { pid: children[0]!.pid },
    });

    await waitFor(() => children.length === 2, 2_000, 20);
    expect(children[0]!.kills).toContain("SIGTERM");

    await writeLeaderRecord(runtimeRoot, children[1]!.pid, Date.now() + 100);
    await healthStore.saveDaemonHealth({
      status: "ok",
      leader: true,
      checked_at: Date.now(),
      kpi: {
        process_alive: { status: "ok", checked_at: Date.now(), last_ok_at: Date.now() },
        command_acceptance: { status: "ok", checked_at: Date.now(), last_ok_at: Date.now() },
        task_execution: { status: "ok", checked_at: Date.now(), last_ok_at: Date.now() },
      },
      details: { pid: children[1]!.pid },
    });

    watchdog.stop();
    await startPromise;

    expect(fs.existsSync(pidManager.getPath())).toBe(false);
    expect(children[1]!.kills).toContain("SIGTERM");
  });

  it("updates the pid file to the current runtime child across restarts", async () => {
    tmpDir = makeTempDir();
    const runtimeRoot = path.join(tmpDir, "runtime");
    const pidManager = new PIDManager(tmpDir);
    const healthStore = new RuntimeHealthStore(runtimeRoot);
    const leaderLockManager = new LeaderLockManager(runtimeRoot, 60);
    await healthStore.ensureReady();

    const children: FakeChildProcess[] = [];
    const watchdog = new RuntimeWatchdog({
      pidManager,
      healthStore,
      leaderLockManager,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      startChild: () => {
        const child = new FakeChildProcess(20_000 + children.length);
        children.push(child);
        return child;
      },
      pollIntervalMs: 20,
      heartbeatTimeoutMs: 50,
      startupGraceMs: 40,
      restartBackoffMs: 10,
      maxRestartBackoffMs: 20,
      childShutdownGraceMs: 10,
    });

    const startPromise = watchdog.start();

    await waitFor(() => children.length === 1);
    await waitFor(async () => {
      const info = await pidManager.readPID();
      return info?.pid === children[0]!.pid;
    }, 2_000, 20);
    const firstInfo = await pidManager.readPID();
    expect(firstInfo).toMatchObject({
      pid: children[0]!.pid,
      runtime_pid: children[0]!.pid,
      owner_pid: process.pid,
      watchdog_pid: process.pid,
    });

    await writeLeaderRecord(runtimeRoot, children[0]!.pid, Date.now() + 100);
    await healthStore.saveDaemonHealth({
      status: "ok",
      leader: true,
      checked_at: Date.now(),
      kpi: {
        process_alive: { status: "ok", checked_at: Date.now(), last_ok_at: Date.now() },
        command_acceptance: { status: "degraded", checked_at: Date.now(), last_degraded_at: Date.now() },
        task_execution: { status: "degraded", checked_at: Date.now(), last_degraded_at: Date.now() },
      },
      details: { pid: children[0]!.pid },
    });

    await waitFor(() => children.length === 2, 2_000, 20);
    await waitFor(async () => {
      const info = await pidManager.readPID();
      return info?.pid === children[1]!.pid;
    }, 2_000, 20);
    const secondInfo = await pidManager.readPID();
    expect(secondInfo).toMatchObject({
      pid: children[1]!.pid,
      runtime_pid: children[1]!.pid,
      owner_pid: process.pid,
      watchdog_pid: process.pid,
    });

    watchdog.stop();
    await startPromise;
  });

  it("restarts the child when the live daemon health probe fails repeatedly", async () => {
    vi.useFakeTimers();
    try {
      tmpDir = makeTempDir();
      const runtimeRoot = path.join(tmpDir, "runtime");
      const pidManager = new PIDManager(tmpDir);
      const healthStore = new RuntimeHealthStore(runtimeRoot);
      const leaderLockManager = new LeaderLockManager(runtimeRoot, 60);
      await healthStore.ensureReady();

      const children: FakeChildProcess[] = [];
      const healthProbe = vi.fn().mockResolvedValue({ ok: false, detail: "ECONNREFUSED" });
      const watchdog = new RuntimeWatchdog({
        pidManager,
        healthStore,
        leaderLockManager,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        startChild: () => {
          const child = new FakeChildProcess(30_000 + children.length);
          children.push(child);
          return child;
        },
        healthProbe,
        healthProbeFailureThreshold: 2,
        pollIntervalMs: 20,
        heartbeatTimeoutMs: 200,
        startupGraceMs: 40,
        restartBackoffMs: 10,
        maxRestartBackoffMs: 20,
        childShutdownGraceMs: 10,
      });

      const startPromise = watchdog.start();

      await vi.waitFor(() => {
        expect(children.length).toBe(1);
      });
      await writeLeaderRecord(runtimeRoot, children[0]!.pid, Date.now() + 500);
      await healthStore.saveDaemonHealth({
        status: "ok",
        leader: true,
        checked_at: Date.now(),
        kpi: {
          process_alive: { status: "ok", checked_at: Date.now(), last_ok_at: Date.now() },
          command_acceptance: { status: "ok", checked_at: Date.now(), last_ok_at: Date.now() },
          task_execution: { status: "ok", checked_at: Date.now(), last_ok_at: Date.now() },
        },
        details: { pid: children[0]!.pid },
      });

      await vi.advanceTimersByTimeAsync(120);
      await vi.waitFor(() => {
        expect(children.length).toBe(2);
      });
      watchdog.stop();
      for (const child of children) {
        child.kill("SIGTERM");
      }
      await vi.runOnlyPendingTimersAsync();
      await startPromise;

      expect(children[0]!.kills).toContain("SIGTERM");
      expect(healthProbe.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it("opens the circuit breaker instead of restarting forever during a restart storm", async () => {
    tmpDir = makeTempDir();
    const runtimeRoot = path.join(tmpDir, "runtime");
    const pidManager = new PIDManager(tmpDir);
    const healthStore = new RuntimeHealthStore(runtimeRoot);
    const leaderLockManager = new LeaderLockManager(runtimeRoot, 60);
    await healthStore.ensureReady();

    const children: FakeChildProcess[] = [];
    const onCircuitOpen = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const watchdog = new RuntimeWatchdog({
      pidManager,
      healthStore,
      leaderLockManager,
      logger,
      startChild: () => {
        const child = new FakeChildProcess(40_000 + children.length);
        children.push(child);
        queueMicrotask(() => child.emit("exit", 1, null));
        return child;
      },
      pollIntervalMs: 20,
      heartbeatTimeoutMs: 50,
      startupGraceMs: 0,
      restartBackoffMs: 1,
      maxRestartBackoffMs: 1,
      childShutdownGraceMs: 1,
      restartStormWindowMs: 1_000,
      maxUnhealthyRestartsInWindow: 2,
      onCircuitOpen,
    });

    await watchdog.start();

    expect(children).toHaveLength(2);
    expect(onCircuitOpen).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      "Watchdog circuit breaker opened after restart storm",
      expect.objectContaining({ restartCount: 2 })
    );
    expect(await healthStore.loadDaemonHealth()).toEqual(
      expect.objectContaining({
        status: "failed",
        leader: false,
        details: expect.objectContaining({ circuit_reason: "watchdog_circuit_open" }),
      })
    );
    expect(fs.existsSync(pidManager.getPath())).toBe(false);
  });
});
