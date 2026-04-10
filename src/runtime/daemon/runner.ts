import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { CoreLoop } from "../../orchestrator/loop/core-loop.js";
import type { LoopResult } from "../../orchestrator/loop/core-loop.js";
import type { GoalNegotiator } from "../../orchestrator/goal/goal-negotiator.js";
import type { Goal } from "../../base/types/goal.js";
import { DriveSystem } from "../../platform/drive/drive-system.js";
import { StateManager } from "../../base/state/state-manager.js";
import { getProviderRuntimeFingerprint } from "../../base/llm/provider-config.js";
import type { CuriosityEngine } from "../../platform/traits/curiosity-engine.js";
import { PIDManager } from "../pid-manager.js";
import { Logger } from "../logger.js";
import { EventServer } from "../event/server.js";
import type { PulSeedEvent } from "../../base/types/drive.js";
import type { DaemonConfig, DaemonState, ResidentActivity } from "../../base/types/daemon.js";
import { DaemonConfigSchema, DaemonStateSchema, ResidentActivitySchema } from "../../base/types/daemon.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import { CronScheduler } from "../cron-scheduler.js";
import { ScheduleEngine } from "../schedule/engine.js";
import type { MemoryLifecycleManager } from "../../platform/knowledge/memory/memory-lifecycle.js";
import type { KnowledgeManager } from "../../platform/knowledge/knowledge-manager.js";
import { DreamAnalyzer } from "../../platform/dream/dream-analyzer.js";
import { DreamScheduleSuggestionStore } from "../../platform/dream/dream-schedule-suggestions.js";
import type { DreamRunReport, DreamTier } from "../../platform/dream/dream-types.js";
import { runDreamConsolidation } from "../../reflection/dream-consolidation.js";
import { generateCronEntry } from "./signals.js";
import { rotateDaemonLog, calculateAdaptiveInterval as calcAdaptiveInterval } from "./health.js";
import { IngressGateway, HttpChannelAdapter } from "../gateway/index.js";
import { PulSeedEventSchema } from "../../base/types/drive.js";
import type { Envelope } from "../types/envelope.js";
import { LoopSupervisor } from "../executor/index.js";
import { ApprovalStore, OutboxStore, RuntimeHealthStore, createRuntimeStorePaths } from "../store/index.js";
import { LeaderLockManager } from "../leader-lock-manager.js";
import { GoalLeaseManager } from "../goal-lease-manager.js";
import { JournalBackedQueue, type JournalBackedQueueAcceptResult } from "../queue/journal-backed-queue.js";
import { QueueClaimSweeper } from "../queue/queue-claim-sweeper.js";
import { ApprovalBroker } from "../approval-broker.js";
import { CommandDispatcher } from "../command-dispatcher.js";
import { EventDispatcher } from "../event/dispatcher.js";
import {
  RuntimeOwnershipCoordinator,
  type RuntimeHealthComponents,
} from "./runtime-ownership.js";
import {
  ProcessShutdownCoordinator,
  startDaemonStatusHeartbeat,
} from "./runner-lifecycle.js";
import type { ShutdownMarker } from "./index.js";
import {
  checkCrashRecoveryMarker,
  cleanupDaemonRun,
  collectGoalCycleScheduleSnapshot,
  deleteShutdownMarkerFile,
  determineActiveGoalsForCycle,
  expireOldCronTasks,
  getMaxGapScoreForGoals,
  getNextIntervalForGoals,
  processCronTasksForDaemon,
  processScheduleEntriesForDaemon,
  runRuntimeStoreMaintenanceCycle,
  readShutdownMarkerFile,
  restoreInterruptedGoals,
  runProactiveMaintenance,
  runSupervisorMaintenanceCycleForDaemon,
  saveDaemonStateFile,
  writeChatMessageEvent,
  writeShutdownMarkerFile,
} from "./index.js";
import type { GoalCycleScheduleSnapshotEntry } from "./maintenance.js";

