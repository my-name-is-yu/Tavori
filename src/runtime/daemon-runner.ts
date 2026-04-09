import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { CoreLoop } from "../orchestrator/loop/core-loop.js";
import { writeJsonFileAtomic, readJsonFileOrNull } from "../base/utils/json-io.js";
import type { LoopResult } from "../orchestrator/loop/core-loop.js";
import { DriveSystem } from "../platform/drive/drive-system.js";
import { StateManager } from "../base/state/state-manager.js";
import { PIDManager } from "./pid-manager.js";
import { Logger } from "./logger.js";
import { EventServer } from "./event-server.js";
import type { PulSeedEvent } from "../base/types/drive.js";
import type { DaemonConfig, DaemonState } from "../base/types/daemon.js";
import { DaemonConfigSchema, DaemonStateSchema } from "../base/types/daemon.js";
import type { ILLMClient } from "../base/llm/llm-client.js";
import { CronScheduler } from "./cron-scheduler.js";
import { ScheduleEngine } from "./schedule-engine.js";
import { getInternalIdentityPrefix } from "../base/config/identity-loader.js";
import { z } from "zod";
import { generateCronEntry } from "./daemon-signals.js";
import { rotateDaemonLog, calculateAdaptiveInterval as calcAdaptiveInterval } from "./daemon-health.js";
import { IngressGateway, HttpChannelAdapter } from "./gateway/index.js";
import type { Envelope } from "./types/envelope.js";
import { createEnvelope } from "./types/envelope.js";
import { LoopSupervisor } from "./executor/index.js";
import { PulSeedEventSchema } from "../base/types/drive.js";
import { ApprovalStore, OutboxStore, RuntimeHealthStore, createRuntimeStorePaths } from "./store/index.js";
import { LeaderLockManager } from "./leader-lock-manager.js";
import { GoalLeaseManager } from "./goal-lease-manager.js";
import { JournalBackedQueue, type JournalBackedQueueAcceptResult } from "./queue/journal-backed-queue.js";
import { QueueClaimSweeper } from "./queue/queue-claim-sweeper.js";
import { ApprovalBroker } from "./approval-broker.js";
import { CommandDispatcher } from "./command-dispatcher.js";
import { EventDispatcher } from "./event-dispatcher.js";
import {
  RuntimeOwnershipCoordinator,
  type RuntimeHealthComponents,
} from "./daemon-runtime-ownership.js";
import {
  ProcessShutdownCoordinator,
  startDaemonStatusHeartbeat,
} from "./daemon-runner-lifecycle.js";

// Re-exports for callers that imported these from daemon-runner
export { generateCronEntry } from "./daemon-signals.js";
export { rotateDaemonLog, calculateAdaptiveInterval } from "./daemon-health.js";

// ─── ShutdownMarker ───
//
// Written to {baseDir}/shutdown-state.json to track daemon lifecycle.
// state: "running"        — daemon is active; if found on startup, previous instance crashed
// state: "clean_shutdown" — daemon exited gracefully via SIGTERM/SIGINT or stop()

export interface ShutdownMarker {
  goal_ids: string[];
  loop_index: number;
  timestamp: string;   // ISO 8601
  reason: "signal" | "stop" | "max_retries" | "startup";
  state: "running" | "clean_shutdown";
}

const RUNTIME_LEADER_LEASE_MS = 30_000;
const RUNTIME_LEADER_HEARTBEAT_MS = 10_000;

// ─── DaemonRunner ───
//
// Runs the durable PulSeed runtime as a long-lived daemon process.
// Responsibilities:
//   - leader lock management (prevent duplicate daemons)
//   - Signal handling (SIGINT/SIGTERM → graceful stop)
//   - queue / dispatcher / supervisor wiring
//   - Multi-goal scheduling and runtime state persistence
//   - Daemon state persistence (~/.pulseed/daemon-state.json)
//
// The daemon loop:
//   1. Determine which goals need activation (shouldActivate)
//   2. Run CoreLoop.run(goalId) for each active goal
//   3. Save state and sleep until next check interval

export interface DaemonDeps {
  coreLoop: CoreLoop;
  driveSystem: DriveSystem;
  stateManager: StateManager;
  pidManager: PIDManager;
  logger: Logger;
  reportingEngine?: {
    generateNotification(
      type: "approval_required",
      context: { goalId: string; message: string; details?: string }
    ): Promise<unknown>;
  };
  config?: Partial<DaemonConfig>;
  eventServer?: EventServer;
  llmClient?: ILLMClient;
  cronScheduler?: CronScheduler;
  scheduleEngine?: ScheduleEngine;
  gateway?: IngressGateway;
  supervisor?: LoopSupervisor;
  /** Factory to create fresh CoreLoop instances for LoopSupervisor workers. */
  coreLoopFactory?: () => CoreLoop;
}

