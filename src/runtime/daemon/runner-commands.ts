import { resolveScheduleEntry } from "../schedule/entry-resolver.js";
import { RuntimeOperationStore, type RuntimeControlOperationKind } from "../store/index.js";
import type { Logger } from "../logger.js";
import type { EventServer } from "../event/server.js";
import type { ScheduleEngine } from "../schedule/engine.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { DaemonState } from "../../base/types/daemon.js";
import type { Envelope } from "../types/envelope.js";
import type { ApprovalBroker } from "../approval-broker.js";
import type { LoopSupervisor } from "../executor/index.js";
import type { JournalBackedQueue, JournalBackedQueueAcceptResult } from "../queue/journal-backed-queue.js";
import { writeChatMessageEvent } from "./maintenance.js";
import { runCommandWithHealth as runCommandWithHealthFn } from "./runner-errors.js";

export interface DaemonRunnerCommandContext {
  runtimeRoot?: string;
  logger: Logger;
  scheduleEngine?: ScheduleEngine;
  stateManager: StateManager;
  state: DaemonState;
  currentGoalIds: string[];
  supervisor?: LoopSupervisor;
  approvalBroker?: ApprovalBroker;
  eventServer?: EventServer;
  journalQueue?: JournalBackedQueue;
  saveDaemonState(): Promise<void>;
  refreshOperationalState(): void;
  abortSleep(): void;
  beginGracefulShutdown(): void;
  broadcastGoalUpdated(goalId: string, fallbackStatus?: string): Promise<void>;
  broadcastChatResponse(goalId: string, message: string): Promise<void>;
  runtimeOwnership: {
    observeTaskExecution(
      status: "ok" | "degraded" | "failed",
      reason?: string,
    ): Promise<void>;
    observeCommandAcceptance(
      status: "accepted" | "rejected" | "failed",
      reason?: string,
    ): Promise<void>;
  };
  driveSystem: {
    writeEvent(event: unknown): Promise<void>;
  };
}

export function acceptRuntimeEnvelope(
  context: Pick<DaemonRunnerCommandContext, "journalQueue" | "logger" | "runtimeRoot">,
  envelope: Envelope,
): boolean {
  if (!context.journalQueue) return true;

  const result: JournalBackedQueueAcceptResult = context.journalQueue.accept(envelope);
  if (result.accepted) {
    return true;
  }

  context.logger.info("Runtime journal skipped envelope", {
    id: envelope.id,
    name: envelope.name,
    type: envelope.type,
    duplicate: result.duplicate,
    runtime_root: context.runtimeRoot,
  });
  return false;
}

export async function handleInboundEnvelope(
  context: Pick<DaemonRunnerCommandContext, "journalQueue" | "logger" | "runtimeRoot">,
  envelope: Envelope,
): Promise<void> {
  if (!acceptRuntimeEnvelope(context, envelope)) {
    return;
  }
}

export async function handleGoalStartCommand(
  context: Pick<
    DaemonRunnerCommandContext,
    "currentGoalIds" | "refreshOperationalState" | "saveDaemonState" | "supervisor" | "abortSleep" | "broadcastGoalUpdated" | "state"
  >,
  goalId: string,
): Promise<void> {
  if (!context.currentGoalIds.includes(goalId)) {
    context.currentGoalIds.push(goalId);
  }
  context.refreshOperationalState();
  await context.saveDaemonState();
  context.supervisor?.activateGoal(goalId);
  context.abortSleep();
  await context.broadcastGoalUpdated(goalId, "active");
}

export async function handleGoalStopCommand(
  context: Pick<
    DaemonRunnerCommandContext,
    "currentGoalIds" | "refreshOperationalState" | "saveDaemonState" | "supervisor" | "abortSleep" | "broadcastGoalUpdated" | "state"
  >,
  goalId: string,
): Promise<void> {
  context.currentGoalIds.splice(0, context.currentGoalIds.length, ...context.currentGoalIds.filter((id) => id !== goalId));
  context.refreshOperationalState();
  if (context.state.interrupted_goals) {
    context.state.interrupted_goals = context.state.interrupted_goals.filter((id) => id !== goalId);
  }
  await context.saveDaemonState();
  context.supervisor?.deactivateGoal(goalId);
  context.abortSleep();
  await context.broadcastGoalUpdated(goalId, "stopped");
}

