import * as path from "node:path";
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
import { resolveScheduleEntry } from "../schedule/entry-resolver.js";
import type { MemoryLifecycleManager } from "../../platform/knowledge/memory/memory-lifecycle.js";
import type { KnowledgeManager } from "../../platform/knowledge/knowledge-manager.js";
import { lintAgentMemory } from "../../platform/knowledge/knowledge-manager-lint.js";
import { DreamAnalyzer } from "../../platform/dream/dream-analyzer.js";
import { DreamConsolidator, type DreamLegacyConsolidationReport } from "../../platform/dream/dream-consolidator.js";
import { DreamScheduleSuggestionStore } from "../../platform/dream/dream-schedule-suggestions.js";
import { createRuntimeDreamSoilSyncService } from "../../platform/dream/dream-soil-sync.js";
import type { DreamReport, DreamRunReport, DreamTier } from "../../platform/dream/dream-types.js";
import { runDreamConsolidation } from "../../reflection/dream-consolidation.js";
import { generateCronEntry } from "./signals.js";
import { rotateDaemonLog, calculateAdaptiveInterval as calcAdaptiveInterval } from "./health.js";
import { IngressGateway } from "../gateway/index.js";
import type { Envelope } from "../types/envelope.js";
import { LoopSupervisor } from "../executor/index.js";
import {
  ApprovalStore,
  OutboxStore,
  RuntimeHealthStore,
  RuntimeOperationStore,
  createRuntimeStorePaths,
} from "../store/index.js";
import type { RuntimeControlOperationKind } from "../store/index.js";
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
  type ProcessSignalTarget,
  ProcessShutdownCoordinator,
} from "./runner-lifecycle.js";
import {
  runCommandWithHealth as runCommandWithHealthFn,
} from "./runner-errors.js";
import { reconcileInterruptedExecutions as reconcileInterruptedExecutionsFn } from "./runner-recovery.js";
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
  writeShutdownMarkerFile,
} from "./index.js";
import type { GoalCycleScheduleSnapshotEntry } from "./maintenance.js";
import {
  acceptRuntimeEnvelope as acceptRuntimeEnvelopeFn,
  handleApprovalResponseCommand as handleApprovalResponseCommandFn,
  handleChatMessageCommand as handleChatMessageCommandFn,
  handleCronTaskDue as handleCronTaskDueFn,
  handleGoalStartCommand as handleGoalStartCommandFn,
  handleGoalStopCommand as handleGoalStopCommandFn,
  handleInboundEnvelope as handleInboundEnvelopeFn,
  handleRuntimeControlCommand as handleRuntimeControlCommandFn,
  handleScheduleRunNowCommand as handleScheduleRunNowCommandFn,
} from "./runner-commands.js";
import { runDaemonGoalCycleLoop } from "./runner-goal-cycle.js";
import {
  beginGracefulShutdown as beginGracefulShutdownFn,
  failRuntimeLeadership as failRuntimeLeadershipFn,
  handleCriticalError as handleCriticalErrorFn,
  handleLoopError as handleLoopErrorFn,
  reconcileRuntimeControlOperationsAfterStartup as reconcileRuntimeControlOperationsAfterStartupFn,
  startDaemonRunner,
} from "./runner-startup.js";
import {
  gatherResidentWorkspaceContext,
  legacyReportFromPlatformDream as legacyReportFromPlatformDreamFn,
  loadExistingGoalTitles as loadExistingGoalTitlesFn,
  loadKnownGoals as loadKnownGoalsFn,
  persistResidentActivity as persistResidentActivityFn,
  proactiveTick as proactiveTickFn,
  resolveResidentWorkspaceDir,
  runDreamAnalysis as runDreamAnalysisFn,
  runPlatformDreamConsolidation as runPlatformDreamConsolidationFn,
  runResidentCuriosityCycle as runResidentCuriosityCycleFn,
  runScheduledGoalReview as runScheduledGoalReviewFn,
  triggerIdleResidentMaintenance as triggerIdleResidentMaintenanceFn,
  triggerResidentDreamMaintenance as triggerResidentDreamMaintenanceFn,
  triggerResidentGoalDiscovery as triggerResidentGoalDiscoveryFn,
  triggerResidentInvestigation as triggerResidentInvestigationFn,
  triggerResidentPreemptiveCheck as triggerResidentPreemptiveCheckFn,
  tryApplyPendingDreamSuggestion as tryApplyPendingDreamSuggestionFn,
} from "./runner-resident.js";
const RUNTIME_JOURNAL_MAX_ATTEMPTS = 1_000;
const RUNTIME_LEADER_LEASE_MS = 30_000;
const RUNTIME_LEADER_HEARTBEAT_MS = 10_000;

