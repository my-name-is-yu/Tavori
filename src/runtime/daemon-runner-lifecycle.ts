import type { EventServer } from "./event-server.js";
import type { Logger } from "./logger.js";

interface DaemonStatusSnapshot {
  status: string;
  activeGoals: string[];
  loopCount: number;
  startedAt: string;
}

interface DaemonStatusHeartbeatOptions {
  eventServer: EventServer | undefined;
  getSnapshot: () => DaemonStatusSnapshot;
}

interface ProcessShutdownCoordinatorOptions {
  logger: Logger;
  gracefulShutdownTimeoutMs: number;
  onShutdown: () => void;
  onForceStop: () => void;
}

export function startDaemonStatusHeartbeat(
  options: DaemonStatusHeartbeatOptions
): () => void {
  const timer = setInterval(() => {
    const { eventServer } = options;
    const snapshot = options.getSnapshot();
    if (!eventServer || snapshot.status !== "running") {
      return;
    }

    void eventServer.broadcast?.("daemon_status", {
      status: snapshot.status,
      activeGoals: snapshot.activeGoals,
      loopCount: snapshot.loopCount,
      uptime: Date.now() - new Date(snapshot.startedAt).getTime(),
    });
  }, 30_000);

  return () => {
    clearInterval(timer);
  };
}

export class ProcessShutdownCoordinator {
  private shutdownHandler: (() => void) | null = null;
  private forceStopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ProcessShutdownCoordinatorOptions) {}

  activate(): void {
    const shutdown = (): void => {
      if (this.shutdownHandler === null) {
        return;
      }
      if (this.forceStopTimer !== null) {
        return;
      }

      this.options.onShutdown();
      this.forceStopTimer = setTimeout(() => {
        this.options.logger.warn(
          `Graceful shutdown timeout (${this.options.gracefulShutdownTimeoutMs}ms) exceeded, forcing stop`
        );
        this.options.onForceStop();
      }, this.options.gracefulShutdownTimeoutMs);
    };

    this.shutdownHandler = shutdown;
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }

  dispose(): void {
    if (this.forceStopTimer !== null) {
      clearTimeout(this.forceStopTimer);
      this.forceStopTimer = null;
    }

    if (this.shutdownHandler) {
      process.removeListener("SIGTERM", this.shutdownHandler);
      process.removeListener("SIGINT", this.shutdownHandler);
      this.shutdownHandler = null;
    }
  }
}
