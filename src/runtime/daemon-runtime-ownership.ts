import * as path from "node:path";
import type { Logger } from "./logger.js";
import type { ApprovalStore, OutboxStore, RuntimeHealthStore } from "./store/index.js";
import type { LeaderLockManager } from "./leader-lock-manager.js";

export type RuntimeHealthComponents = Record<
  "gateway" | "queue" | "leases" | "approval" | "outbox" | "supervisor",
  "ok" | "degraded"
>;

interface RuntimeOwnershipDeps {
  runtimeRoot: string | null;
  logger: Logger;
  approvalStore: ApprovalStore | null;
  outboxStore: OutboxStore | null;
  runtimeHealthStore: RuntimeHealthStore | null;
  leaderLockManager: LeaderLockManager | null;
  onLeadershipLost: (reason: string) => void;
}

export class RuntimeOwnershipCoordinator {
  private leaderOwnerToken: string | null = null;
  private leaderHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private runtimeHealthPhase = "disabled";
  private runtimeHealthComponents: RuntimeHealthComponents | null = null;

  constructor(private readonly deps: RuntimeOwnershipDeps) {}

  async initializeFoundation(): Promise<void> {
    await Promise.all([
      this.deps.approvalStore?.ensureReady(),
      this.deps.outboxStore?.ensureReady(),
      this.deps.runtimeHealthStore?.ensureReady(),
    ]);

    await this.saveRuntimeHealthSnapshot("foundation_only", {
      gateway: "degraded",
      queue: "degraded",
      leases: "ok",
      approval: "ok",
      outbox: "ok",
      supervisor: "degraded",
    });

    this.deps.logger.info("Runtime journal foundation initialized", {
      runtime_root: this.deps.runtimeRoot,
      queue_path: this.deps.runtimeRoot ? path.join(this.deps.runtimeRoot, "queue.json") : undefined,
    });
  }

  async saveRuntimeHealthSnapshot(
    phase: string,
    components: RuntimeHealthComponents
  ): Promise<void> {
    this.runtimeHealthPhase = phase;
    this.runtimeHealthComponents = components;
    const status = Object.values(components).every((value) => value === "ok") ? "ok" : "degraded";
    await this.deps.runtimeHealthStore?.saveSnapshot({
      status,
      leader: this.leaderOwnerToken !== null,
      checked_at: Date.now(),
      components,
      details: {
        pid: process.pid,
        runtime_journal_v2: true,
        runtime_root: this.deps.runtimeRoot,
        phase,
      },
    });
  }

  async acquireLeadership(leaseMs: number, heartbeatMs: number): Promise<void> {
    if (!this.deps.leaderLockManager) {
      return;
    }

    const acquired = await this.deps.leaderLockManager.acquire({ leaseMs });
    if (!acquired) {
      const current = await this.deps.leaderLockManager.read();
      throw new Error(
        `Runtime daemon leader already active (PID ${current?.pid ?? "unknown"})`
      );
    }

    this.leaderOwnerToken = acquired.owner_token;
    await this.writeRuntimeHeartbeat();
    this.leaderHeartbeatTimer = setInterval(() => {
      void this.renewLeadership(leaseMs).catch((err) => {
        this.deps.logger.error("Failed to renew runtime leader lock", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.deps.onLeadershipLost(
          err instanceof Error ? err.message : String(err)
        );
      });
    }, heartbeatMs);
    this.leaderHeartbeatTimer.unref?.();
  }

  async releaseLeadership(): Promise<void> {
    if (this.leaderHeartbeatTimer !== null) {
      clearInterval(this.leaderHeartbeatTimer);
      this.leaderHeartbeatTimer = null;
    }

    const ownerToken = this.leaderOwnerToken;
    this.leaderOwnerToken = null;
    if (ownerToken) {
      await this.deps.leaderLockManager?.release(ownerToken);
    }
  }

  async saveFinalHealth(status: "failed" | "degraded"): Promise<void> {
    await this.deps.runtimeHealthStore?.saveDaemonHealth({
      status,
      leader: false,
      checked_at: Date.now(),
      details: {
        pid: process.pid,
        runtime_journal_v2: true,
        runtime_root: this.deps.runtimeRoot,
        phase: this.runtimeHealthPhase,
      },
    });
  }

  private async renewLeadership(leaseMs: number): Promise<void> {
    if (!this.deps.leaderLockManager || !this.leaderOwnerToken) {
      return;
    }

    const renewed = await this.deps.leaderLockManager.renew(this.leaderOwnerToken, {
      leaseMs,
    });
    if (!renewed) {
      this.deps.onLeadershipLost("Runtime leader lock was lost");
      return;
    }

    await this.writeRuntimeHeartbeat();
  }

  private async writeRuntimeHeartbeat(): Promise<void> {
    if (!this.deps.runtimeHealthStore) {
      return;
    }

    const components =
      this.runtimeHealthComponents ??
      {
        gateway: "degraded" as const,
        queue: "degraded" as const,
        leases: "degraded" as const,
        approval: "degraded" as const,
        outbox: "degraded" as const,
        supervisor: "degraded" as const,
      };
    const status = Object.values(components).every((value) => value === "ok") ? "ok" : "degraded";
    await this.deps.runtimeHealthStore.saveDaemonHealth({
      status,
      leader: this.leaderOwnerToken !== null,
      checked_at: Date.now(),
      details: {
        pid: process.pid,
        runtime_journal_v2: true,
        runtime_root: this.deps.runtimeRoot,
        phase: this.runtimeHealthPhase,
      },
    });
  }
}