function gatherResidentWorkspaceContext(workspaceDir: string, seedDescription?: string): string {
  const parts: string[] = [`Workspace: ${workspaceDir}`];
  const seed = seedDescription?.trim();
  if (seed) {
    parts.push(`Resident trigger hint: ${seed}`);
  }

  try {
    const pkgPath = path.join(workspaceDir, "package.json");
    const pkgRaw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
    const name = typeof pkg.name === "string" ? pkg.name : "";
    const description = typeof pkg.description === "string" ? pkg.description : "";
    const scripts = pkg.scripts && typeof pkg.scripts === "object"
      ? Object.keys(pkg.scripts as Record<string, unknown>).join(", ")
      : "";
    const prefix = name ? `Node.js project '${name}'` : "Node.js project";
    const descPart = description ? `. ${description}` : "";
    const scriptsPart = scripts ? `. Scripts: ${scripts}` : "";
    parts.push(`${prefix}${descPart}${scriptsPart}`);
  } catch {
    // No package metadata available.
  }

  try {
    const entries = fs.readdirSync(workspaceDir);
    const dirs = entries.filter((entry) => {
      try {
        return fs.statSync(path.join(workspaceDir, entry)).isDirectory();
      } catch {
        return false;
      }
    });
    const files = entries.filter((entry) => {
      try {
        return fs.statSync(path.join(workspaceDir, entry)).isFile();
      } catch {
        return false;
      }
    });
    const visibleEntries = [
      dirs.slice(0, 10).map((entry) => `${entry}/`).join(", "),
      files.slice(0, 5).join(", "),
    ].filter(Boolean).join(", ");
    if (visibleEntries) {
      parts.push(`Files: ${visibleEntries}`);
    }
  } catch {
    // Workspace listing is best-effort.
  }

  const gitResult = spawnSync("git", ["log", "--oneline", "-5", "--format=%s"], {
    cwd: workspaceDir,
    encoding: "utf-8",
  });
  if (gitResult.status === 0 && gitResult.stdout.trim().length > 0) {
    parts.push(`Recent changes: ${gitResult.stdout.trim().split("\n").join("; ")}`);
  }

  return parts.join(". ");
}

// Re-exports for callers that imported these from daemon-runner
export { generateCronEntry } from "./signals.js";
export { rotateDaemonLog, calculateAdaptiveInterval } from "./health.js";
export type { ShutdownMarker } from "./index.js";

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
  curiosityEngine?: CuriosityEngine;
  goalNegotiator?: GoalNegotiator;
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
  memoryLifecycle?: MemoryLifecycleManager;
  knowledgeManager?: KnowledgeManager;
  gateway?: IngressGateway;
  supervisor?: LoopSupervisor;
  getProviderRuntimeFingerprint?: () => Promise<string>;
  refreshResidentDeps?: () => Promise<{
    coreLoop: CoreLoop;
    curiosityEngine?: CuriosityEngine;
    goalNegotiator?: GoalNegotiator;
    llmClient?: ILLMClient;
    reportingEngine?: {
      generateNotification(
        type: "approval_required",
        context: { goalId: string; message: string; details?: string }
      ): Promise<unknown>;
    };
    scheduleEngine?: ScheduleEngine;
    memoryLifecycle?: MemoryLifecycleManager;
    knowledgeManager?: KnowledgeManager;
  }>;
  /** Factory to create fresh CoreLoop instances for LoopSupervisor workers. */
  coreLoopFactory?: () => CoreLoop;
}

export class DaemonRunner {
  private coreLoop: CoreLoop;
  private curiosityEngine: CuriosityEngine | undefined;
  private goalNegotiator: GoalNegotiator | undefined;
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
  private memoryLifecycle: MemoryLifecycleManager | undefined;
  private knowledgeManager: KnowledgeManager | undefined;
  private consecutiveIdleCycles: number = 0;
  private gateway: IngressGateway | undefined;
  private supervisor: LoopSupervisor | null = null;
  private lastGoalReviewAt: number = Date.now();
  private cronScheduleInterval: ReturnType<typeof setInterval> | null = null;
  private shutdownResolve: (() => void) | null = null;
  private shutdownCoordinator: ProcessShutdownCoordinator | null = null;
  private stopStatusHeartbeat: (() => void) | null = null;
  private lastRuntimeStoreMaintenanceAt = 0;
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
  private readonly getProviderRuntimeFingerprintFn: () => Promise<string>;
  private readonly refreshResidentDeps: DaemonDeps["refreshResidentDeps"];
  private providerRuntimeFingerprint: string | null = null;

