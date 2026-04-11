import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, isDaemonRunning, probeDaemonHealth } from "../daemon-client.js";
import { EventServer } from "../event-server.js";
import { DEFAULT_PORT } from "../port-utils.js";
import { OutboxStore } from "../store/outbox-store.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

function createMockDriveSystem() {
  return {
    writeEvent: async () => undefined,
  };
}

function waitForEvent(
  client: DaemonClient,
  eventName: string,
  timeoutMs = 2000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for client event: ${eventName}`));
    }, timeoutMs);

    const onEvent = (data: unknown) => {
      clearTimeout(timeout);
      client.off(eventName, onEvent);
      resolve(data);
    };

    client.on(eventName, onEvent);
  });
}

describe("DaemonClient snapshot + replay", () => {
  let tmpDir: string;
  let server: EventServer;

  beforeEach(() => {
    tmpDir = makeTempDir();
    server = new EventServer(createMockDriveSystem() as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
      outboxStore: new OutboxStore(tmpDir),
    });
  });

  afterEach(async () => {
    if (server.isRunning()) {
      await server.stop();
    }
    cleanupTempDir(tmpDir);
  });

  it("replays events that were missed while disconnected", async () => {
    await server.start();

    const daemonStatePath = path.join(tmpDir, "daemon-state.json");
    fs.writeFileSync(daemonStatePath, JSON.stringify({ status: "running", pid: process.pid }), "utf-8");

    await server.broadcast("daemon_status", { status: "running", loopCount: 1 });

    const client = new DaemonClient({
      host: "127.0.0.1",
      port: server.getPort(),
      reconnectInterval: 50,
      maxReconnectAttempts: 2,
      authToken: server.getAuthToken(),
    });

    try {
      client.connect();
      await waitForEvent(client, "_connected");

      client.disconnect();

      const replayed = waitForEvent(client, "chat_message_received");
      await server.broadcast("chat_message_received", { goalId: "goal-1", message: "missed while offline" });

      client.connect();

      await expect(replayed).resolves.toEqual({
        goalId: "goal-1",
        message: "missed while offline",
      });
    } finally {
      client.disconnect();
    }
  });

  it("replays goal_updated and chat_response events through the SSE client", async () => {
    await server.start();

    const client = new DaemonClient({
      host: "127.0.0.1",
      port: server.getPort(),
      reconnectInterval: 50,
      maxReconnectAttempts: 2,
      authToken: server.getAuthToken(),
    });

    try {
      client.connect();
      await waitForEvent(client, "_connected");

      const goalUpdated = waitForEvent(client, "goal_updated");
      const chatResponse = waitForEvent(client, "chat_response");

      await server.broadcast("goal_updated", { goalId: "goal-1", status: "completed" });
      await server.broadcast("chat_response", { goalId: "goal-1", message: "queued", status: "queued" });

      await expect(goalUpdated).resolves.toEqual({ goalId: "goal-1", status: "completed" });
      await expect(chatResponse).resolves.toEqual({
        goalId: "goal-1",
        message: "queued",
        status: "queued",
      });
    } finally {
      client.disconnect();
    }
  });
});

describe("isDaemonRunning", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
    vi.restoreAllMocks();
  });

  it("treats idle daemon-state as running when the daemon health check passes", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon-state.json"),
      JSON.stringify({ status: "idle", pid: process.pid }),
      "utf-8"
    );
    vi.spyOn(DaemonClient.prototype, "getHealth").mockResolvedValue({ status: "ok" });

    await expect(isDaemonRunning(tmpDir)).resolves.toEqual({
      running: true,
      port: DEFAULT_PORT,
    });
  });
});

describe("probeDaemonHealth", () => {
  it("returns health payload and latency when /health responds", async () => {
    vi.spyOn(DaemonClient.prototype, "getHealth").mockResolvedValue({
      status: "ok",
      uptime: 4.2,
    });

    await expect(probeDaemonHealth({ host: "127.0.0.1", port: 41700 })).resolves.toMatchObject({
      ok: true,
      port: 41700,
      health: { status: "ok", uptime: 4.2 },
    });
  });

  it("returns the error message when /health probe fails", async () => {
    vi.spyOn(DaemonClient.prototype, "getHealth").mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(probeDaemonHealth({ host: "127.0.0.1", port: 41700 })).resolves.toMatchObject({
      ok: false,
      port: 41700,
      error: "connect ECONNREFUSED",
    });
  });
});