export class DaemonRunner {
  private coreLoop: CoreLoop;
  private driveSystem: DriveSystem;
  private stateManager: StateManager;
  private pidManager: PIDManager;
  private logger: Logger;
  private config: DaemonConfig;
  private running = false;
  private shuttingDown = false;
  private state: DaemonState;
  private baseDir: string;
  private logDir: string;
  private logPath: string;
  private eventServer: EventServer | undefined;
  private approvalFn: ((task: Record<string, unknown>) => Promise<boolean>) | undefined;
  private sleepAbortController: AbortController | null = null;
  private currentGoalIds: string[] = [];
  private currentLoopIndex = 0;
  private lastProactiveTickAt: number = 0;
  private llmClient: ILLMClient | undefined;
  private reportingEngine:
    | {
        generateNotification(
          type: "approval_required",
          context: { goalId: string; message: string; details?: string }
        ): Promise<unknown>;
      }
    | undefined;
  private cronScheduler: CronScheduler | undefined;
  private scheduleEngine: ScheduleEngine | undefined;
  private consecutiveIdleCycles: number = 0;
  private gateway: IngressGateway | undefined;
  private supervisor: LoopSupervisor | null = null;
  private cronScheduleInterval: ReturnType<typeof setInterval> | null = null;
  private shutdownResolve: (() => void) | null = null;
  private shutdownCoordinator: ProcessShutdownCoordinator | null = null;
  private stopStatusHeartbeat: (() => void) | null = null;
  private readonly deps: DaemonDeps;
  private runtimeRoot: string | null = null;
  private approvalStore: ApprovalStore | null = null;
  private outboxStore: OutboxStore | null = null;
  private runtimeHealthStore: RuntimeHealthStore | null = null;
  private leaderLockManager: LeaderLockManager | null = null;
  private goalLeaseManager: GoalLeaseManager | null = null;
  private journalQueue: JournalBackedQueue | null = null;
  private queueClaimSweeper: QueueClaimSweeper | null = null;
  private approvalBroker: ApprovalBroker | null = null;
  private commandDispatcher: CommandDispatcher | null = null;
  private eventDispatcher: EventDispatcher | null = null;
  private runtimeOwnership: RuntimeOwnershipCoordinator;

  constructor(deps: DaemonDeps) {
    this.deps = deps;
    this.coreLoop = deps.coreLoop;
    this.driveSystem = deps.driveSystem;
    this.stateManager = deps.stateManager;
    this.pidManager = deps.pidManager;
    this.logger = deps.logger;
    this.eventServer = deps.eventServer;
    this.llmClient = deps.llmClient;
    this.reportingEngine = deps.reportingEngine;
    this.cronScheduler = deps.cronScheduler;
    this.scheduleEngine = deps.scheduleEngine;
    this.gateway = deps.gateway;
    this.supervisor = deps.supervisor ?? null;
    this.lastProactiveTickAt = Date.now();

    // Parse config with defaults via DaemonConfigSchema.parse()
    this.config = DaemonConfigSchema.parse(deps.config ?? {});

    // Resolve base directory from stateManager
    this.baseDir = this.stateManager.getBaseDir();

    // Pre-compute log paths used by rotateLog
    this.logDir = path.join(this.baseDir, this.config.log_dir);
    this.logPath = path.join(this.logDir, "pulseed.log");

    this.runtimeRoot = this.resolveRuntimeRoot();
    const runtimePaths = createRuntimeStorePaths(this.runtimeRoot);
    this.approvalStore = new ApprovalStore(runtimePaths);
    this.outboxStore = new OutboxStore(runtimePaths);
    this.runtimeHealthStore = new RuntimeHealthStore(runtimePaths);
    this.leaderLockManager = new LeaderLockManager(this.runtimeRoot);
    this.goalLeaseManager = new GoalLeaseManager(this.runtimeRoot);
    this.approvalBroker = new ApprovalBroker({
      store: this.approvalStore,
      logger: this.logger,
    });
    this.journalQueue = new JournalBackedQueue({
      journalPath: path.join(this.runtimeRoot, "queue.json"),
    });
    this.queueClaimSweeper = new QueueClaimSweeper({
      queue: this.journalQueue,
    });
    this.runtimeOwnership = new RuntimeOwnershipCoordinator({
      runtimeRoot: this.runtimeRoot,
      logger: this.logger,
      approvalStore: this.approvalStore,
      outboxStore: this.outboxStore,
      runtimeHealthStore: this.runtimeHealthStore,
      leaderLockManager: this.leaderLockManager,
      onLeadershipLost: (reason) => this.failRuntimeLeadership(reason),
    });

    // Initialize daemon state
    this.state = DaemonStateSchema.parse({
      pid: process.pid,
      started_at: new Date().toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    });
  }

  private resolveRuntimeRoot(): string {
    const configuredRoot = this.config.runtime_root;
    if (!configuredRoot || configuredRoot.trim() === "") {
      return path.join(this.baseDir, "runtime");
    }
    return path.isAbsolute(configuredRoot)
      ? configuredRoot
      : path.resolve(this.baseDir, configuredRoot);
  }

  // ─── Public API ───

