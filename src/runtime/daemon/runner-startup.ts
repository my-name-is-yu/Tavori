import * as path from "node:path";
import { EventServer } from "../event/server.js";
import { IngressGateway, HttpChannelAdapter } from "../gateway/index.js";
import type { LoopSupervisor } from "../executor/index.js";
import { PulSeedEventSchema } from "../../base/types/drive.js";
import { RuntimeOperationStore, type RuntimeControlOperationKind } from "../store/index.js";
import { ProcessShutdownCoordinator, startDaemonStatusHeartbeat, type ProcessSignalTarget } from "./runner-lifecycle.js";
import { handleCriticalDaemonError, handleDaemonLoopError } from "./runner-errors.js";
import type { Envelope } from "../types/envelope.js";
import type { LoopResult } from "../../orchestrator/loop/core-loop.js";
import type { CoreLoop } from "../../orchestrator/loop/core-loop.js";
import { CommandDispatcher } from "../command-dispatcher.js";
import { EventDispatcher } from "../event/dispatcher.js";

const RUNTIME_LEADER_LEASE_MS = 30_000;
const RUNTIME_LEADER_HEARTBEAT_MS = 10_000;

export type StartupRunnerContext = any;

export async function startDaemonRunner(
  context: StartupRunnerContext,
  goalIds: string[],
): Promise<void> {
  let startupReady = false;
  try {
    await context.initializeRuntimeFoundation();
    await context.acquireRuntimeLeadership();

    if (!context.eventServer) {
      const esPort = context.config.event_server_port ?? 41700;
      context.eventServer = new EventServer(context.driveSystem, {
        port: esPort,
        stateManager: context.stateManager,
        outboxStore: context.outboxStore ?? undefined,
      }, context.logger);
    }
    if (context.outboxStore) {
      context.eventServer.setOutboxStore?.(context.outboxStore);
    }
    context.eventServer.setActiveWorkersProvider?.(() => {
      const workers = context.supervisor?.getState().workers ?? [];
      return workers
        .filter((worker: any) => worker.goalId !== null)
        .map((worker: any) => ({
          worker_id: worker.workerId,
          goal_id: worker.goalId,
          started_at: worker.startedAt,
          iterations: worker.iterations,
        }));
    });
    if (context.approvalBroker) {
      context.approvalBroker.setBroadcast((eventType: string, data: unknown) => {
        void context.eventServer?.broadcast?.(eventType, data);
      });
      context.eventServer.setApprovalBroker?.(context.approvalBroker);
    }

    context.eventServer.setCommandEnvelopeHook?.(
      async (envelope: Envelope) => context.handleInboundEnvelope(envelope),
    );

    if (context.gateway) {
      const httpAdapter = new HttpChannelAdapter(context.eventServer);
      context.gateway.registerAdapter(httpAdapter);
      context.gateway.onEnvelope(async (envelope: Envelope) => context.handleInboundEnvelope(envelope));
      await context.gateway.start();
      context.logger.info("Gateway started with HTTP adapter", { port: context.eventServer.getPort() });
    } else {
      await context.eventServer.start();
      context.eventServer.startFileWatcher();
      context.logger.info("EventServer started", { port: context.eventServer.getPort() });
    }

    if (!context.approvalFn && context.eventServer) {
      const es = context.eventServer;
      context.approvalFn = async (task: Record<string, unknown>): Promise<boolean> => {
        const goalId = String(task["goal_id"] ?? "unknown");
        const description = String(task["description"] ?? "");
        const action = String(task["action"] ?? "");
        const taskId = String(task["id"] ?? "");

        if (context.reportingEngine) {
          try {
            await context.reportingEngine.generateNotification("approval_required", {
              goalId,
              message: description || action || taskId || "Task approval required",
              details: [`task_id: ${taskId || "(none)"}`, `action: ${action || "(none)"}`].join("\n"),
            });
          } catch (err) {
            context.logger.warn("Approval notification dispatch failed", {
              goalId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return es.requestApproval(goalId, {
          id: taskId,
          description,
          action,
        });
      };
    }

    context.stopStatusHeartbeat = startDaemonStatusHeartbeat({
      eventServer: context.eventServer,
      getSnapshot: () => ({
        status: context.state.status,
        activeGoals: context.state.active_goals,
        loopCount: context.state.loop_count,
        startedAt: context.state.started_at,
      }),
    });

    context.driveSystem.startWatcher((event: unknown) => context.onEventReceived(event));

    context.shuttingDown = false;
    const shutdownTimeout = context.config.crash_recovery.graceful_shutdown_timeout_ms ?? 30_000;
    context.shutdownCoordinator = new ProcessShutdownCoordinator({
      logger: context.logger,
      gracefulShutdownTimeoutMs: shutdownTimeout,
      onShutdown: () => context.beginGracefulShutdown(),
      onForceStop: () => {
        context.running = false;
      },
      signalTarget: context.deps.shutdownSignalTarget,
    });
    context.shutdownCoordinator.activate();

    const restoredGoalIds = await context.restoreState(goalIds);
    const reconciledGoalIds = await context.reconcileInterruptedExecutions();
    const mergedGoalIds = Array.from(new Set([...restoredGoalIds, ...reconciledGoalIds]));

    context.running = true;
    context.currentGoalIds = mergedGoalIds;
    context.currentLoopIndex = 0;
    context.state = {
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
    } as typeof context.state;
    (context as StartupRunnerContext & { providerRuntimeFingerprint: string | null }).providerRuntimeFingerprint =
      await context.captureProviderRuntimeFingerprint();
    await context.saveDaemonState();

    await context.writeShutdownMarker({
      goal_ids: mergedGoalIds,
      loop_index: 0,
      timestamp: new Date().toISOString(),
      reason: "startup",
      state: "running",
    });

    context.logger.info("Daemon started", {
      pid: process.pid,
      goals: mergedGoalIds,
      check_interval_ms: context.config.check_interval_ms,
    });

    const sweepResult = context.queueClaimSweeper?.sweep();
    if (sweepResult && (sweepResult.reclaimed > 0 || sweepResult.deadlettered > 0)) {
      context.logger.info("Recovered stale runtime claims on startup", {
        reclaimed: sweepResult.reclaimed,
        deadlettered: sweepResult.deadlettered,
        expiredClaimTokens: sweepResult.expiredClaimTokens,
      });
    }
    context.queueClaimSweeper?.start();

    if (!context.supervisor) {
      const factory = context.deps.coreLoopFactory ?? (() => context.coreLoop);
      context.supervisor = new (await import("../executor/index.js")).LoopSupervisor(
        {
          coreLoopFactory: factory,
          journalQueue: context.journalQueue!,
          goalLeaseManager: context.goalLeaseManager!,
          driveSystem: context.driveSystem,
          stateManager: context.stateManager,
          logger: context.logger,
          onGoalComplete: async (goalId, result) => context.handleGoalCompletion(goalId, result),
          onEscalation: (goalId, crashCount, lastError) => {
            context.logger.error(`Goal ${goalId} suspended after ${crashCount} crashes: ${lastError}`);
          },
        },
        {
          concurrency: context.config.max_concurrent_goals,
          iterationsPerCycle: context.config.iterations_per_cycle,
          stateFilePath: path.join(context.runtimeRoot!, "supervisor-state.json"),
        }
      );
    }
    if (!context.eventDispatcher) {
      context.eventDispatcher = new EventDispatcher({
        journalQueue: context.journalQueue!,
        logger: context.logger,
        onGoalActivate: async (goalId) => context.handleGoalStartCommand(goalId),
        onExternalEvent: async (event: unknown) => context.driveSystem.writeEvent(PulSeedEventSchema.parse(event)),
        onCronTaskDue: async (task) => context.handleCronTaskDue(task.id),
      });
    }
    if (!context.commandDispatcher) {
      context.commandDispatcher = new CommandDispatcher({
        journalQueue: context.journalQueue!,
        logger: context.logger,
        onGoalStart: async (goalId) =>
          context.runCommandWithHealth("goal_start", () => context.handleGoalStartCommand(goalId)),
        onGoalStop: async (goalId) =>
          context.runCommandWithHealth("goal_stop", () => context.handleGoalStopCommand(goalId)),
        onChatMessage: async (goalId, message) =>
          context.runCommandWithHealth("chat_message", () => context.handleChatMessageCommand(goalId, message)),
        onApprovalResponse: async (goalId, requestId, approved) =>
          context.runCommandWithHealth("approval_response", () =>
            context.handleApprovalResponseCommand(goalId, requestId, approved)),
        onRuntimeControl: async (operationId, kind) =>
          context.runCommandWithHealth("runtime_control", () => context.handleRuntimeControlCommand(operationId, kind)),
        onScheduleRunNow: async (scheduleId, allowEscalation) =>
          context.runCommandWithHealth("schedule_run_now", () =>
            context.handleScheduleRunNowCommand(scheduleId, allowEscalation)),
      });
    }

    await context.saveRuntimeHealthSnapshot(
      context.supervisor ? "execution_ownership_durable" : "foundation_only",
      {
        gateway: context.gateway || context.eventServer ? "ok" : "degraded",
        queue: "ok",
        leases: "ok",
        approval: "ok",
        outbox: "ok",
        supervisor: context.supervisor ? "ok" : "degraded",
      }
    );
    context.startStartupRuntimeStoreMaintenance();

    startupReady = true;
    let cleanupHandled = false;
    try {
      await context.eventDispatcher?.start();
      await context.commandDispatcher?.start();
      if (context.supervisor) {
        await context.supervisor.start(mergedGoalIds);
        const maintenanceIntervalMs = context.config.check_interval_ms;
        await context.runSupervisorMaintenanceCycle();
        await context.reconcileRuntimeControlOperationsAfterStartup();
        context.cronScheduleInterval = setInterval(async () => {
          if (context.shuttingDown) return;
          await context.runSupervisorMaintenanceCycle();
        }, maintenanceIntervalMs);

        await new Promise<void>((resolve) => {
          context.shutdownResolve = resolve;
          if (!context.running) resolve();
        });
      } else {
        await context.reconcileRuntimeControlOperationsAfterStartup();
        await context.runLoop();
        cleanupHandled = true;
      }
    } finally {
      context.queueClaimSweeper?.stop();
      context.shutdownCoordinator?.dispose();
      context.shutdownCoordinator = null;
      context.stopStatusHeartbeat?.();
      context.stopStatusHeartbeat = null;
      if (context.cronScheduleInterval !== null) {
        clearInterval(context.cronScheduleInterval);
        context.cronScheduleInterval = null;
      }
      await context.supervisor?.shutdown();
      await context.eventDispatcher?.shutdown();
      await context.commandDispatcher?.shutdown();
      context.driveSystem.stopWatcher();
      if (context.gateway) {
        await context.gateway.stop();
        context.logger.info("Gateway stopped");
      } else if (context.eventServer) {
        context.eventServer.stopFileWatcher();
        await context.eventServer.stop();
        context.logger.info("EventServer stopped");
      }
      if (!cleanupHandled) {
        await context.cleanup();
      }
    }
  } catch (err) {
    if (!startupReady) {
      try {
        await context.drainStartupRuntimeStoreMaintenance();
      } finally {
        await context.releaseStartupOwnership();
      }
    }
    throw err;
  }
}

export async function reconcileRuntimeControlOperationsAfterStartup(
  runtimeRoot: string | null,
  state: { status: string },
  logger: { info(message: string, meta?: Record<string, unknown>): void },
): Promise<void> {
  const operationStore = new RuntimeOperationStore(runtimeRoot ?? undefined);
  const pending = await operationStore.listPending();
  const now = new Date().toISOString();
  for (const operation of pending) {
    if (
      operation.state !== "restarting" ||
      (operation.kind !== "restart_daemon" && operation.kind !== "restart_gateway")
    ) {
      continue;
    }
    await operationStore.save({
      ...operation,
      state: "verified",
      updated_at: now,
      completed_at: now,
      result: {
        ok: true,
        message:
          operation.kind === "restart_gateway"
            ? "gateway restart verified after daemon startup."
            : "daemon restart verified after startup.",
        daemon_status: state.status,
      },
    });
    logger.info("Runtime control restart operation verified after startup", {
      operation_id: operation.operation_id,
      kind: operation.kind,
    });
  }
}

export function failRuntimeLeadership(
  context: Pick<
    StartupRunnerContext,
    "state" | "logger" | "running" | "shuttingDown" | "shutdownResolve" | "sleepAbortController" | "saveDaemonState"
  > & { currentGoalIds?: string[] },
  reason: string,
): void {
  if (context.state.status === "crashed") {
    return;
  }

  context.logger.error("Lost runtime leadership; stopping daemon", { error: reason });
  context.state.status = "crashed";
  context.state.last_error = reason;
  context.state.interrupted_goals = [...context.state.active_goals];
  context.running = false;
  context.shuttingDown = true;
  context.shutdownResolve?.();
  context.sleepAbortController?.abort();
  void context.saveDaemonState();
}

export function handleLoopError(
  context: Pick<StartupRunnerContext, "state" | "config" | "logger" | "runtimeOwnership"> & { running: boolean },
  goalId: string,
  err: unknown,
): boolean {
  const { shouldStop } = handleDaemonLoopError({
    goalId,
    error: err,
    state: context.state,
    maxRetries: context.config.crash_recovery.max_retries,
    logger: context.logger,
    observeTaskExecution: (status, reason) => context.runtimeOwnership.observeTaskExecution(status, reason),
  });
  if (shouldStop) {
    context.running = false;
  }
  return shouldStop;
}

export async function handleCriticalError(
  context: Pick<StartupRunnerContext, "state" | "logger" | "runtimeOwnership" | "saveDaemonState"> & { running: boolean },
  err: unknown,
): Promise<void> {
  await handleCriticalDaemonError({
    error: err,
    state: context.state,
    logger: context.logger,
    observeTaskExecution: (status, reason) => context.runtimeOwnership.observeTaskExecution(status, reason),
    saveDaemonState: () => context.saveDaemonState(),
  });
  context.running = false;
}

export function beginGracefulShutdown(
  context: Pick<
    StartupRunnerContext,
    "shuttingDown" | "logger" | "running" | "state" | "shutdownResolve" | "sleepAbortController"
  >,
): void {
  if (context.shuttingDown) {
    return;
  }

  context.shuttingDown = true;
  context.logger.info("Shutting down gracefully...");
  context.running = false;
  context.state.status = "stopping";
  context.state.interrupted_goals = [...context.state.active_goals];
  context.shutdownResolve?.();
  context.sleepAbortController?.abort();
}
