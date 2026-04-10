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
  pollIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  startupGraceMs?: number;
  restartBackoffMs?: number;
  maxRestartBackoffMs?: number;
  childShutdownGraceMs?: number;
}

interface ChildExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  healthy: boolean;
  reason: "exit" | "heartbeat_timeout";
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
const DEFAULT_STARTUP_GRACE_MS = 20_000;
const DEFAULT_RESTART_BACKOFF_MS = 1_000;
const DEFAULT_MAX_RESTART_BACKOFF_MS = 30_000;
const DEFAULT_CHILD_SHUTDOWN_GRACE_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RuntimeWatchdog {
  private readonly pidManager: PIDManager;
  private readonly healthStore: RuntimeHealthStore;
  private readonly leaderLockManager: LeaderLockManager;
  private readonly logger: Pick<Logger, "info" | "warn" | "error">;
  private readonly startChild: () => WatchdogChildProcess;
  private readonly pollIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly startupGraceMs: number;
  private readonly restartBackoffMs: number;
  private readonly maxRestartBackoffMs: number;
  private readonly childShutdownGraceMs: number;
  private currentChild: WatchdogChildProcess | null = null;
  private running = false;
  private stopping = false;

  constructor(options: RuntimeWatchdogOptions) {
    this.pidManager = options.pidManager;
    this.healthStore = options.healthStore;
    this.leaderLockManager = options.leaderLockManager;
    this.logger = options.logger;
    this.startChild = options.startChild;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.startupGraceMs = options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
    this.restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    this.maxRestartBackoffMs = options.maxRestartBackoffMs ?? DEFAULT_MAX_RESTART_BACKOFF_MS;
    this.childShutdownGraceMs =
      options.childShutdownGraceMs ?? DEFAULT_CHILD_SHUTDOWN_GRACE_MS;
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

        restartDelayMs = result.healthy
          ? this.restartBackoffMs
          : Math.min(restartDelayMs * 2, this.maxRestartBackoffMs);

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
    let pollInFlight = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

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
          reason: unhealthyKillTriggered ? "heartbeat_timeout" : "exit",
        });
      };

      const triggerRestart = (): void => {
        if (unhealthyKillTriggered || this.stopping) return;
        unhealthyKillTriggered = true;
        this.logger.warn("Watchdog detected stale daemon heartbeat", {
          pid: child.pid,
          heartbeat_timeout_ms: this.heartbeatTimeoutMs,
        });
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

            if (heartbeatFresh && leaderFresh) {
              healthy = true;
              return;
            }

            if (now - startedAt < this.startupGraceMs) {
              return;
            }

            triggerRestart();
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
