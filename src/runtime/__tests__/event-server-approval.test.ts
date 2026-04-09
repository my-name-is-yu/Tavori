import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventServer } from "../event-server.js";
import { ApprovalBroker } from "../approval-broker.js";
import { ApprovalStore } from "../store/approval-store.js";
import {
  getRuntimePendingApprovalsDir,
  getRuntimeResolvedApprovalsDir,
} from "../store/runtime-paths.js";
import type { ApprovalRecord } from "../store/runtime-schemas.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

function createMockDriveSystem() {
  return {
    writeEvent: async () => undefined,
  };
}

function request(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown
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

function waitForSseEvent(port: number, eventType: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/stream",
        headers: { Accept: "text/event-stream" },
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

async function waitForFile(filePath: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

describe("EventServer durable approval integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("routes approval resolution through ApprovalBroker", async () => {
    const store = new ApprovalStore(tmpDir);
    const broker = new ApprovalBroker({
      store,
      createId: () => "approval-http",
    });
    const server = new EventServer(
      createMockDriveSystem() as never,
      {
        port: 0,
        eventsDir: path.join(tmpDir, "events"),
        approvalBroker: broker,
      }
    );

    try {
      await server.start();
      const approval = server.requestApproval("goal-1", {
        id: "task-http",
        description: "Approve HTTP request",
        action: "merge",
      });
      await waitForFile(
        path.join(getRuntimePendingApprovalsDir(tmpDir), "approval-http.json")
      );

      const result = await request(server.getPort(), "POST", "/goals/goal-1/approve", {
        requestId: "approval-http",
        approved: true,
      });

      expect(result.status).toBe(200);
      await expect(approval).resolves.toBe(true);

      const resolvedPath = path.join(
        getRuntimeResolvedApprovalsDir(tmpDir),
        "approval-http.json"
      );
      const resolved = JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as ApprovalRecord;
      expect(resolved.state).toBe("approved");
    } finally {
      await server.stop();
    }
  });

  it("re-emits restored approvals to reconnecting SSE clients", async () => {
    const store = new ApprovalStore(tmpDir);
    const expiresAt = Date.now() + 60_000;
    await store.savePending({
      approval_id: "approval-sse",
      goal_id: "goal-sse",
      request_envelope_id: "approval-sse",
      correlation_id: "approval-sse",
      state: "pending",
      created_at: Date.now(),
      expires_at: expiresAt,
      payload: {
        task: {
          id: "task-sse",
          description: "Replayed approval",
          action: "resume",
        },
      },
    });

    const broker = new ApprovalBroker({ store });
    const server = new EventServer(
      createMockDriveSystem() as never,
      {
        port: 0,
        eventsDir: path.join(tmpDir, "events"),
        approvalBroker: broker,
      }
    );

    try {
      await server.start();
      const event = await waitForSseEvent(server.getPort(), "approval_required");
      expect(event).toEqual({
        requestId: "approval-sse",
        goalId: "goal-sse",
        task: {
          id: "task-sse",
          description: "Replayed approval",
          action: "resume",
        },
        expiresAt,
        restored: true,
      });
    } finally {
      await server.stop();
    }
  });
});