  /**
   * Start daemon loop for given goals.
   * Throws if daemon is already running.
   */
  async start(goalIds: string[]): Promise<void> {
    let startupReady = false;
    try {
      // 2. Rotate log if needed, then check for crash recovery marker
      await this.rotateLog();
      await this.checkCrashRecovery();
      await this.initializeRuntimeFoundation();
      await this.acquireRuntimeLeadership();

      // 2c. Start EventServer (always-on) and file watcher
      if (!this.eventServer) {
        const esPort = this.config.event_server_port ?? 41700;
        this.eventServer = new EventServer(this.driveSystem, {
          port: esPort,
          stateManager: this.stateManager,
          outboxStore: this.outboxStore ?? undefined,
        }, this.logger);
      }
      if (this.outboxStore) {
        this.eventServer.setOutboxStore?.(this.outboxStore);
      }
      this.eventServer.setActiveWorkersProvider?.(() => {
        const workers = this.supervisor?.getState().workers ?? [];
        return workers
          .filter((worker) => worker.goalId !== null)
          .map((worker) => ({
            worker_id: worker.workerId,
            goal_id: worker.goalId,
            started_at: worker.startedAt,
            iterations: worker.iterations,
          }));
      });
      if (this.approvalBroker) {
        this.approvalBroker.setBroadcast((eventType, data) => {
          void this.eventServer?.broadcast?.(eventType, data);
        });
        this.eventServer.setApprovalBroker?.(this.approvalBroker);
      }

      this.eventServer.setCommandEnvelopeHook?.(async (envelope: Envelope) => this.handleInboundEnvelope(envelope));

      if (this.gateway) {
        // Phase A: Route through Gateway → Envelope → writeEvent
        const httpAdapter = new HttpChannelAdapter(this.eventServer);
        this.gateway.registerAdapter(httpAdapter);
        this.gateway.onEnvelope(async (envelope: Envelope) => this.handleInboundEnvelope(envelope));
        // Wire onHighPriority to abort sleep — done via the abortSleep() public method.
        // Callers who construct buses should pass: onHighPriority: () => daemon.abortSleep()
        // The daemon provides abortSleep() below for this purpose.
        await this.gateway.start();
        this.logger.info("Gateway started with HTTP adapter", { port: this.eventServer.getPort() });
      } else {
        await this.eventServer.start();
        this.eventServer.startFileWatcher();
        this.logger.info("EventServer started", { port: this.eventServer.getPort() });
      }

      // Wire approval bridge if not already provided
      if (!this.approvalFn && this.eventServer) {
        const es = this.eventServer;
        this.approvalFn = async (task: Record<string, unknown>): Promise<boolean> => {
          const goalId = String(task["goal_id"] ?? "unknown");
          const description = String(task["description"] ?? "");
          const action = String(task["action"] ?? "");
          const taskId = String(task["id"] ?? "");

          if (this.reportingEngine) {
            try {
              await this.reportingEngine.generateNotification("approval_required", {
                goalId,
                message: description || action || taskId || "Task approval required",
                details: [`task_id: ${taskId || "(none)"}`, `action: ${action || "(none)"}`].join("\n"),
              });
            } catch (err) {
              this.logger.warn("Approval notification dispatch failed", {
                goalId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          return es.requestApproval(
            goalId,
            {
              id: taskId,
              description,
              action,
            }
          );
        };
      }

      this.stopStatusHeartbeat = startDaemonStatusHeartbeat({
        eventServer: this.eventServer,
        getSnapshot: () => ({
          status: this.state.status,
          activeGoals: this.state.active_goals,
          loopCount: this.state.loop_count,
          startedAt: this.state.started_at,
        }),
      });

      this.driveSystem.startWatcher((event) => this.onEventReceived(event));

      this.shuttingDown = false;
      const shutdownTimeout = this.config.crash_recovery.graceful_shutdown_timeout_ms ?? 30_000;
      this.shutdownCoordinator = new ProcessShutdownCoordinator({
        logger: this.logger,
        gracefulShutdownTimeoutMs: shutdownTimeout,
        onShutdown: () => this.beginGracefulShutdown(),
        onForceStop: () => {
          this.running = false;
        },
      });
      this.shutdownCoordinator.activate();

      // 4. Restore state from previous interrupted run
      const mergedGoalIds = await this.restoreState(goalIds);

      // 5. Save initial daemon state
      this.running = true;
      this.currentGoalIds = mergedGoalIds;
      this.currentLoopIndex = 0;
      this.state = DaemonStateSchema.parse({
        pid: process.pid,
        started_at: new Date().toISOString(),
        last_loop_at: null,
        loop_count: 0,
        active_goals: mergedGoalIds,
        status: "running",
        crash_count: 0,
        last_error: null,
      });
      await this.saveDaemonState();

      // 5b. Write "running" shutdown marker (crash detection on next startup)
      await this.writeShutdownMarker({
        goal_ids: mergedGoalIds,
        loop_index: 0,
        timestamp: new Date().toISOString(),
        reason: "startup",
        state: "running",
      });

      // 6. Log start
      this.logger.info("Daemon started", {
        pid: process.pid,
        goals: mergedGoalIds,
        check_interval_ms: this.config.check_interval_ms,
      });

      const sweepResult = this.queueClaimSweeper?.sweep();
      if (sweepResult && (sweepResult.reclaimed > 0 || sweepResult.deadlettered > 0)) {
        this.logger.info("Recovered stale runtime claims on startup", {
          reclaimed: sweepResult.reclaimed,
          deadlettered: sweepResult.deadlettered,
          expiredClaimTokens: sweepResult.expiredClaimTokens,
        });
      }
      this.queueClaimSweeper?.start();

    // 7. Create supervisor if not already provided.
    if (!this.supervisor) {
      const factory = this.deps.coreLoopFactory ?? (() => this.coreLoop);
      this.supervisor = new LoopSupervisor(
        {
          coreLoopFactory: factory,
          journalQueue: this.journalQueue!,
          goalLeaseManager: this.goalLeaseManager!,
          driveSystem: this.driveSystem,
          stateManager: this.stateManager,
          logger: this.logger,
          onGoalComplete: async (goalId, result) => this.handleGoalCompletion(goalId, result),
          onEscalation: (goalId, crashCount, lastError) => {
            this.logger.error(`Goal ${goalId} suspended after ${crashCount} crashes: ${lastError}`);
          },
        },
        { iterationsPerCycle: this.config.iterations_per_cycle }
      );
    }
    if (!this.eventDispatcher) {
      this.eventDispatcher = new EventDispatcher({
        journalQueue: this.journalQueue!,
        logger: this.logger,
        onGoalActivate: async (goalId) => this.handleGoalStartCommand(goalId),
        onExternalEvent: async (event) =>
          this.driveSystem.writeEvent(PulSeedEventSchema.parse(event)),
        onCronTaskDue: async (task) => this.handleCronTaskDue(task.id),
      });
    }
    if (!this.commandDispatcher) {
      this.commandDispatcher = new CommandDispatcher({
        journalQueue: this.journalQueue!,
        logger: this.logger,
        onGoalStart: async (goalId) => this.handleGoalStartCommand(goalId),
        onGoalStop: async (goalId) => this.handleGoalStopCommand(goalId),
        onChatMessage: async (goalId, message) =>
          this.handleChatMessageCommand(goalId, message),
        onApprovalResponse: async (goalId, requestId, approved) =>
          this.handleApprovalResponseCommand(goalId, requestId, approved),
      });
    }

    await this.saveRuntimeHealthSnapshot(
      this.supervisor
        ? "execution_ownership_durable"
        : "foundation_only",
      {
        gateway: this.gateway || this.eventServer ? "ok" : "degraded",
        queue: "ok",
        leases: "ok",
        approval: "ok",
        outbox: "ok",
        supervisor: this.supervisor ? "ok" : "degraded",
      }
    );

    // 8. Run main loop — supervisor mode when supervisor is injected via deps,
    //    fallback to sequential runLoop otherwise.
      startupReady = true;
      let cleanupHandled = false;
      try {
        await this.eventDispatcher?.start();
        await this.commandDispatcher?.start();
        if (this.supervisor) {
          // Supervisor handles goal execution; cron/schedule must also run in this mode.
          await this.supervisor.start(mergedGoalIds);

          const maintenanceIntervalMs = this.config.check_interval_ms;
          await this.runSupervisorMaintenanceCycle();
          this.cronScheduleInterval = setInterval(async () => {
            if (this.shuttingDown) return;
            await this.runSupervisorMaintenanceCycle();
          }, maintenanceIntervalMs);

          // Block until stop() is called.
          await new Promise<void>((resolve) => {
            this.shutdownResolve = resolve;
            // If already stopped before we get here, resolve immediately.
            if (!this.running) resolve();
          });
        } else {
          // Fallback: sequential mode
          await this.runLoop();
          cleanupHandled = true;
        }
      } finally {
        this.queueClaimSweeper?.stop();
        this.shutdownCoordinator?.dispose();
        this.shutdownCoordinator = null;
        this.stopStatusHeartbeat?.();
        this.stopStatusHeartbeat = null;
        if (this.cronScheduleInterval !== null) {
          clearInterval(this.cronScheduleInterval);
          this.cronScheduleInterval = null;
        }
        await this.supervisor?.shutdown();
        await this.eventDispatcher?.shutdown();
        await this.commandDispatcher?.shutdown();
        this.driveSystem.stopWatcher();
        if (this.gateway) {
          await this.gateway.stop();
          this.logger.info("Gateway stopped");
        } else if (this.eventServer) {
          this.eventServer.stopFileWatcher();
          await this.eventServer.stop();
          this.logger.info("EventServer stopped");
        }
        if (!cleanupHandled) {
          await this.cleanup();
        }
      }
    } catch (err) {
      if (!startupReady) {
        await this.releaseStartupOwnership();
      }
      throw err;
    }
  }

  private async initializeRuntimeFoundation(): Promise<void> {
    await this.runtimeOwnership.initializeFoundation();
  }

  private async saveRuntimeHealthSnapshot(
    phase: string,
    components: RuntimeHealthComponents
  ): Promise<void> {
    await this.runtimeOwnership.saveRuntimeHealthSnapshot(phase, components);
  }

  private async acquireRuntimeLeadership(): Promise<void> {
    await this.runtimeOwnership.acquireLeadership(
      RUNTIME_LEADER_LEASE_MS,
      RUNTIME_LEADER_HEARTBEAT_MS
    );
  }

  private failRuntimeLeadership(reason: string): void {
    if (this.state.status === "crashed") {
      return;
    }

    this.logger.error("Lost runtime leadership; stopping daemon", {
      error: reason,
    });
    this.state.status = "crashed";
    this.state.last_error = reason;
    this.running = false;
    this.shuttingDown = true;
    this.shutdownResolve?.();
    this.sleepAbortController?.abort();
    void this.saveDaemonState();
  }

  private async releaseStartupOwnership(): Promise<void> {
    await this.runtimeOwnership.releaseLeadership();
  }

  /** Expose approvalFn for callers (e.g. cmdStart) to wire into TaskLifecycle */
  getApprovalFn(): ((task: Record<string, unknown>) => Promise<boolean>) | undefined {
    return this.approvalFn;
  }

  /**
   * Abort the current sleep cycle immediately.
   */
  abortSleep(): void {
    this.sleepAbortController?.abort();
  }

  /**
   * Signal daemon to stop after current iteration completes.
   * Saves interrupted_goals so they can be restored on next start.
   */
  stop(): void {
    this.running = false;
    this.shutdownResolve?.();
    this.sleepAbortController?.abort();
    this.state.status = "stopping";
    // Save current active_goals as interrupted_goals for state restoration
    this.state.interrupted_goals = [...this.state.active_goals];
    // Do NOT persist here — cleanup() will save the final state after the loop exits.
    // Calling saveDaemonState() here would race with cleanup()'s save and corrupt the file.
    this.logger.info("Stop requested — daemon will stop after current iteration");
  }

  // ─── Private: Main Loop ───

  /**
   * Main daemon loop. Runs until this.running is false or a critical error occurs.
   */
  private async runLoop(): Promise<void> {
    while (this.running && !this.shuttingDown) {
      try {
        const goalIds = [...this.currentGoalIds];
        // 1. Determine which goals need activation
        const activeGoals = await this.determineActiveGoals(goalIds);

        if (activeGoals.length === 0) {
          this.logger.info("No goals need activation this cycle", {
            checked: goalIds.length,
          });
        }

        // 2. Execute loop for each active goal
        for (const goalId of activeGoals) {
          if (!this.running) break;

          this.logger.info(`Running loop for goal: ${goalId}`);

          try {
            const iterationsPerCycle = this.config.iterations_per_cycle ?? 1;
            const result: LoopResult = await this.coreLoop.run(goalId, { maxIterations: iterationsPerCycle });
            this.state.loop_count++;
            this.currentLoopIndex = this.state.loop_count;
            this.state.last_loop_at = new Date().toISOString();
            this.logger.info(`Loop completed for goal: ${goalId}`, {
              status: result.finalStatus,
              iterations: result.totalIterations,
            });
            if (this.eventServer) {
              const goal = await this.stateManager.loadGoal(goalId).catch(() => null);
              void this.eventServer.broadcast?.("iteration_complete", {
                goalId,
                loopCount: this.state.loop_count,
                status: goal?.status ?? "unknown",
              });
            }
          } catch (err) {
            this.handleLoopError(goalId, err);
          }

          // Bail out of goal iteration if crash limit exceeded
          if (!this.running) break;
        }

        // 3. Save state
        await this.saveDaemonState();
        if (this.eventServer) {
          void this.eventServer.broadcast?.("daemon_status", {
            status: this.state.status,
            activeGoals: this.state.active_goals,
            loopCount: this.state.loop_count,
            lastLoopAt: this.state.last_loop_at,
          });
        }

        // 3b. Process due cron-scheduled tasks
        await this.processCronTasks();

        // 3b2. Process schedule engine entries
        await this.processScheduleEntries();

        // 3c. Expire old cron tasks periodically (every 100 cycles)
        if (this.state.loop_count > 0 && this.state.loop_count % 100 === 0) {
          await this.expireCronTasks();
        }

        // 4. Proactive tick: fire every cycle (not only when idle) so long-running goals
        // do not block proactive actions indefinitely.
        if (this.running) {
          await this.proactiveTick();
        }

        // 5. Track idle cycles for adaptive sleep
        if (activeGoals.length > 0) {
          this.consecutiveIdleCycles = 0;
        } else {
          this.consecutiveIdleCycles++;
        }

        // 6. Wait for next check interval
        if (this.running) {
          const baseIntervalMs = this.getNextInterval(goalIds);
          const maxGapScore = await this.getMaxGapScore(goalIds);
          const intervalMs = this.calculateAdaptiveInterval(
            baseIntervalMs,
            activeGoals.length,
            maxGapScore,
            this.consecutiveIdleCycles
          );
          this.logger.info(`Sleeping for ${intervalMs}ms until next check`);
          await this.sleep(intervalMs);
        }
      } catch (err) {
        await this.handleCriticalError(err);
      }
    }

    // Cleanup after loop exits
    await this.cleanup();
  }

  // ─── Private: Goal Activation ───

  /**
   * Determine which goals should be activated this cycle.
   * Uses DriveSystem.shouldActivate() for each goal, then sorts by priority.
   */
  private async determineActiveGoals(goalIds: string[]): Promise<string[]> {
    const eligibleIds: string[] = [];
    const scores = new Map<string, number>();

    for (const goalId of goalIds) {
      if (await this.driveSystem.shouldActivate(goalId)) {
        eligibleIds.push(goalId);
        // Load goal to get a rough priority signal (gap or drive score not available here)
        // Use schedule consecutive_actions as a tiebreaker — more urgent goals first
        const schedule = await this.driveSystem.getSchedule(goalId);
        // Higher consecutive_actions = more urgent (stalled goal). Use inverse of next_check_at
        // as a proxy: goals that are most overdue rank highest.
        const nextCheckAt = schedule
          ? new Date(schedule.next_check_at).getTime()
          : 0;
        // Earlier next_check_at means more overdue → assign higher (inverted) score
        scores.set(goalId, -nextCheckAt);
      }
    }

    // Sort by priority: most overdue first
    return this.driveSystem.prioritizeGoals(eligibleIds, scores);
  }

  // ─── Private: Interval Calculation ───

  /**
   * Calculate the next check interval in milliseconds.
   * Uses per-goal override from config.goal_intervals if configured,
   * otherwise falls back to config.check_interval_ms.
   * Returns the minimum interval across all goals (so the daemon checks
   * as soon as the earliest goal is due).
   */
  private getNextInterval(goalIds: string[]): number {
    const goalIntervals = this.config.goal_intervals;

    if (!goalIntervals || goalIds.length === 0) {
      return this.config.check_interval_ms;
    }

    let minInterval = this.config.check_interval_ms;

    for (const goalId of goalIds) {
      const override = goalIntervals[goalId];
      if (override !== undefined && override < minInterval) {
        minInterval = override;
      }
    }

    return minInterval;
  }

  // ─── Private: Error Handling ───

  /**
   * Handle a non-critical loop error for a single goal.
   * Increments crash_count and stops daemon if max_retries exceeded.
   */
  private handleLoopError(goalId: string, err: unknown): void {
    this.state.last_error = err instanceof Error ? err.message : String(err);
    this.state.crash_count++;
    this.logger.error(`Loop error for goal ${goalId}`, {
      error: this.state.last_error,
      crash_count: this.state.crash_count,
      max_retries: this.config.crash_recovery.max_retries,
    });

    // If crash count exceeds max_retries, stop daemon
    if (this.state.crash_count >= this.config.crash_recovery.max_retries) {
      this.logger.error(
        `Max crash retries (${this.config.crash_recovery.max_retries}) exceeded, stopping daemon`
      );
      this.running = false;
    }
  }

  /**
   * Handle a critical daemon-level error (outer loop catch).
   * Marks state as crashed and stops the loop.
   */
  private async handleCriticalError(err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.error("Critical daemon error", { error: msg });
    this.state.status = "crashed";
    this.state.last_error = msg;
    await this.saveDaemonState();
    this.running = false;
  }

  // ─── Private: State Persistence ───

  /**
   * Save daemon state to {baseDir}/daemon-state.json atomically.
   */
  private async saveDaemonState(): Promise<void> {
    const statePath = path.join(this.baseDir, "daemon-state.json");
    try {
      await writeJsonFileAtomic(statePath, this.state);
    } catch (err) {
      // Non-fatal — log but don't crash the daemon
      this.logger.warn("Failed to save daemon state", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load daemon state from {baseDir}/daemon-state.json.
   * Returns null if the file doesn't exist or fails to parse.
   */
  private async loadDaemonState(): Promise<DaemonState | null> {
    const statePath = path.join(this.baseDir, "daemon-state.json");
    const data = await readJsonFileOrNull(statePath);
    if (data === null) return null;
    try {
      return DaemonStateSchema.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Restore state from a previous interrupted run.
   * Merges interrupted_goals from daemon-state.json with the given goalIds (deduped).
   * Returns the merged goal ID array.
   */
  private async restoreState(goalIds: string[]): Promise<string[]> {
    const saved = await this.loadDaemonState();
    if (!saved || !saved.interrupted_goals || saved.interrupted_goals.length === 0) {
      return goalIds;
    }

    const merged = Array.from(new Set([...goalIds, ...saved.interrupted_goals]));
    if (merged.length > goalIds.length) {
      this.logger.info("Restored interrupted goals from previous run", {
        interrupted: saved.interrupted_goals,
        merged,
      });
    }
    return merged;
  }

  // ─── Private: Cleanup ───

  /**
   * Perform cleanup after the loop exits and write the final runtime health snapshot.
   * Also writes "clean_shutdown" marker to enable crash-vs-clean detection on next startup.
   */
  private async cleanup(): Promise<void> {
    // Only set to "stopped" if not already "crashed"
    const wasCrashed = this.state.status === "crashed";
    if (!wasCrashed) {
      this.state.status = "stopped";
      if (this.state.interrupted_goals === undefined) {
        this.state.interrupted_goals = [...this.state.active_goals];
      }
    }
    await this.saveDaemonState();
    await this.runtimeOwnership.releaseLeadership();
    await this.runtimeOwnership.saveFinalHealth(wasCrashed ? "failed" : "degraded");

    // Write clean shutdown marker (async, atomic)
    const markerPath = path.join(this.baseDir, "shutdown-state.json");
    const marker: ShutdownMarker = {
      goal_ids: this.currentGoalIds,
      loop_index: this.currentLoopIndex,
      timestamp: new Date().toISOString(),
      reason: wasCrashed ? "max_retries" : "stop",
      state: wasCrashed ? "running" : "clean_shutdown",
    };
    try {
      await writeJsonFileAtomic(markerPath, marker);
    } catch (err) {
      this.logger.warn("Failed to write shutdown marker", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.logger.info("Daemon stopped", {
      loop_count: this.state.loop_count,
      crash_count: this.state.crash_count,
    });
  }

  private beginGracefulShutdown(): void {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    this.logger.info("Shutting down gracefully...");
    this.running = false;
    this.state.status = "stopping";
    this.state.interrupted_goals = [...this.state.active_goals];
    this.shutdownResolve?.();
    this.sleepAbortController?.abort();
  }

  // ─── Private: Cron Scheduler ───

  /**
   * Process due cron-scheduled tasks.
   * Logs each task, executes based on type, and marks as fired.
   */
  private async processCronTasks(): Promise<void> {
    if (!this.cronScheduler) return;

    try {
      const dueTasks = await this.cronScheduler.getDueTasks();
      for (const task of dueTasks) {
        this.logger.info(`Cron task due: ${task.id} (type=${task.type})`, {
          cron: task.cron,
          type: task.type,
        });

        const envelope = createEnvelope({
          type: "event",
          name: "cron_task_due",
          source: "cron-scheduler",
          priority: "normal",
          payload: task,
          dedupe_key: `cron-${task.id}`,
        });
        if (!this.acceptRuntimeEnvelope(envelope)) {
          continue;
        }
      }
    } catch (err) {
      // Non-fatal — cron errors should not crash the daemon
      this.logger.warn("Failed to process cron tasks", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Process due schedule engine entries.
   */
  private async processScheduleEntries(): Promise<void> {
    if (!this.scheduleEngine) return;
    try {
      const results = await this.scheduleEngine.tick();
      for (const result of results) {
        if (result.status === "error") {
          this.logger?.warn?.(`Schedule entry ${result.entry_id} failed: ${result.error_message}`);
        } else {
          // Record schedule activation in the runtime journal before any in-memory fanout.
          const goalId = (result as Record<string, unknown>)["goal_id"] as string | undefined;
          if (!goalId) {
            this.logger.warn("schedule_activated envelope missing goal_id", { entry_id: (result as Record<string, unknown>)["entry_id"] });
          }
          const envelope = createEnvelope({
            type: "event",
            name: "schedule_activated",
            source: "schedule-engine",
            goal_id: goalId,
            priority: "normal",
            payload: result,
            dedupe_key: result.entry_id,
          });
          if (!this.acceptRuntimeEnvelope(envelope)) {
            continue;
          }
        }
      }
    } catch (error) {
      this.logger?.error?.("Failed to process schedule entries", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Expire old non-permanent cron tasks.
   */
  private async expireCronTasks(): Promise<void> {
    if (!this.cronScheduler) return;

    try {
      await this.cronScheduler.expireOldTasks();
      this.logger.debug("Expired old cron tasks");
    } catch (err) {
      this.logger.warn("Failed to expire cron tasks", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── Private: Sleep ───

  /**
   * Sleep for the given number of milliseconds.
   * Can be aborted early via sleepAbortController (e.g. when an event arrives).
   */
  private sleep(ms: number): Promise<void> {
    this.sleepAbortController = new AbortController();
    const abortController = this.sleepAbortController;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      abortController.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    }).finally(() => {
      this.sleepAbortController = null;
    });
  }

  // ─── Private: Event Handling ───

  /**
   * Called when a file-watcher event arrives from DriveSystem.
   * Aborts the current sleep so the loop runs immediately.
   */
  private onEventReceived(event: PulSeedEvent): void {
    this.logger.info("Event received, triggering immediate loop", {
      event_type: event.type,
    });
    this.sleepAbortController?.abort();
  }

  private acceptRuntimeEnvelope(envelope: Envelope): boolean {
    if (!this.journalQueue) return true;

    const result: JournalBackedQueueAcceptResult = this.journalQueue.accept(envelope);
    if (result.accepted) {
      return true;
    }

    this.logger.info("Runtime journal skipped envelope", {
      id: envelope.id,
      name: envelope.name,
      type: envelope.type,
      duplicate: result.duplicate,
      runtime_root: this.runtimeRoot,
    });
    return false;
  }

  private async handleInboundEnvelope(envelope: Envelope): Promise<void> {
    if (!this.acceptRuntimeEnvelope(envelope)) {
      return;
    }
  }

  private async handleGoalStartCommand(goalId: string): Promise<void> {
    if (!this.currentGoalIds.includes(goalId)) {
      this.currentGoalIds.push(goalId);
    }
    this.state.active_goals = [...this.currentGoalIds];
    await this.saveDaemonState();
    this.supervisor?.activateGoal(goalId);
    this.abortSleep();
  }

  private async handleGoalStopCommand(goalId: string): Promise<void> {
    this.currentGoalIds = this.currentGoalIds.filter((id) => id !== goalId);
    this.state.active_goals = [...this.currentGoalIds];
    if (this.state.interrupted_goals) {
      this.state.interrupted_goals = this.state.interrupted_goals.filter((id) => id !== goalId);
    }
    await this.saveDaemonState();
    this.supervisor?.deactivateGoal(goalId);
    this.abortSleep();
  }

  private async handleGoalCompletion(goalId: string, result: { status: string; totalIterations: number }): Promise<void> {
    this.state.loop_count++;
    this.currentLoopIndex = this.state.loop_count;
    this.state.last_loop_at = new Date().toISOString();
    await this.saveDaemonState();

    if (this.eventServer) {
      const goal = await this.stateManager.loadGoal(goalId).catch(() => null);
      void this.eventServer.broadcast?.("iteration_complete", {
        goalId,
        loopCount: this.state.loop_count,
        status: goal?.status ?? result.status,
        iterations: result.totalIterations,
      });
      void this.eventServer.broadcast?.("daemon_status", {
        status: this.state.status,
        activeGoals: this.state.active_goals,
        loopCount: this.state.loop_count,
        lastLoopAt: this.state.last_loop_at,
      });
    }
  }

  private async runSupervisorMaintenanceCycle(): Promise<void> {
    const activeGoals = await this.determineActiveGoals([...this.currentGoalIds]);
    for (const goalId of activeGoals) {
      this.supervisor?.activateGoal(goalId);
    }

    await this.processCronTasks();
    await this.processScheduleEntries();
    await this.proactiveTick();
    await this.saveDaemonState();

    if (this.eventServer) {
      void this.eventServer.broadcast?.("daemon_status", {
        status: this.state.status,
        activeGoals: this.state.active_goals,
        loopCount: this.state.loop_count,
        lastLoopAt: this.state.last_loop_at,
      });
    }
  }

  private async handleChatMessageCommand(goalId: string, message: string): Promise<void> {
    await this.driveSystem.writeEvent(
      PulSeedEventSchema.parse({
        type: "internal",
        source: "command-dispatcher",
        timestamp: new Date().toISOString(),
        data: {
          goal_id: goalId,
          kind: "chat_message",
          message,
        },
      })
    );
    this.abortSleep();
  }

  private async handleApprovalResponseCommand(
    goalId: string | undefined,
    requestId: string,
    approved: boolean
  ): Promise<void> {
    if (this.approvalBroker) {
      await this.approvalBroker.resolveApproval(requestId, approved, "dispatcher");
      return;
    }
    if (goalId && this.eventServer) {
      await this.eventServer.resolveApproval(requestId, approved);
    }
  }

  private async handleCronTaskDue(taskId: string): Promise<void> {
    if (!this.cronScheduler) {
      return;
    }
    try {
      await this.cronScheduler.markFired(taskId);
      this.logger.info(`Cron task fired: ${taskId}`);
    } catch (err) {
      this.logger.warn(`Cron task ${taskId} failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
      await this.cronScheduler.markFired(taskId);
    }
  }

  // ─── Private: Proactive Tick ───

  // Zod schema for the LLM proactive action response
  private static readonly ProactiveResponseSchema = z.object({
    action: z.enum(["suggest_goal", "investigate", "preemptive_check", "sleep"]),
    details: z.record(z.string(), z.unknown()).optional(),
  });

  /**
   * Ask the LLM for a proactive action when no goals were activated this cycle.
   * Fires only if proactive_mode is enabled and enough time has passed since last tick.
   * Errors are caught and logged — they never affect the daemon loop.
   */
  private async proactiveTick(): Promise<void> {
    if (!this.config.proactive_mode) return;
    if (!this.llmClient) return;
    if (Date.now() - this.lastProactiveTickAt < this.config.proactive_interval_ms) return;

    try {
      // Build a brief summary of all tracked goals from daemon state
      const goalSummaries = this.state.active_goals.length > 0
        ? this.state.active_goals.map((id) => `- ${id}`).join("\n")
        : "(no active goals)";

      const prompt = `${getInternalIdentityPrefix("proactive engine")} Given the current state of all goals:\n${goalSummaries}\n\nDecide what action to take:\n- "suggest_goal": A new goal should be created (provide title + description)\n- "investigate": Something needs investigation (provide what and why)\n- "preemptive_check": Run a pre-emptive observation (provide goal_id)\n- "sleep": Nothing needs attention right now\n\nRespond with JSON: { "action": "...", "details": { ... } }`;

      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { model_tier: "light" }
      );

      const parsed = DaemonRunner.ProactiveResponseSchema.safeParse(
        this.llmClient.parseJSON(response.content, DaemonRunner.ProactiveResponseSchema)
      );

      if (!parsed.success) {
        this.logger.warn("Proactive tick: failed to parse LLM response", {
          raw: response.content,
          error: parsed.error.message,
        });
        this.lastProactiveTickAt = Date.now();
        return;
      }

      const { action, details } = parsed.data;

      if (action === "sleep") {
        this.logger.debug("Proactive tick: LLM decided to sleep");
      } else {
        this.logger.info(`Proactive tick: action=${action}`, { details });
      }
    } catch (err) {
      this.logger.warn("Proactive tick: LLM error (ignored)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.lastProactiveTickAt = Date.now();
  }

  // ─── Private: Adaptive Sleep ───

  /**
   * Get the highest gap score across all active goals.
   * Falls back to 0 if no gap data is available.
   */
  private async getMaxGapScore(goalIds: string[]): Promise<number> {
    let max = 0;
    for (const goalId of goalIds) {
      try {
        const schedule = await this.driveSystem.getSchedule(goalId);
        if (schedule && typeof (schedule as Record<string, unknown>)["last_gap_score"] === "number") {
          const score = (schedule as Record<string, unknown>)["last_gap_score"] as number;
          if (score > max) max = score;
        }
      } catch {
        // Non-fatal — just use 0 for this goal
      }
    }
    return max;
  }

  /**
   * Thin wrapper delegating to the standalone calculateAdaptiveInterval function.
   * Passes this.config.adaptive_sleep as the config parameter.
   * Kept as a class method so tests can call daemon.calculateAdaptiveInterval(...).
   */
  calculateAdaptiveInterval(
    baseInterval: number,
    goalsActivatedThisCycle: number,
    maxGapScore: number,
    consecutiveIdleCycles: number
  ): number {
    return calcAdaptiveInterval(
      baseInterval,
      goalsActivatedThisCycle,
      maxGapScore,
      consecutiveIdleCycles,
      this.config.adaptive_sleep
    );
  }

  // ─── Private: Shutdown Marker ───

  /**
   * Write shutdown-state.json to baseDir (async, atomic).
   */
  private async writeShutdownMarker(marker: ShutdownMarker): Promise<void> {
    const markerPath = path.join(this.baseDir, "shutdown-state.json");
    try {
      await writeJsonFileAtomic(markerPath, marker);
    } catch (err) {
      this.logger.warn("Failed to write shutdown marker", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Read shutdown-state.json from baseDir.
   * Returns null if file doesn't exist or fails to parse.
   */
  async readShutdownMarker(): Promise<ShutdownMarker | null> {
    const markerPath = path.join(this.baseDir, "shutdown-state.json");
    return readJsonFileOrNull<ShutdownMarker>(markerPath);
  }

  /**
   * Delete shutdown-state.json (after successful resume).
   */
  async deleteShutdownMarker(): Promise<void> {
    const markerPath = path.join(this.baseDir, "shutdown-state.json");
    try {
      await fsp.unlink(markerPath);
    } catch {
      // File may not exist — ignore
    }
  }

  /**
   * Check for a previous shutdown marker and log recovery information.
   * Called at startup before the main loop begins.
   */
  private async checkCrashRecovery(): Promise<void> {
    const marker = await this.readShutdownMarker();
    if (!marker) return;

    if (marker.state === "clean_shutdown") {
      this.logger.info("Resuming from clean shutdown", {
        previous_loop_index: marker.loop_index,
        previous_goals: marker.goal_ids,
        shutdown_at: marker.timestamp,
      });
    } else {
      // state === "running" — previous instance did not shut down cleanly
      this.logger.warn(
        "Recovering from crash — previous instance did not shut down cleanly",
        {
          previous_loop_index: marker.loop_index,
          previous_goals: marker.goal_ids,
          last_seen_at: marker.timestamp,
        }
      );
    }

    // Delete the marker; we'll write a fresh "running" marker in start()
    await this.deleteShutdownMarker();
  }

  // ─── Log Rotation (delegates to daemon-health) ───

  /**
   * Rotate the main log file if it exceeds the configured size limit.
   * Delegates to rotateDaemonLog() with explicit config params.
   * Called at daemon startup.
   */
  async rotateLog(): Promise<void> {
    const maxSizeBytes = this.config.log_rotation.max_size_mb * 1024 * 1024;
    const maxFiles = this.config.log_rotation.max_files;
    await rotateDaemonLog(this.logPath, this.logDir, maxSizeBytes, maxFiles, this.logger);
  }

  // ─── Static Utilities (delegates to daemon-signals) ───

  /**
   * Generate a crontab entry that runs `pulseed run --goal <goalId>` on a schedule.
   * Delegates to the standalone generateCronEntry() function in daemon-signals.ts.
   */
  static generateCronEntry(goalId: string, intervalMinutes: number = 60): string {
    return generateCronEntry(goalId, intervalMinutes);
  }
}
