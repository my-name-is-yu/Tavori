import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeOwnershipCoordinator } from "../daemon/runtime-ownership.js";
import { RuntimeHealthStore } from "../store/health-store.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

describe("RuntimeOwnershipCoordinator", () => {
  let tmpDir: string;
  let store: RuntimeHealthStore;

  beforeEach(async () => {
    tmpDir = makeTempDir("runtime-ownership-");
    store = new RuntimeHealthStore(tmpDir);
    await store.ensureReady();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("preserves an observed command failure across heartbeats until a fresh recovery signal arrives", async () => {
    const coordinator = new RuntimeOwnershipCoordinator({
      runtimeRoot: tmpDir,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
      approvalStore: null,
      outboxStore: null,
      runtimeHealthStore: store,
      leaderLockManager: null,
      onLeadershipLost: vi.fn(),
    });

    await coordinator.saveRuntimeHealthSnapshot("execution_ownership_durable", {
      gateway: "ok",
      queue: "ok",
      leases: "ok",
      approval: "ok",
      outbox: "ok",
      supervisor: "ok",
    });
    await coordinator.observeCommandAcceptance("failed", "dispatcher failed");
    await (coordinator as unknown as { writeRuntimeHeartbeat: () => Promise<void> }).writeRuntimeHeartbeat();

    const health = await store.loadDaemonHealth();
    expect(health?.kpi?.command_acceptance.status).toBe("failed");
    expect(health?.kpi?.command_acceptance.reason).toBe("dispatcher failed");
  });
});