export async function handleRuntimeControlCommand(
  context: Pick<DaemonRunnerCommandContext, "runtimeRoot" | "logger" | "beginGracefulShutdown">,
  operationId: string,
  kind: RuntimeControlOperationKind,
): Promise<void> {
  const operationStore = new RuntimeOperationStore(context.runtimeRoot ?? undefined);
  const operation = await operationStore.load(operationId);
  if (!operation) {
    context.logger.warn("Runtime control operation not found", { operation_id: operationId, kind });
    return;
  }

  if (kind !== "restart_daemon" && kind !== "restart_gateway") {
    const now = new Date().toISOString();
    await operationStore.save({
      ...operation,
      state: "failed",
      updated_at: now,
      completed_at: now,
      result: {
        ok: false,
        message: `Runtime control operation ${kind} is not implemented yet.`,
      },
    });
    return;
  }

  const now = new Date().toISOString();
  await operationStore.save({
    ...operation,
    state: "restarting",
    started_at: operation.started_at ?? now,
    updated_at: now,
    result: {
      ok: true,
      message:
        kind === "restart_gateway"
          ? "gateway restart is being handled by a daemon restart because the gateway runs in-process."
          : "daemon restart was accepted by the runtime command dispatcher.",
    },
  });

  context.logger.info("Runtime control requested daemon restart", { operation_id: operationId, kind });
  setTimeout(() => {
    context.beginGracefulShutdown();
  }, 25).unref?.();
}

export async function handleScheduleRunNowCommand(
  context: Pick<DaemonRunnerCommandContext, "scheduleEngine" | "logger">,
  scheduleId: string,
  allowEscalation: boolean,
): Promise<void> {
  if (!context.scheduleEngine) {
    throw new Error("ScheduleEngine is not configured");
  }

  await context.scheduleEngine.loadEntries();
  const entry = resolveScheduleEntry(context.scheduleEngine.getEntries(), scheduleId);
  if (!entry) {
    throw new Error(`Schedule not found: ${scheduleId}`);
  }

  const run = await context.scheduleEngine.runEntryNow(entry.id, {
    allowEscalation,
    preserveEnabled: true,
  });
  if (!run) {
    throw new Error(`Schedule not found: ${scheduleId}`);
  }

  context.logger.info("Schedule run-now completed", {
    schedule_id: entry.id,
    schedule_name: entry.name,
    status: run.result.status,
    reason: run.reason,
    allow_escalation: allowEscalation,
  });
}

export async function handleGoalCompletion(
  context: Pick<
    DaemonRunnerCommandContext,
    "state" | "saveDaemonState" | "runtimeOwnership" | "eventServer" | "stateManager" | "broadcastGoalUpdated"
  > & { currentLoopIndex: number; setCurrentLoopIndex(index: number): void },
  goalId: string,
  result: { status: string; totalIterations: number },
): Promise<void> {
  context.state.loop_count++;
  context.setCurrentLoopIndex(context.state.loop_count);
  context.state.last_loop_at = new Date().toISOString();
  await context.saveDaemonState();
  await context.runtimeOwnership.observeTaskExecution(
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

  if (context.eventServer) {
    const goal = await context.stateManager.loadGoal(goalId).catch(() => null);
    void context.eventServer.broadcast?.("iteration_complete", {
      goalId,
      loopCount: context.state.loop_count,
      status: goal?.status ?? result.status,
      iterations: result.totalIterations,
    });
    void context.eventServer.broadcast?.("daemon_status", {
      status: context.state.status,
      activeGoals: context.state.active_goals,
      loopCount: context.state.loop_count,
      lastLoopAt: context.state.last_loop_at,
    });
  }
  await context.broadcastGoalUpdated(goalId, result.status);
}

export async function handleChatMessageCommand(
  context: Pick<DaemonRunnerCommandContext, "driveSystem" | "broadcastChatResponse" | "abortSleep">,
  goalId: string,
  message: string,
): Promise<void> {
  await writeChatMessageEvent(context.driveSystem as never, goalId, message);
  await context.broadcastChatResponse(goalId, message);
  context.abortSleep();
}

export async function runCommandWithHealth<T>(
  context: Pick<DaemonRunnerCommandContext, "runtimeOwnership">,
  commandName: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runCommandWithHealthFn(
    commandName,
    fn,
    (status, reason) => context.runtimeOwnership.observeCommandAcceptance(status as "accepted" | "rejected" | "failed", reason),
  );
}

export async function handleApprovalResponseCommand(
  context: Pick<DaemonRunnerCommandContext, "approvalBroker" | "eventServer">,
  goalId: string | undefined,
  requestId: string,
  approved: boolean,
): Promise<void> {
  if (context.approvalBroker) {
    await context.approvalBroker.resolveApproval(requestId, approved, "dispatcher");
    return;
  }
  if (goalId && context.eventServer) {
    await context.eventServer.resolveApproval(requestId, approved);
  }
}

export async function handleCronTaskDue(
  context: Pick<DaemonRunnerCommandContext, "logger"> & {
    cronScheduler?: {
      markFired(taskId: string): Promise<void>;
    };
  },
  taskId: string,
): Promise<void> {
  if (!context.cronScheduler) {
    return;
  }
  try {
    await context.cronScheduler.markFired(taskId);
    context.logger.info(`Cron task fired: ${taskId}`);
  } catch (err) {
    context.logger.warn(`Cron task ${taskId} failed`, {
      error: err instanceof Error ? err.message : String(err),
    });
    await context.cronScheduler.markFired(taskId);
  }
}
