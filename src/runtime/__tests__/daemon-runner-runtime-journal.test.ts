import * as http from "node:http";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonRunner } from "../daemon-runner.js";
import { PIDManager } from "../pid-manager.js";
import { Logger } from "../logger.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

function makeDeps(tmpDir: string, writeEventImpl: (event: unknown) => Promise<void>) {
  const mockCoreLoop = {
    run: vi.fn().mockResolvedValue({
      goalId: "goal-1",
      totalIterations: 1,
      finalStatus: "completed",
      iterations: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }),
    stop: vi.fn(),
  };

  const mockDriveSystem = {
    shouldActivate: vi.fn().mockReturnValue(false),
    getSchedule: vi.fn().mockResolvedValue(null),
    prioritizeGoals: vi.fn().mockImplementation((ids: string[]) => ids),
    startWatcher: vi.fn(),
    stopWatcher: vi.fn(),
    writeEvent: vi.fn().mockImplementation(writeEventImpl),
  };

  const mockStateManager = {
    getBaseDir: vi.fn().mockReturnValue(tmpDir),
    loadGoal: vi.fn().mockResolvedValue(null),
  };

  return {
    coreLoop: mockCoreLoop as never,
    driveSystem: mockDriveSystem as never,
    stateManager: mockStateManager as never,
    pidManager: new PIDManager(tmpDir),
    logger: new Logger({
      dir: path.join(tmpDir, "logs"),
      consoleOutput: false,
      level: "error",
    }),
    config: {
      runtime_journal_v2: true,
      check_interval_ms: 10_000,
      event_server_port: 0,
    },
  };
}

function postEvent(port: number, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/events",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: responseBody });
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

async function getDaemonPort(daemon: DaemonRunner): Promise<number> {
  await waitFor(() => typeof (daemon as any).eventServer?.getPort?.() === "number");
  return (daemon as any).eventServer.getPort();
}

describe("DaemonRunner runtime journal replay", () => {
  let tmpDir: string | null = null;
  let daemon: DaemonRunner | null = null;
  let startPromise: Promise<void> | null = null;

  afterEach(async () => {
    if (daemon) {
      daemon.stop();
    }
    if (startPromise) {
      await startPromise.catch(() => {});
    }
    if (tmpDir) {
      cleanupTempDir(tmpDir);
    }
    daemon = null;
    startPromise = null;
    tmpDir = null;
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  it("replays queued ingress events after crash-style restart", async () => {
    tmpDir = makeTempDir();
    const firstWrite = vi.fn().mockRejectedValue(new Error("temporary failure"));

    daemon = new DaemonRunner(makeDeps(tmpDir, firstWrite));
    startPromise = daemon.start(["goal-1"]);
    const port1 = await getDaemonPort(daemon);

    const result = await postEvent(port1, {
      type: "external",
      source: "test",
      timestamp: new Date().toISOString(),
      data: { value: 1 },
    });
    expect(result.status).toBe(200);
    await waitFor(() => firstWrite.mock.calls.length === 1);

    (daemon as any).state.status = "crashed";
    (daemon as any).running = false;
    (daemon as any).sleepAbortController?.abort();
    await startPromise;
    daemon = null;
    startPromise = null;

    const replayWrite = vi.fn().mockResolvedValue(undefined);
    daemon = new DaemonRunner(makeDeps(tmpDir, replayWrite));
    startPromise = daemon.start(["goal-1"]);

    await waitFor(() => replayWrite.mock.calls.length === 1);
    expect(replayWrite.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: "external",
        source: "test",
      })
    );
  });
});
