import type { PIDManager } from "./pid-manager.js";
import type { LeaderLockManager } from "./leader-lock-manager.js";
import type { Logger } from "./logger.js";
import type { RuntimeHealthStore } from "./store/index.js";

export interface WatchdogChildProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
}

export interface RuntimeWatchdogOptions {
  pidManager: PIDManager;
  healthStore: RuntimeHealthStore;
  leaderLockManager: LeaderLockManager;
  logger: Pick<Logger, "info" | "warn" | "error">;
  startChild: () => WatchdogChildProcess;
  healthProbe?: () => Promise<{ ok: boolean; detail?: string }>;
  healthProbeFailureThreshold?: number;
  pollIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  startupGraceMs?: number;
  restartBackoffMs?: number;
  maxRestartBackoffMs?: number;
  childShutdownGraceMs?: number;
  restartStormWindowMs?: number;
  maxUnhealthyRestartsInWindow?: number;
  onCircuitOpen?: (details: WatchdogCircuitOpenDetails) => Promise<void> | void;
}

export interface WatchdogCircuitOpenDetails extends Record<string, unknown> {
  reason: ChildExitResult["reason"];
  restartCount: number;
  windowMs: number;
  pid?: number;
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ChildExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  healthy: boolean;
  reason: "exit" | "heartbeat_timeout" | "health_probe_failed";
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
const DEFAULT_STARTUP_GRACE_MS = 20_000;
const DEFAULT_RESTART_BACKOFF_MS = 1_000;
const DEFAULT_MAX_RESTART_BACKOFF_MS = 30_000;
const DEFAULT_CHILD_SHUTDOWN_GRACE_MS = 5_000;
const DEFAULT_RESTART_STORM_WINDOW_MS = 5 * 60_000;
const DEFAULT_MAX_UNHEALTHY_RESTARTS_IN_WINDOW = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RuntimeWatchdog {
  private readonly pidManager: PIDManager;
  private readonly healthStore: RuntimeHealthStore;
  private readonly leaderLockManager: LeaderLockManager;
  private readonly logger: Pick<Logger, "info" | "warn" | "error">;
  private readonly startChild: () => WatchdogChildProcess;
  private readonly healthProbe?: () => Promise<{ ok: boolean; detail?: string }>;
  private readonly healthProbeFailureThreshold: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly startupGraceMs: number;
  private readonly restartBackoffMs: number;
  private readonly maxRestartBackoffMs: number;
  private readonly childShutdownGraceMs: number;
  private readonly restartStormWindowMs: number;
  private readonly maxUnhealthyRestartsInWindow: number;
  private readonly onCircuitOpen?: (details: WatchdogCircuitOpenDetails) => Promise<void> | void;
  private currentChild: WatchdogChildProcess | null = null;
  private running = false;
  private stopping = false;

  constructor(options: RuntimeWatchdogOptions) {
    this.pidManager = options.pidManager;
    this.healthStore = options.healthStore;
    this.leaderLockManager = options.leaderLockManager;
    this.logger = options.logger;
    this.startChild = options.startChild;
    this.healthProbe = options.healthProbe;
    this.healthProbeFailureThreshold = Math.max(1, options.healthProbeFailureThreshold ?? 3);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.startupGraceMs = options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
    this.restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    this.maxRestartBackoffMs = options.maxRestartBackoffMs ?? DEFAULT_MAX_RESTART_BACKOFF_MS;
    this.childShutdownGraceMs =
      options.childShutdownGraceMs ?? DEFAULT_CHILD_SHUTDOWN_GRACE_MS;
    this.restartStormWindowMs = Math.max(1, options.restartStormWindowMs ?? DEFAULT_RESTART_STORM_WINDOW_MS);
    this.maxUnhealthyRestartsInWindow = Math.max(
      1,
      options.maxUnhealthyRestartsInWindow ?? DEFAULT_MAX_UNHEALTHY_RESTARTS_IN_WINDOW
    );
    this.onCircuitOpen = options.onCircuitOpen;
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error("RuntimeWatchdog is already running");
    }
    if (await this.pidManager.isRunning()) {
      const info = await this.pidManager.readPID();
      throw new Error(
        `Daemon is already running (PID ${info?.pid ?? "unknown"}). Stop it first or remove the PID file at: ${this.pidManager.getPath()}`
      );
    }

    this.running = true;
    this.stopping = false;
    let restartDelayMs = this.restartBackoffMs;
    let unhealthyRestartTimestamps: number[] = [];

    await this.pidManager.writePID({
      pid: process.pid,
      owner_pid: process.pid,
      watchdog_pid: process.pid,
      runtime_pid: process.pid,
    });

    try {
      while (!this.stopping) {
        const child = this.startChild();
        this.currentChild = child;
        await this.pidManager.writePID({
          pid: child.pid ?? process.pid,
          owner_pid: process.pid,
          watchdog_pid: process.pid,
          runtime_pid: child.pid ?? process.pid,
        });
        this.logger.info("Watchdog spawned daemon child", { pid: child.pid });

        const result = await this.monitorChild(child);
        this.currentChild = null;

        if (this.stopping) {
          break;
        }

        if (result.healthy) {
          unhealthyRestartTimestamps = [];
          restartDelayMs = this.restartBackoffMs;
        } else {
          const now = Date.now();
          unhealthyRestartTimestamps = [
            ...unhealthyRestartTimestamps.filter((timestamp) => now - timestamp <= this.restartStormWindowMs),
            now,
          ];
          if (unhealthyRestartTimestamps.length >= this.maxUnhealthyRestartsInWindow) {
            await this.tripCircuitBreaker(result, child, unhealthyRestartTimestamps.length);
            break;
          }
          restartDelayMs = Math.min(restartDelayMs * 2, this.maxRestartBackoffMs);
        }

        this.logger.warn("Watchdog restarting daemon child", {
          pid: child.pid,
          reason: result.reason,
          code: result.code,
          signal: result.signal,
          restart_delay_ms: restartDelayMs,
        });
        await sleep(restartDelayMs);
      }
    } finally {
      this.currentChild = null;
      this.running = false;
      await this.pidManager.cleanup();
    }
  }

