import type { DaemonConfig, DaemonState } from "../../base/types/daemon.js";
import type { RuntimeHealthCapabilityStatuses } from "../store/index.js";
import type { Logger } from "../logger.js";

type TaskExecutionStatus =
  Exclude<RuntimeHealthCapabilityStatuses["task_execution"], "failed"> | "failed";
type CommandAcceptanceStatus =
  Exclude<RuntimeHealthCapabilityStatuses["command_acceptance"], "failed"> | "failed";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface HandleLoopErrorParams {
  goalId: string;
  error: unknown;
  state: DaemonState;
  maxRetries: DaemonConfig["crash_recovery"]["max_retries"];
  logger: Pick<Logger, "error">;
  observeTaskExecution: (status: TaskExecutionStatus, reason?: string) => Promise<void>;
}

export function handleDaemonLoopError(params: HandleLoopErrorParams): { shouldStop: boolean } {
  const message = errorMessage(params.error);
  params.state.last_error = message;
  params.state.crash_count += 1;
  void params.observeTaskExecution(
    "failed",
    `loop error for ${params.goalId}: ${message}`,
  );
  params.logger.error(`Loop error for goal ${params.goalId}`, {
    error: message,
    crash_count: params.state.crash_count,
    max_retries: params.maxRetries,
  });

  const shouldStop = params.state.crash_count >= params.maxRetries;
  if (shouldStop) {
    params.logger.error(`Max crash retries (${params.maxRetries}) exceeded, stopping daemon`);
  }
  return { shouldStop };
}

export interface HandleCriticalErrorParams {
  error: unknown;
  state: DaemonState;
  logger: Pick<Logger, "error">;
  observeTaskExecution: (status: TaskExecutionStatus, reason?: string) => Promise<void>;
  saveDaemonState: () => Promise<void>;
}

export async function handleCriticalDaemonError(params: HandleCriticalErrorParams): Promise<void> {
  const message = errorMessage(params.error);
  params.logger.error("Critical daemon error", { error: message });
  await params.observeTaskExecution("failed", `critical daemon error: ${message}`);
  params.state.status = "crashed";
  params.state.last_error = message;
  params.state.interrupted_goals = [...params.state.active_goals];
  await params.saveDaemonState();
}

export async function runCommandWithHealth<T>(
  commandName: string,
  fn: () => Promise<T>,
  observeCommandAcceptance: (status: CommandAcceptanceStatus, reason?: string) => Promise<void>
): Promise<T> {
  try {
    const result = await fn();
    await observeCommandAcceptance("ok");
    return result;
  } catch (error) {
    const message = errorMessage(error);
    await observeCommandAcceptance("failed", `${commandName} failed: ${message}`);
    throw error;
  }
}
