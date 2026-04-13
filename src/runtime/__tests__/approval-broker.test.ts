import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalBroker } from "../approval-broker.js";
import { ApprovalStore } from "../store/approval-store.js";
import { createRuntimeStorePaths } from "../store/runtime-paths.js";
import type { ApprovalRecord } from "../store/runtime-schemas.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

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

async function waitForBroadcast(
  broadcast: ReturnType<typeof vi.fn>,
  eventType: string,
  requestId: string,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (broadcast.mock.calls.some(([type, payload]) =>
      type === eventType &&
      typeof payload === "object" &&
      payload !== null &&
      "requestId" in payload &&
      payload.requestId === requestId
    )) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for broadcast: ${eventType}:${requestId}`);
}

describe("ApprovalBroker", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      cleanupTempDir(tmpDir);
      tmpDir = null;
    }
  });

  it("persists pending approvals and resolves live requests", async () => {
    tmpDir = makeTempDir();
    const store = new ApprovalStore(tmpDir);
    const paths = createRuntimeStorePaths(tmpDir);
    const broadcast = vi.fn();
    const broker = new ApprovalBroker({
      store,
      broadcast,
      createId: () => "approval-live",
    });

    const request = broker.requestApproval("goal-1", {
      id: "task-1",
      description: "Review deployment plan",
      action: "deploy",
    });

    await waitForFile(
      paths.approvalPendingPath("approval-live")
    );
    const pending = await store.loadPending("approval-live");
    expect(pending?.state).toBe("pending");
    await waitForBroadcast(broadcast, "approval_required", "approval-live");

    await expect(broker.resolveApproval("approval-live", true, "tui")).resolves.toBe(true);
    await expect(request).resolves.toBe(true);

    expect(await store.loadPending("approval-live")).toBeNull();

    const resolvedPath = paths.approvalResolvedPath("approval-live");
    const resolved = JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as ApprovalRecord;
    expect(resolved.state).toBe("approved");
    expect(resolved.response_channel).toBe("tui");
    expect(broadcast).toHaveBeenCalledWith(
      "approval_required",
      expect.objectContaining({ requestId: "approval-live", restored: false })
    );
    expect(broadcast).toHaveBeenCalledWith(
      "approval_resolved",
      expect.objectContaining({ requestId: "approval-live", approved: true })
    );
  });

  it("resolves requests when approval arrives while pending save is in flight", async () => {
    tmpDir = makeTempDir();

    let markSaveStarted: () => void = () => undefined;
    let releaseSave: () => void = () => undefined;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    class SlowApprovalStore extends ApprovalStore {
      override async savePending(record: ApprovalRecord): Promise<ApprovalRecord> {
        markSaveStarted();
        await saveGate;
        return super.savePending(record);
      }
    }

    const store = new SlowApprovalStore(tmpDir);
    const broadcast = vi.fn();
    const broker = new ApprovalBroker({
      store,
      broadcast,
      createId: () => "approval-race",
    });

    const request = broker.requestApproval("goal-1", {
      id: "task-race",
      description: "Approve while saving",
      action: "race",
    });

    await saveStarted;
    const resolved = broker.resolveApproval("approval-race", true, "http");
    await Promise.resolve();
    expect(broker.getPendingApprovalEvents()).toEqual([]);
    releaseSave();

    await expect(resolved).resolves.toBe(true);
    await expect(request).resolves.toBe(true);
    expect(broadcast).not.toHaveBeenCalledWith(
      "approval_required",
      expect.objectContaining({ requestId: "approval-race" })
    );
    expect(broadcast).toHaveBeenCalledWith(
      "approval_resolved",
      expect.objectContaining({ requestId: "approval-race", approved: true })
    );
  });

  it("restores pending approvals from durable storage", async () => {
    tmpDir = makeTempDir();
    const store = new ApprovalStore(tmpDir);
    const paths = createRuntimeStorePaths(tmpDir);
    const expiresAt = Date.now() + 60_000;
    await store.savePending({
      approval_id: "approval-restored",
      goal_id: "goal-2",
      request_envelope_id: "approval-restored",
      correlation_id: "approval-restored",
      state: "pending",
      created_at: Date.now(),
      expires_at: expiresAt,
      payload: {
        task: {
          id: "task-2",
          description: "Approve restored change",
          action: "apply",
        },
      },
    });

    const broker = new ApprovalBroker({ store });
    await broker.start();

    expect(broker.getPendingApprovalEvents()).toEqual([
      {
        requestId: "approval-restored",
        goalId: "goal-2",
        task: {
          id: "task-2",
          description: "Approve restored change",
          action: "apply",
        },
        expiresAt,
        restored: true,
      },
    ]);

    await expect(broker.resolveApproval("approval-restored", false, "http")).resolves.toBe(true);

    const resolvedPath = paths.approvalResolvedPath("approval-restored");
    const resolved = JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as ApprovalRecord;
    expect(resolved.state).toBe("denied");
    expect(resolved.response_channel).toBe("http");
  });
});