// Re-exports for callers that imported these from daemon-runner
export { generateCronEntry } from "./signals.js";
export { rotateDaemonLog, calculateAdaptiveInterval } from "./health.js";
export type { ShutdownMarker } from "./index.js";

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
  /** Optional signal target for tests that must not emit process-wide signals. */
  shutdownSignalTarget?: ProcessSignalTarget;
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
  private startupRuntimeStoreMaintenancePromise: Promise<void> | null = null;
  private startupRuntimeStoreMaintenanceError: unknown = null;
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
      maxAttempts: RUNTIME_JOURNAL_MAX_ATTEMPTS,
    });
    this.queueClaimSweeper = new QueueClaimSweeper({
      queue: this.journalQueue,
    });
    this.runtimeOwnership = new RuntimeOwnershipCoordinator({
      baseDir: this.baseDir,
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
    await this.rotateLog();
    await this.checkCrashRecovery();
    await startDaemonRunner(this as never, goalIds);
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
    failRuntimeLeadershipFn(this as never, reason);
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
    await runDaemonGoalCycleLoop(this as never);
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
    handleLoopErrorFn(this as never, goalId, err);
  }

  /**
   * Handle a critical daemon-level error (outer loop catch).
   * Marks state as crashed and stops the loop.
   */
  private async handleCriticalError(err: unknown): Promise<void> {
    await handleCriticalErrorFn(this as never, err);
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

  private async reconcileInterruptedExecutions(): Promise<string[]> {
    return reconcileInterruptedExecutionsFn({
      baseDir: this.baseDir,
      stateManager: this.stateManager,
      logger: this.logger,
    });
  }

  private async reconcileRuntimeControlOperationsAfterStartup(): Promise<void> {
    await reconcileRuntimeControlOperationsAfterStartupFn(this.runtimeRoot, this.state, this.logger);
  }

  // ─── Private: Cleanup ───

  /**
   * Perform cleanup after the loop exits and write the final runtime health snapshot.
   * Also writes "clean_shutdown" marker to enable crash-vs-clean detection on next startup.
   */
  private async cleanup(): Promise<void> {
    let startupMaintenanceError: unknown = null;
    try {
      await this.drainStartupRuntimeStoreMaintenance();
    } catch (err) {
      startupMaintenanceError = err;
    }

    await cleanupDaemonRun({
      baseDir: this.baseDir,
      state: this.state,
      currentGoalIds: this.currentGoalIds,
      currentLoopIndex: this.currentLoopIndex,
      runtimeOwnership: this.runtimeOwnership,
      logger: this.logger,
    });

    if (startupMaintenanceError) {
      throw startupMaintenanceError;
    }
  }

  private beginGracefulShutdown(): void {
    beginGracefulShutdownFn(this as never);
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
    return acceptRuntimeEnvelopeFn(this as never, envelope);
  }

  private async handleInboundEnvelope(envelope: Envelope): Promise<void> {
    await handleInboundEnvelopeFn(this as never, envelope);
  }

  private async handleGoalStartCommand(goalId: string): Promise<void> {
    await handleGoalStartCommandFn(this as never, goalId);
  }

  private async handleGoalStopCommand(goalId: string): Promise<void> {
    await handleGoalStopCommandFn(this as never, goalId);
  }

  private async handleRuntimeControlCommand(
    operationId: string,
    kind: RuntimeControlOperationKind
  ): Promise<void> {
    await handleRuntimeControlCommandFn(this as never, operationId, kind);
  }

  private async handleScheduleRunNowCommand(
    scheduleId: string,
    allowEscalation: boolean
  ): Promise<void> {
    await handleScheduleRunNowCommandFn(this as never, scheduleId, allowEscalation);
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
    return loadExistingGoalTitlesFn(this as never);
  }

  private async loadKnownGoals(): Promise<Goal[]> {
    return loadKnownGoalsFn(this as never);
  }

  private async persistResidentActivity(
    activity: Omit<ResidentActivity, "recorded_at"> & { recorded_at?: string }
  ): Promise<void> {
    await persistResidentActivityFn(this as never, activity);
  }

  private async triggerResidentGoalDiscovery(details?: Record<string, unknown>): Promise<void> {
    await triggerResidentGoalDiscoveryFn(this as never, details);
  }

  private async runResidentCuriosityCycle(options?: {
    activityTrigger?: ResidentActivity["trigger"];
    focus?: string;
    reviewLabel?: string;
    skipWhenNoTriggers?: boolean;
  }): Promise<boolean> {
    return runResidentCuriosityCycleFn(this as never, options);
  }

  private async triggerResidentInvestigation(details?: Record<string, unknown>): Promise<void> {
    await triggerResidentInvestigationFn(this as never, details);
  }

  private async runScheduledGoalReview(): Promise<boolean> {
    return runScheduledGoalReviewFn(
      this as never,
      this.lastGoalReviewAt,
      (value: number) => {
        this.lastGoalReviewAt = value;
      },
    );
  }

  private async tryApplyPendingDreamSuggestion(): Promise<{
    suggestion: { id: string; name?: string; reason?: string };
    entry: { id: string };
    duplicate: boolean;
  } | null> {
    return tryApplyPendingDreamSuggestionFn(this as never);
  }

  private async runDreamAnalysis(tier: DreamTier): Promise<DreamRunReport> {
    return runDreamAnalysisFn(this as never, tier);
  }

  private async runPlatformDreamConsolidation(tier: DreamTier): Promise<DreamReport | null> {
    return runPlatformDreamConsolidationFn(this as never, tier);
  }

  private legacyReportFromPlatformDream(report: DreamReport | null): DreamLegacyConsolidationReport | null {
    return legacyReportFromPlatformDreamFn(report);
  }

  private async triggerResidentDreamMaintenance(details?: Record<string, unknown>, tier: DreamTier = "deep"): Promise<void> {
    await triggerResidentDreamMaintenanceFn(this as never, details, tier);
  }

  private async triggerResidentPreemptiveCheck(details?: Record<string, unknown>): Promise<void> {
    await triggerResidentPreemptiveCheckFn(this as never, details);
  }

  private async triggerIdleResidentMaintenance(): Promise<void> {
    await triggerIdleResidentMaintenanceFn(this as never);
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
    await handleChatMessageCommandFn(this as never, goalId, message);
  }

  private async runCommandWithHealth<T>(commandName: string, fn: () => Promise<T>): Promise<T> {
    return runCommandWithHealthFn(
      commandName,
      fn,
      (status, reason) => this.runtimeOwnership.observeCommandAcceptance(status, reason),
    );
  }

  private async handleApprovalResponseCommand(
    goalId: string | undefined,
    requestId: string,
    approved: boolean
  ): Promise<void> {
    await handleApprovalResponseCommandFn(this as never, goalId, requestId, approved);
  }

  private async handleCronTaskDue(taskId: string): Promise<void> {
    await handleCronTaskDueFn(this as never, taskId);
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

  private startStartupRuntimeStoreMaintenance(): void {
    if (this.startupRuntimeStoreMaintenancePromise) {
      return;
    }

    this.startupRuntimeStoreMaintenanceError = null;
    this.startupRuntimeStoreMaintenancePromise = this.runRuntimeStoreMaintenance(true)
      .catch((err) => {
        this.startupRuntimeStoreMaintenanceError = err;
        this.logger.error("Startup runtime store maintenance failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private async drainStartupRuntimeStoreMaintenance(): Promise<void> {
    const maintenancePromise = this.startupRuntimeStoreMaintenancePromise;
    if (!maintenancePromise) {
      return;
    }

    await maintenancePromise;
    this.startupRuntimeStoreMaintenancePromise = null;
    const maintenanceError = this.startupRuntimeStoreMaintenanceError;
    this.startupRuntimeStoreMaintenanceError = null;
    if (maintenanceError) {
      throw maintenanceError;
    }
  }

  // ─── Private: Proactive Tick ───

  /**
   * Ask the LLM for a proactive action when no goals were activated this cycle.
   * Fires only if proactive_mode is enabled and enough time has passed since last tick.
   * Errors are caught and logged — they never affect the daemon loop.
   */
  private async proactiveTick(): Promise<void> {
    await proactiveTickFn(
      this as never,
      this.lastProactiveTickAt,
      (value: number) => {
        this.lastProactiveTickAt = value;
      },
      this.lastGoalReviewAt,
      (value: number) => {
        this.lastGoalReviewAt = value;
      },
    );
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