  private async tripCircuitBreaker(
    result: ChildExitResult,
    child: WatchdogChildProcess,
    restartCount: number
  ): Promise<void> {
    this.stopping = true;
    const details: WatchdogCircuitOpenDetails = {
      reason: result.reason,
      restartCount,
      windowMs: this.restartStormWindowMs,
      pid: child.pid,
      code: result.code,
      signal: result.signal,
    };
    this.logger.error("Watchdog circuit breaker opened after restart storm", details);
    await this.healthStore.saveDaemonHealth({
      status: "failed",
      leader: false,
      checked_at: Date.now(),
      details: {
        circuit_reason: "watchdog_circuit_open",
        ...details,
      },
    });
    await this.onCircuitOpen?.(details);
  }

  stop(): void {
    this.stopping = true;
    const child = this.currentChild;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore stop races.
    }
  }

  private async monitorChild(child: WatchdogChildProcess): Promise<ChildExitResult> {
    const startedAt = Date.now();
    let healthy = false;
    let unhealthyKillTriggered = false;
    let unhealthyReason: ChildExitResult["reason"] = "exit";
    let pollInFlight = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveHealthProbeFailures = 0;

    return new Promise<ChildExitResult>((resolve) => {
      const cleanup = (): void => {
        clearInterval(pollTimer);
        if (forceKillTimer !== null) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
        child.removeListener("exit", onExit);
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        resolve({
          code,
          signal,
          healthy,
          reason: unhealthyKillTriggered ? unhealthyReason : "exit",
        });
      };

      const triggerRestart = (
        reason: Exclude<ChildExitResult["reason"], "exit">,
        detail?: string
      ): void => {
        if (unhealthyKillTriggered || this.stopping) return;
        unhealthyKillTriggered = true;
        unhealthyReason = reason;
        if (reason === "health_probe_failed") {
          this.logger.warn("Watchdog detected unresponsive daemon command surface", {
            pid: child.pid,
            consecutive_failures: consecutiveHealthProbeFailures,
            detail,
          });
        } else {
          this.logger.warn("Watchdog detected stale daemon heartbeat", {
            pid: child.pid,
            heartbeat_timeout_ms: this.heartbeatTimeoutMs,
            detail,
          });
        }
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore if the child already exited.
        }
        forceKillTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Child already exited.
          }
        }, this.childShutdownGraceMs);
      };

      const pollTimer = setInterval(() => {
        if (pollInFlight || this.stopping || unhealthyKillTriggered) return;
        pollInFlight = true;
        void (async () => {
          try {
            const now = Date.now();
            const [daemonHealth, leaderLock] = await Promise.all([
              this.healthStore.loadDaemonHealth(),
              this.leaderLockManager.read(),
            ]);

            const expectedPid = child.pid;
            const healthPid =
              daemonHealth?.details &&
              typeof daemonHealth.details["pid"] === "number"
                ? (daemonHealth.details["pid"] as number)
                : undefined;
            const processKpi = daemonHealth?.kpi?.process_alive;
            const heartbeatCheckedAt = processKpi?.checked_at ?? daemonHealth?.checked_at ?? 0;
            const processAliveHealthy =
              daemonHealth !== null &&
              (processKpi?.status === "ok" || processKpi === undefined);

            const heartbeatFresh =
              daemonHealth !== null &&
              daemonHealth.leader === true &&
              healthPid === expectedPid &&
              processAliveHealthy &&
              now - heartbeatCheckedAt <= this.heartbeatTimeoutMs;

            const leaderFresh =
              leaderLock !== null &&
              leaderLock.pid === expectedPid &&
              leaderLock.lease_until > now;

            const leadershipHealthy = heartbeatFresh && leaderFresh;
            if (leadershipHealthy && this.healthProbe) {
              const probe = await this.healthProbe();
              if (probe.ok) {
                consecutiveHealthProbeFailures = 0;
                healthy = true;
                return;
              }

              consecutiveHealthProbeFailures += 1;
              if (now - startedAt < this.startupGraceMs) {
                return;
              }
              if (consecutiveHealthProbeFailures < this.healthProbeFailureThreshold) {
                return;
              }
              triggerRestart("health_probe_failed", probe.detail);
              return;
            }

            if (leadershipHealthy) {
              consecutiveHealthProbeFailures = 0;
              healthy = true;
              return;
            }

            if (now - startedAt < this.startupGraceMs) {
              return;
            }

            triggerRestart("heartbeat_timeout");
          } catch (error) {
            this.logger.warn("Watchdog failed to poll daemon heartbeat", {
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            pollInFlight = false;
          }
        })();
      }, this.pollIntervalMs);

      child.once("exit", onExit);
    });
  }
}
