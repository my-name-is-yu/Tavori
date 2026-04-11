import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonRunner } from "../daemon-runner.js";
import { PIDManager } from "../pid-manager.js";
import { Logger } from "../logger.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import { createRuntimeStorePaths } from "../store/runtime-paths.js";
import type { ApprovalRecord } from "../store/runtime-schemas.js";

function makeDeps(tmpDir: string) {
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
    writeEvent: vi.fn().mockResolvedValue(undefined),
  };

  const mockStateManager = {
    getBaseDir: vi.fn().mockReturnValue(tmpDir),
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
      check_interval_ms: 10_000,
      event_server_port: 0,
      runtime_journal_v2: true,
    },
  };
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

function request(
  port: number,
  method: string,
  urlPath: string,
  body: unknown,
  authToken: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
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
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

function waitForSseEvent(port: number, eventType: string, authToken: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/stream",
        headers: { Accept: "text/event-stream", Authorization: `Bearer ${authToken}` },
      },
      (res) => {
        let buffer = "";
        const timeout = setTimeout(() => {
          settled = true;
          req.destroy();
          reject(new Error(`Timed out waiting for SSE event: ${eventType}`));
        }, 2000);

        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          const messages = buffer.split("\n\n");
          buffer = messages.pop() ?? "";

          for (const message of messages) {
            let currentEvent = "message";
            let data = "";
            for (const line of message.split("\n")) {
              if (line.startsWith("event: ")) {
                currentEvent = line.slice(7);
              } else if (line.startsWith("data: ")) {
                data += line.slice(6);
              }
            }

            if (currentEvent === eventType) {
              clearTimeout(timeout);
              settled = true;
              req.destroy();
              try {
                resolve(JSON.parse(data));
              } catch {
                resolve(data);
              }
              return;
            }
          }
        });
      }
    );
    req.on("error", (err) => {
      if (!settled) {
        reject(err);
      }
    });
  });
}

describe("DaemonRunner durable approval restart", () => {
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

  it("keeps pending approvals across daemon restart when runtime_journal_v2 is enabled", async () => {
    tmpDir = makeTempDir();
    const paths = createRuntimeStorePaths(path.join(tmpDir, "runtime"));

    const deps1 = makeDeps(tmpDir);
    daemon = new DaemonRunner(deps1);
    startPromise = daemon.start(["goal-1"]);
    await waitFor(() => typeof daemon?.getApprovalFn() === "function");

    const approvalFn = daemon.getApprovalFn()!;
    void approvalFn({
      goal_id: "goal-1",
      id: "task-restart",
      description: "Approve restart-safe action",
      action: "deploy",
    });

    const pendingDir = paths.approvalsPendingDir;
    await waitFor(() =>
      fs.existsSync(pendingDir) &&
      fs.readdirSync(pendingDir).some((entry) => entry.endsWith(".json"))
    );
    const pendingFile = fs.readdirSync(pendingDir).find((entry) => entry.endsWith(".json"));
    const pendingPath = path.join(pendingDir, pendingFile!);

    daemon.stop();
    await startPromise;
    await waitFor(() => !fs.existsSync(path.join(tmpDir!, "pulseed.pid")));
    daemon = null;
    startPromise = null;

    const pending = JSON.parse(fs.readFileSync(pendingPath, "utf-8")) as ApprovalRecord;
    expect(pending.state).toBe("pending");
    const approvalId = pending.approval_id;

    const deps2 = makeDeps(tmpDir);
    daemon = new DaemonRunner(deps2);
    startPromise = daemon.start(["goal-1"]);
    await waitFor(() => typeof daemon?.getApprovalFn() === "function");

    const statePath = path.join(tmpDir, "daemon-state.json");
    await waitFor(() => fs.existsSync(statePath));

    const daemonState = JSON.parse(fs.readFileSync(statePath, "utf-8")) as { active_goals: string[] };
    expect(daemonState.active_goals).toContain("goal-1");

    const port = await new Promise<number>((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const poll = () => {
        const maybePort = (daemon as any)?.eventServer?.getPort?.();
        if (typeof maybePort === "number" && maybePort > 0) {
          resolve(maybePort);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error("Timed out waiting for event server port"));
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });

    const authToken = (daemon as any)?.eventServer?.getAuthToken?.() as string;
    const restored = await waitForSseEvent(port, "approval_required", authToken);
    expect(restored).toEqual(
      expect.objectContaining({
        requestId: approvalId,
        goalId: "goal-1",
        restored: true,
      })
    );

    const approveResult = await request(port, "POST", "/goals/goal-1/approve", {
      requestId: approvalId,
      approved: true,
    }, authToken);
    expect(approveResult.status).toBe(200);

    const resolvedPath = paths.approvalResolvedPath(approvalId);
    await waitFor(() => fs.existsSync(resolvedPath));
    const resolved = JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as ApprovalRecord;
    expect(resolved.state).toBe("approved");
  });
});
