import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { EventServer } from "../../event-server.js";
import { Logger } from "../../logger.js";
import { beginGracefulShutdown, startDaemonRunner } from "../runner-startup.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

vi.setConfig({ testTimeout: 20_000 });

function makeRequest(
  port: number,
  urlPath: string,
  authToken: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "GET",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

describe("runner startup active workers snapshot", () => {
  let tmpDir: string;
  let startupPromise: Promise<void> | null = null;
  let releaseCoreLoop: (() => void) | null = null;
  let shutdownContext: Record<string, unknown> | null = null;

  beforeEach(() => {
    tmpDir = makeTempDir();
    startupPromise = null;
    releaseCoreLoop = null;
    shutdownContext = null;
  });

  afterEach(async () => {
    if (shutdownContext) {
      beginGracefulShutdown(shutdownContext as never);
    }
    releaseCoreLoop?.();
    await startupPromise?.catch(() => {});
    startupPromise = null;
    releaseCoreLoop = null;
    shutdownContext = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("flattens live supervisor worker state into the snapshot payload", async () => {
    const runtimeRoot = path.join(tmpDir, "runtime");
    const eventsDir = path.join(runtimeRoot, "events");
    const logger = new Logger({
      dir: path.join(tmpDir, "logs"),
      level: "error",
      consoleOutput: false,
    });
    const eventServer = new EventServer(
      {
        writeEvent: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        port: 0,
        eventsDir,
      },
      logger,
    );
    const supervisor = {
      start: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockReturnValue({
        workers: [
          {
            workerId: "worker-1",
            goalId: "goal-1",
            startedAt: 111,
            iterations: 7,
          },
          {
            workerId: "worker-idle",
            goalId: null,
            startedAt: 222,
            iterations: 3,
          },
        ],
        crashCounts: {},
        suspendedGoals: [],
        updatedAt: 333,
      }),
    };

    const context = {
      config: {
        event_server_port: 0,
        check_interval_ms: 50,
        max_concurrent_goals: 1,
        iterations_per_cycle: 1,
        crash_recovery: {
          graceful_shutdown_timeout_ms: 1_000,
        },
      },
      state: {
        pid: process.pid,
        started_at: new Date().toISOString(),
        last_loop_at: null,
        loop_count: 0,
        active_goals: [],
        status: "stopped",
        crash_count: 0,
        last_error: null,
        last_resident_at: null,
        resident_activity: null,
      },
      driveSystem: {
        startWatcher: vi.fn(),
        stopWatcher: vi.fn(),
        writeEvent: vi.fn(),
      },
      deps: {
        shutdownSignalTarget: undefined,
      },
      eventServer,
      eventDispatcher: {
        start: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      },
      commandDispatcher: {
        start: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      },
      supervisor,
      logger,
      running: true,
      shuttingDown: false,
      initializeRuntimeFoundation: vi.fn().mockResolvedValue(undefined),
      acquireRuntimeLeadership: vi.fn().mockResolvedValue(undefined),
      saveRuntimeHealthSnapshot: vi.fn().mockResolvedValue(undefined),
      startStartupRuntimeStoreMaintenance: vi.fn(),
      stopStatusHeartbeat: null,
      shutdownCoordinator: null,
      queueClaimSweeper: null,
      approvalBroker: null,
      gateway: null,
      approvalFn: undefined,
      restoreState: vi.fn().mockImplementation(async (goalIds: string[]) => goalIds),
      reconcileInterruptedExecutions: vi.fn().mockResolvedValue([]),
      saveDaemonState: vi.fn().mockResolvedValue(undefined),
      writeShutdownMarker: vi.fn().mockResolvedValue(undefined),
      runSupervisorMaintenanceCycle: vi.fn().mockResolvedValue(undefined),
      reconcileRuntimeControlOperationsAfterStartup: vi.fn().mockResolvedValue(undefined),
      startStartupRuntimeStoreMaintenancePromise: null,
      drainStartupRuntimeStoreMaintenance: vi.fn().mockResolvedValue(undefined),
      releaseStartupOwnership: vi.fn().mockResolvedValue(undefined),
      captureProviderRuntimeFingerprint: vi.fn().mockResolvedValue(null),
      handleInboundEnvelope: vi.fn().mockResolvedValue(undefined),
      onEventReceived: vi.fn(),
      cleanup: vi.fn().mockResolvedValue(undefined),
    };
    shutdownContext = context;

    startupPromise = startDaemonRunner(context as never, ["goal-1"]);

    await waitFor(() => supervisor.start.mock.calls.length > 0);

    const snapshotResponse = await makeRequest(eventServer.getPort(), "/snapshot", eventServer.getAuthToken());
    expect(snapshotResponse.status).toBe(200);

    const snapshot = JSON.parse(snapshotResponse.body) as { active_workers: unknown[] };
    expect(snapshot.active_workers).toEqual([
      {
        worker_id: "worker-1",
        goal_id: "goal-1",
        started_at: 111,
        iterations: 7,
      },
    ]);

    beginGracefulShutdown(context as never);
    await startupPromise;
  });
});