  constructor(deps: DaemonDeps) {
    this.deps = deps;
    this.coreLoop = deps.coreLoop;
    this.curiosityEngine = deps.curiosityEngine;
    this.goalNegotiator = deps.goalNegotiator;
    this.driveSystem = deps.driveSystem;
    this.stateManager = deps.stateManager;
    this.pidManager = deps.pidManager;
    this.logger = deps.logger;
    this.eventServer = deps.eventServer;
    this.llmClient = deps.llmClient;
    this.reportingEngine = deps.reportingEngine;
    this.cronScheduler = deps.cronScheduler;
    this.scheduleEngine = deps.scheduleEngine;
    this.memoryLifecycle = deps.memoryLifecycle;
    this.knowledgeManager = deps.knowledgeManager;
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
    this.getProviderRuntimeFingerprintFn =
      deps.getProviderRuntimeFingerprint ?? getProviderRuntimeFingerprint;
    this.refreshResidentDeps = deps.refreshResidentDeps;

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
      last_resident_at: null,
      resident_activity: null,
    });
  }

  private refreshOperationalState(): void {
    this.state.active_goals = [...this.currentGoalIds];
    if (this.state.status === "crashed" || this.state.status === "stopping") {
      return;
    }
    this.state.status = this.currentGoalIds.length === 0 ? "idle" : "running";
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
      await this.runRuntimeStoreMaintenance(true);

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
        status: mergedGoalIds.length === 0 ? "idle" : "running",
        crash_count: 0,
        last_error: null,
        last_resident_at: null,
        resident_activity: null,
      });
      this.providerRuntimeFingerprint = await this.captureProviderRuntimeFingerprint();
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
        onGoalStart: async (goalId) =>
          this.runCommandWithHealth("goal_start", () => this.handleGoalStartCommand(goalId)),
        onGoalStop: async (goalId) =>
          this.runCommandWithHealth("goal_stop", () => this.handleGoalStopCommand(goalId)),
        onChatMessage: async (goalId, message) =>
          this.runCommandWithHealth("chat_message", () => this.handleChatMessageCommand(goalId, message)),
        onApprovalResponse: async (goalId, requestId, approved) =>
          this.runCommandWithHealth("approval_response", () => this.handleApprovalResponseCommand(goalId, requestId, approved)),
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
        this.refreshOperationalState();
        const cycleSnapshot = await this.collectGoalCycleSnapshot(goalIds);
        // 1. Determine which goals need activation
        const activeGoals = await this.determineActiveGoals(goalIds, cycleSnapshot);
        await this.maybeRefreshProviderRuntime(activeGoals.length);

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
            await this.broadcastGoalUpdated(goalId, result.finalStatus);
          } catch (err) {
            this.handleLoopError(goalId, err);
          }

          // Bail out of goal iteration if crash limit exceeded
          if (!this.running) break;
        }

        // 3. Save state
        this.refreshOperationalState();
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

        if (this.running) {
          await this.runRuntimeStoreMaintenance();
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
          const maxGapScore = await this.getMaxGapScore(goalIds, cycleSnapshot);
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
  private async determineActiveGoals(
    goalIds: string[],
    snapshot: GoalCycleScheduleSnapshotEntry[]
  ): Promise<string[]> {
    return determineActiveGoalsForCycle(this.driveSystem, goalIds, snapshot);
  }

  private async collectGoalCycleSnapshot(goalIds: string[]): Promise<GoalCycleScheduleSnapshotEntry[]> {
    return collectGoalCycleScheduleSnapshot(this.driveSystem, goalIds);
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
    return getNextIntervalForGoals(this.config, goalIds);
  }

  // ─── Private: Error Handling ───

  /**
   * Handle a non-critical loop error for a single goal.
   * Increments crash_count and stops daemon if max_retries exceeded.
   */
  private handleLoopError(goalId: string, err: unknown): void {
    this.state.last_error = err instanceof Error ? err.message : String(err);
    this.state.crash_count++;
    void this.runtimeOwnership.observeTaskExecution(
      "failed",
      `loop error for ${goalId}: ${this.state.last_error}`,
    );
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
    await this.runtimeOwnership.observeTaskExecution("failed", `critical daemon error: ${msg}`);
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
    await saveDaemonStateFile(this.baseDir, this.state, this.logger);
  }

  /**
   * Restore state from a previous interrupted run.
   * Merges interrupted_goals from daemon-state.json with the given goalIds (deduped).
   * Returns the merged goal ID array.
   */
  private async restoreState(goalIds: string[]): Promise<string[]> {
    return restoreInterruptedGoals(this.baseDir, goalIds, this.logger);
  }

  // ─── Private: Cleanup ───

  /**
   * Perform cleanup after the loop exits and write the final runtime health snapshot.
   * Also writes "clean_shutdown" marker to enable crash-vs-clean detection on next startup.
   */
  private async cleanup(): Promise<void> {
    await cleanupDaemonRun({
      baseDir: this.baseDir,
      state: this.state,
      currentGoalIds: this.currentGoalIds,
      currentLoopIndex: this.currentLoopIndex,
      runtimeOwnership: this.runtimeOwnership,
      logger: this.logger,
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
    await processCronTasksForDaemon({
      cronScheduler: this.cronScheduler,
      logger: this.logger,
      acceptRuntimeEnvelope: (envelope) => this.acceptRuntimeEnvelope(envelope),
    });
  }

  /**
   * Process due schedule engine entries.
   */
  private async processScheduleEntries(): Promise<void> {
    await processScheduleEntriesForDaemon({
      scheduleEngine: this.scheduleEngine,
      logger: this.logger,
      acceptRuntimeEnvelope: (envelope) => this.acceptRuntimeEnvelope(envelope),
    });
  }

  private async broadcastGoalUpdated(goalId: string, fallbackStatus?: string): Promise<void> {
    if (!this.eventServer) {
      return;
    }

    const goal = await this.stateManager.loadGoal(goalId).catch(() => null);
    await this.eventServer.broadcast?.("goal_updated", {
      goalId,
      status: goal?.status ?? fallbackStatus ?? "unknown",
      loopStatus: goal?.loop_status ?? null,
      progress: null,
    });
  }

  private async broadcastChatResponse(goalId: string, message: string): Promise<void> {
    if (!this.eventServer) {
      return;
    }

    await this.eventServer.broadcast?.("chat_response", {
      goalId,
      message,
      status: "queued",
    });
  }

  /**
   * Expire old non-permanent cron tasks.
   */
  private async expireCronTasks(): Promise<void> {
    await expireOldCronTasks(this.cronScheduler, this.logger);
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
    this.refreshOperationalState();
    await this.saveDaemonState();
    this.supervisor?.activateGoal(goalId);
    this.abortSleep();
    await this.broadcastGoalUpdated(goalId, "active");
  }

  private async handleGoalStopCommand(goalId: string): Promise<void> {
    this.currentGoalIds = this.currentGoalIds.filter((id) => id !== goalId);
    this.refreshOperationalState();
    if (this.state.interrupted_goals) {
      this.state.interrupted_goals = this.state.interrupted_goals.filter((id) => id !== goalId);
    }
    await this.saveDaemonState();
    this.supervisor?.deactivateGoal(goalId);
    this.abortSleep();
    await this.broadcastGoalUpdated(goalId, "stopped");
  }

  private async handleGoalCompletion(goalId: string, result: { status: string; totalIterations: number }): Promise<void> {
    this.state.loop_count++;
    this.currentLoopIndex = this.state.loop_count;
    this.state.last_loop_at = new Date().toISOString();
    await this.saveDaemonState();
    await this.runtimeOwnership.observeTaskExecution(
      result.status === "error"
        ? "failed"
        : result.status === "stalled"
          ? "degraded"
          : "ok",
      result.status === "error"
        ? `goal ${goalId} execution failed`
        : result.status === "stalled"
          ? `goal ${goalId} stalled`
          : undefined,
    );

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
    await this.broadcastGoalUpdated(goalId, result.status);
  }

  private async loadExistingGoalTitles(): Promise<string[]> {
    const goalIds = await this.stateManager.listGoalIds().catch(() => []);
    const titles: string[] = [];
    for (const goalId of goalIds) {
      const goal = await this.stateManager.loadGoal(goalId).catch(() => null);
      if (goal?.title) {
        titles.push(goal.title);
      }
    }
    return titles;
  }

  private async loadKnownGoals(): Promise<Goal[]> {
    const goalIds = await this.stateManager.listGoalIds().catch(() => []);
    const goals: Goal[] = [];
    for (const goalId of goalIds) {
      const goal = await this.stateManager.loadGoal(goalId).catch(() => null);
      if (goal) {
        goals.push(goal);
      }
    }
    return goals;
  }

  private async persistResidentActivity(
    activity: Omit<ResidentActivity, "recorded_at"> & { recorded_at?: string }
  ): Promise<void> {
    const residentActivity = ResidentActivitySchema.parse({
      ...activity,
      recorded_at: activity.recorded_at ?? new Date().toISOString(),
    });
    this.state.last_resident_at = residentActivity.recorded_at;
    this.state.resident_activity = residentActivity;
    await this.saveDaemonState();
  }

  private async triggerResidentGoalDiscovery(details?: Record<string, unknown>): Promise<void> {
    if (!this.goalNegotiator) {
      await this.persistResidentActivity({
        kind: "skipped",
        trigger: "proactive_tick",
        summary: "Resident discovery skipped because goal negotiation is unavailable.",
      });
      return;
    }

    if (this.currentGoalIds.length > 0) {
      await this.persistResidentActivity({
        kind: "skipped",
        trigger: "proactive_tick",
        summary: "Resident discovery skipped because active goals are already running.",
      });
      return;
    }

    const hintedDescription =
      typeof details?.["description"] === "string" ? details["description"].trim() : "";
    const hintedTitle =
      typeof details?.["title"] === "string" ? details["title"].trim() : "";

    try {
      const workspaceDir = process.cwd();
      const workspaceContext = gatherResidentWorkspaceContext(workspaceDir, hintedDescription);
      const existingTitles = await this.loadExistingGoalTitles();
      const suggestions = await this.goalNegotiator.suggestGoals(workspaceContext, {
        maxSuggestions: 1,
        existingGoals: existingTitles,
        repoPath: workspaceDir,
      });
      const suggestion = suggestions[0];
      const suggestionTitle = suggestion?.title ?? hintedTitle;
      const negotiationDescription = suggestion?.description ?? hintedDescription;

      if (!negotiationDescription) {
        await this.persistResidentActivity({
          kind: "suggestion",
          trigger: "proactive_tick",
          summary: "Resident discovery ran but found no actionable goal to negotiate.",
          suggestion_title: suggestionTitle || undefined,
        });
        return;
      }

      const { goal } = await this.goalNegotiator.negotiate(negotiationDescription, {
        workspaceContext,
        timeoutMs: 30_000,
      });
      if (!this.currentGoalIds.includes(goal.id)) {
        this.currentGoalIds.push(goal.id);
      }
      this.refreshOperationalState();
      await this.persistResidentActivity({
        kind: "negotiation",
        trigger: "proactive_tick",
        summary: `Resident discovery negotiated a new goal: ${suggestionTitle || goal.title}`,
        suggestion_title: suggestionTitle || goal.title,
        goal_id: goal.id,
      });
      this.supervisor?.activateGoal(goal.id);
      this.abortSleep();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn("Resident discovery failed", { error: message });
      await this.persistResidentActivity({
        kind: "error",
        trigger: "proactive_tick",
        summary: `Resident discovery failed: ${message}`,
      });
    }
  }

  private async runResidentCuriosityCycle(options?: {
    activityTrigger?: ResidentActivity["trigger"];
    focus?: string;
    reviewLabel?: string;
    skipWhenNoTriggers?: boolean;
  }): Promise<boolean> {
    if (!this.curiosityEngine) {
      if (options?.skipWhenNoTriggers) {
        return false;
      }
      await this.persistResidentActivity({
        kind: "skipped",
        trigger: options?.activityTrigger ?? "proactive_tick",
        summary: "Resident investigation skipped because curiosity wiring is unavailable.",
      });
      return true;
    }

    try {
      const goals = await this.loadKnownGoals();
      const triggers = await this.curiosityEngine.evaluateTriggers(goals);
      const focus = options?.focus?.trim() ?? "";

      if (triggers.length === 0) {
        if (options?.skipWhenNoTriggers) {
          return false;
        }
        await this.persistResidentActivity({
          kind: "curiosity",
          trigger: options?.activityTrigger ?? "proactive_tick",
          summary: options?.reviewLabel
            ? `Resident ${options.reviewLabel} ran and found no curiosity triggers.`
            : `Resident investigation ran${focus ? ` for ${focus}` : ""} and found nothing actionable.`,
        });
        return true;
      }

      const proposals = await this.curiosityEngine.generateProposals(triggers, goals);
      if (proposals.length === 0) {
        await this.persistResidentActivity({
          kind: "curiosity",
          trigger: options?.activityTrigger ?? "proactive_tick",
          summary: options?.reviewLabel
            ? `Resident ${options.reviewLabel} ran but produced no curiosity proposals.`
            : `Resident investigation ran${focus ? ` for ${focus}` : ""} but produced no curiosity proposals.`,
        });
        return true;
      }

      const proposal = proposals[0]!;
      await this.persistResidentActivity({
        kind: "curiosity",
        trigger: options?.activityTrigger ?? "proactive_tick",
        summary: options?.reviewLabel
          ? `Resident ${options.reviewLabel} created ${proposals.length} curiosity proposal(s); next focus: ${proposal.proposed_goal.description}`
          : `Resident investigation created ${proposals.length} curiosity proposal(s); next focus: ${proposal.proposed_goal.description}`,
        suggestion_title: proposal.proposed_goal.description,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn("Resident investigation failed", { error: message });
      await this.persistResidentActivity({
        kind: "error",
        trigger: options?.activityTrigger ?? "proactive_tick",
        summary: `Resident investigation failed: ${message}`,
      });
      return true;
    }
  }

  private async triggerResidentInvestigation(details?: Record<string, unknown>): Promise<void> {
    const focus = typeof details?.["what"] === "string" ? details["what"].trim() : "";
    await this.runResidentCuriosityCycle({
      activityTrigger: "proactive_tick",
      focus,
      skipWhenNoTriggers: false,
    });
  }

  private async runScheduledGoalReview(): Promise<boolean> {
    if (!this.curiosityEngine || !this.config.proactive_mode) {
      return false;
    }
    const now = Date.now();
    if (now - this.lastGoalReviewAt < this.config.goal_review_interval_ms) {
      return false;
    }
    this.lastGoalReviewAt = now;
    return this.runResidentCuriosityCycle({
      activityTrigger: "schedule",
      reviewLabel: "goal review",
      skipWhenNoTriggers: false,
    });
  }

  private async tryApplyPendingDreamSuggestion(): Promise<{
    suggestion: { id: string; name?: string; reason?: string };
    entry: { id: string };
    duplicate: boolean;
  } | null> {
    const dreamStore = new DreamScheduleSuggestionStore(this.baseDir);
    const pendingSuggestion = (await dreamStore.list()).find((suggestion) => suggestion.status === "pending");
    if (!pendingSuggestion || !this.scheduleEngine) {
      return null;
    }

    return dreamStore.applySuggestion(pendingSuggestion.id, this.scheduleEngine);
  }

  private async runDreamAnalysis(tier: DreamTier): Promise<DreamRunReport> {
    const analyzer = new DreamAnalyzer({
      baseDir: this.baseDir,
      llmClient: this.llmClient,
      logger: this.logger,
    });
    return analyzer.run({ tier });
  }

  private async triggerResidentDreamMaintenance(details?: Record<string, unknown>, tier: DreamTier = "deep"): Promise<void> {
    try {
      const appliedBeforeAnalysis = await this.tryApplyPendingDreamSuggestion();
      if (appliedBeforeAnalysis) {
        await this.persistResidentActivity({
          kind: "dream",
          trigger: "proactive_tick",
          summary: appliedBeforeAnalysis.duplicate
            ? `Resident dream linked pending suggestion "${appliedBeforeAnalysis.suggestion.name ?? appliedBeforeAnalysis.suggestion.id}" to existing schedule ${appliedBeforeAnalysis.entry.id}.`
            : `Resident dream applied pending suggestion "${appliedBeforeAnalysis.suggestion.name ?? appliedBeforeAnalysis.suggestion.id}" into schedule ${appliedBeforeAnalysis.entry.id}.`,
          suggestion_title: appliedBeforeAnalysis.suggestion.name ?? appliedBeforeAnalysis.suggestion.reason,
        });
        return;
      }

      const analysisReport = await this.runDreamAnalysis(tier);
      const appliedAfterAnalysis = tier === "deep" ? await this.tryApplyPendingDreamSuggestion() : null;
      const consolidationReport = tier === "deep"
        ? await runDreamConsolidation({
          stateManager: this.stateManager,
          memoryLifecycle: this.memoryLifecycle,
          knowledgeManager: this.knowledgeManager,
          baseDir: this.baseDir,
        })
        : null;
      const requestedGoalId =
        typeof details?.["goal_id"] === "string" ? details["goal_id"].trim() : "";
      const goalHint = requestedGoalId ? ` for ${requestedGoalId}` : "";

      await this.persistResidentActivity({
        kind: "dream",
        trigger: "proactive_tick",
        summary: tier === "light"
          ? `Resident dream light analysis ran${goalHint}; processed ${analysisReport.goalsProcessed.length} goals, persisted ${analysisReport.patternsPersisted} patterns, and generated ${analysisReport.scheduleSuggestions} schedule suggestion(s).`
          : `Resident dream deep analysis ran${goalHint}; processed ${analysisReport.goalsProcessed.length} goals, persisted ${analysisReport.patternsPersisted} patterns, generated ${analysisReport.scheduleSuggestions} schedule suggestion(s), compressed ${consolidationReport?.entries_compressed ?? 0} entries, and created ${consolidationReport?.revalidation_tasks_created ?? 0} revalidation tasks${appliedAfterAnalysis ? ` while applying "${appliedAfterAnalysis.suggestion.name ?? appliedAfterAnalysis.suggestion.id}"` : ""}.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn("Resident dream maintenance failed", { error: message });
      await this.persistResidentActivity({
        kind: "error",
        trigger: "proactive_tick",
        summary: `Resident dream maintenance failed: ${message}`,
      });
    }
  }

  private async triggerResidentPreemptiveCheck(details?: Record<string, unknown>): Promise<void> {
    const goalId =
      typeof details?.["goal_id"] === "string" ? details["goal_id"].trim() : "";

    if (!goalId) {
      await this.persistResidentActivity({
        kind: "skipped",
        trigger: "proactive_tick",
        summary: "Resident preemptive check skipped because no goal_id was provided.",
      });
      return;
    }

    try {
      const goal = await this.stateManager.loadGoal(goalId).catch(() => null);
      if (!goal) {
        await this.persistResidentActivity({
          kind: "skipped",
          trigger: "proactive_tick",
          summary: `Resident preemptive check skipped because goal "${goalId}" was not found.`,
          goal_id: goalId,
        });
        return;
      }

      await this.driveSystem.writeEvent(
        PulSeedEventSchema.parse({
          type: "external",
          source: "resident-proactive",
          timestamp: new Date().toISOString(),
          data: {
            event_type: "preemptive_check",
            goal_id: goalId,
            requested_by: "resident-daemon",
          },
        }),
      );
      if (!this.currentGoalIds.includes(goalId)) {
        this.currentGoalIds.push(goalId);
      }
      this.refreshOperationalState();
      this.supervisor?.activateGoal(goalId);
      this.abortSleep();
      await this.persistResidentActivity({
        kind: "observation",
        trigger: "proactive_tick",
        summary: `Resident preemptive check queued an observation wake-up for goal "${goalId}".`,
        goal_id: goalId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn("Resident preemptive check failed", { error: message, goal_id: goalId });
      await this.persistResidentActivity({
        kind: "error",
        trigger: "proactive_tick",
        summary: `Resident preemptive check failed: ${message}`,
        goal_id: goalId || undefined,
      });
    }
  }

  private async triggerIdleResidentMaintenance(): Promise<void> {
    if (this.currentGoalIds.length > 0) {
      return;
    }

    const dreamSuggestionPath = path.join(this.baseDir, "dream", "schedule-suggestions.json");
    const hasDreamSuggestionFile = fs.existsSync(dreamSuggestionPath);
    if (!hasDreamSuggestionFile && !this.memoryLifecycle && !this.knowledgeManager && !this.llmClient) {
      return;
    }

    await this.triggerResidentDreamMaintenance(undefined, "light");
  }

  private async runSupervisorMaintenanceCycle(): Promise<void> {
    this.refreshOperationalState();
    await this.maybeRefreshProviderRuntime(
      (this.supervisor?.getState().workers ?? []).filter((worker) => worker.goalId !== null).length
    );
    await runSupervisorMaintenanceCycleForDaemon({
      currentGoalIds: this.currentGoalIds,
      driveSystem: this.driveSystem,
      supervisor: this.supervisor,
      processCronTasks: () => this.processCronTasks(),
      processScheduleEntries: () => this.processScheduleEntries(),
      proactiveTick: () => this.proactiveTick(),
      saveDaemonState: () => this.saveDaemonState(),
      eventServer: this.eventServer,
      state: this.state,
      runRuntimeStoreMaintenance: () => this.runRuntimeStoreMaintenance(),
    });
  }

  private async captureProviderRuntimeFingerprint(): Promise<string | null> {
    try {
      return await this.getProviderRuntimeFingerprintFn();
    } catch (error) {
      this.logger.warn("Failed to capture provider runtime fingerprint", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async maybeRefreshProviderRuntime(activeGoalCount: number): Promise<void> {
    if (!this.refreshResidentDeps || activeGoalCount > 0) {
      return;
    }

    const currentFingerprint = await this.captureProviderRuntimeFingerprint();
    if (!currentFingerprint || currentFingerprint === this.providerRuntimeFingerprint) {
      return;
    }

    try {
      const freshDeps = await this.refreshResidentDeps();
      this.coreLoop = freshDeps.coreLoop;
      this.curiosityEngine = freshDeps.curiosityEngine;
      this.goalNegotiator = freshDeps.goalNegotiator;
      this.llmClient = freshDeps.llmClient;
      this.reportingEngine = freshDeps.reportingEngine;
      this.scheduleEngine = freshDeps.scheduleEngine;
      this.memoryLifecycle = freshDeps.memoryLifecycle;
      this.knowledgeManager = freshDeps.knowledgeManager;
      this.supervisor?.replaceIdleWorkers(() => this.coreLoop);
      this.providerRuntimeFingerprint = currentFingerprint;
      this.logger.info("Refreshed resident daemon dependencies after provider drift", {
        fingerprint_changed: true,
      });
    } catch (error) {
      this.logger.warn("Failed to refresh resident daemon dependencies after provider drift", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleChatMessageCommand(goalId: string, message: string): Promise<void> {
    await writeChatMessageEvent(this.driveSystem, goalId, message);
    await this.broadcastChatResponse(goalId, message);
    this.abortSleep();
  }

  private async runCommandWithHealth<T>(commandName: string, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      await this.runtimeOwnership.observeCommandAcceptance("ok");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.runtimeOwnership.observeCommandAcceptance(
        "failed",
        `${commandName} failed: ${message}`,
      );
      throw error;
    }
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

  private async runRuntimeStoreMaintenance(force = false): Promise<void> {
    if (!this.runtimeRoot) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastRuntimeStoreMaintenanceAt < this.config.check_interval_ms) {
      return;
    }

    this.lastRuntimeStoreMaintenanceAt = now;
    await runRuntimeStoreMaintenanceCycle({
      runtimeRoot: this.runtimeRoot,
      approvalStore: this.approvalStore ?? undefined,
      outboxStore: this.outboxStore ?? undefined,
      runtimeHealthStore: this.runtimeHealthStore ?? undefined,
      logger: this.logger,
      now,
    });
  }

  // ─── Private: Proactive Tick ───

  /**
   * Ask the LLM for a proactive action when no goals were activated this cycle.
   * Fires only if proactive_mode is enabled and enough time has passed since last tick.
   * Errors are caught and logged — they never affect the daemon loop.
   */
  private async proactiveTick(): Promise<void> {
    if (!this.config.proactive_mode) {
      return;
    }

    if (await this.runScheduledGoalReview()) {
      return;
    }

    const curiosityTriggered = await this.runResidentCuriosityCycle({
      activityTrigger: "proactive_tick",
      skipWhenNoTriggers: true,
    });
    if (curiosityTriggered) {
      return;
    }

    const result = await runProactiveMaintenance({
      config: this.config,
      llmClient: this.llmClient,
      state: this.state,
      lastProactiveTickAt: this.lastProactiveTickAt,
      logger: this.logger,
    });
    this.lastProactiveTickAt = result.lastProactiveTickAt;
    if (!result.decision) {
      return;
    }

    if (result.decision.action === "sleep") {
      await this.persistResidentActivity({
        kind: "sleep",
        trigger: "proactive_tick",
        summary: "Resident proactive tick stayed idle.",
      });
      await this.triggerIdleResidentMaintenance();
      return;
    }

    if (result.decision.action === "suggest_goal") {
      await this.triggerResidentGoalDiscovery(result.decision.details);
      return;
    }

    if (result.decision.action === "investigate") {
      await this.triggerResidentInvestigation(result.decision.details);
      return;
    }

    if (result.decision.action === "preemptive_check") {
      await this.triggerResidentPreemptiveCheck(result.decision.details);
      return;
    }

    await this.persistResidentActivity({
      kind: "skipped",
      trigger: "proactive_tick",
      summary: `Resident proactive tick requested ${result.decision.action}, but no resident executor is wired for it yet.`,
    });
  }

  // ─── Private: Adaptive Sleep ───

  /**
   * Get the highest gap score across all active goals.
   * Falls back to 0 if no gap data is available.
   */
  private async getMaxGapScore(
    goalIds: string[],
    snapshot: GoalCycleScheduleSnapshotEntry[]
  ): Promise<number> {
    return getMaxGapScoreForGoals(this.driveSystem, goalIds, snapshot);
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
    await writeShutdownMarkerFile(this.baseDir, marker, this.logger);
  }

  /**
   * Read shutdown-state.json from baseDir.
   * Returns null if file doesn't exist or fails to parse.
   */
  async readShutdownMarker(): Promise<ShutdownMarker | null> {
    return readShutdownMarkerFile(this.baseDir);
  }

  /**
   * Delete shutdown-state.json (after successful resume).
   */
  async deleteShutdownMarker(): Promise<void> {
    await deleteShutdownMarkerFile(this.baseDir);
  }

  /**
   * Check for a previous shutdown marker and log recovery information.
   * Called at startup before the main loop begins.
   */
  private async checkCrashRecovery(): Promise<void> {
    await checkCrashRecoveryMarker(this.baseDir, this.logger);
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
