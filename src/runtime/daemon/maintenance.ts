import { z } from "zod";
import { getInternalIdentityPrefix } from "../../base/config/identity-loader.js";
import { PulSeedEventSchema } from "../../base/types/drive.js";
import type { DaemonConfig, DaemonState } from "../../base/types/daemon.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { DriveSystem } from "../../platform/drive/drive-system.js";
import { createEnvelope } from "../types/envelope.js";
import type { Envelope } from "../types/envelope.js";
import type { CronScheduler } from "../cron-scheduler.js";
import type { ScheduleEngine } from "../schedule/engine.js";
import type { Logger } from "../logger.js";

const ProactiveResponseSchema = z.object({
  action: z.enum(["suggest_goal", "investigate", "preemptive_check", "sleep"]),
  details: z.record(z.string(), z.unknown()).optional(),
});

export async function determineActiveGoalsForCycle(
  driveSystem: DriveSystem,
  goalIds: string[],
): Promise<string[]> {
  const eligibleIds: string[] = [];
  const scores = new Map<string, number>();

  for (const goalId of goalIds) {
    if (await driveSystem.shouldActivate(goalId)) {
      eligibleIds.push(goalId);
      const schedule = await driveSystem.getSchedule(goalId);
      const nextCheckAt = schedule ? new Date(schedule.next_check_at).getTime() : 0;
      scores.set(goalId, -nextCheckAt);
    }
  }

  return driveSystem.prioritizeGoals(eligibleIds, scores);
}

export function getNextIntervalForGoals(config: DaemonConfig, goalIds: string[]): number {
  const goalIntervals = config.goal_intervals;
  if (!goalIntervals || goalIds.length === 0) {
    return config.check_interval_ms;
  }

  let minInterval = config.check_interval_ms;
  for (const goalId of goalIds) {
    const override = goalIntervals[goalId];
    if (override !== undefined && override < minInterval) {
      minInterval = override;
    }
  }
  return minInterval;
}

export async function processCronTasksForDaemon(params: {
  cronScheduler?: CronScheduler;
  logger: Logger;
  acceptRuntimeEnvelope: (envelope: Envelope) => boolean;
}): Promise<void> {
  const { cronScheduler, logger, acceptRuntimeEnvelope } = params;
  if (!cronScheduler) {
    return;
  }

  try {
    const dueTasks = await cronScheduler.getDueTasks();
    for (const task of dueTasks) {
      logger.info(`Cron task due: ${task.id} (type=${task.type})`, {
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
      acceptRuntimeEnvelope(envelope);
    }
  } catch (err) {
    logger.warn("Failed to process cron tasks", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function processScheduleEntriesForDaemon(params: {
  scheduleEngine?: ScheduleEngine;
  logger: Logger;
  acceptRuntimeEnvelope: (envelope: Envelope) => boolean;
}): Promise<void> {
  const { scheduleEngine, logger, acceptRuntimeEnvelope } = params;
  if (!scheduleEngine) {
    return;
  }

  try {
    const results = await scheduleEngine.tick();
    for (const result of results) {
      if (result.status === "error") {
        logger.warn(`Schedule entry ${result.entry_id} failed: ${result.error_message}`);
        continue;
      }

      const goalId = (result as Record<string, unknown>)["goal_id"] as string | undefined;
      if (!goalId) {
        logger.warn("schedule_activated envelope missing goal_id", {
          entry_id: (result as Record<string, unknown>)["entry_id"],
        });
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
      acceptRuntimeEnvelope(envelope);
    }
  } catch (err) {
    logger.error("Failed to process schedule entries", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function expireOldCronTasks(
  cronScheduler: CronScheduler | undefined,
  logger: Logger,
): Promise<void> {
  if (!cronScheduler) {
    return;
  }

  try {
    await cronScheduler.expireOldTasks();
    logger.debug("Expired old cron tasks");
  } catch (err) {
    logger.warn("Failed to expire cron tasks", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function runProactiveMaintenance(params: {
  config: DaemonConfig;
  llmClient?: ILLMClient;
  state: DaemonState;
  lastProactiveTickAt: number;
  logger: Logger;
}): Promise<number> {
  const { config, llmClient, state, lastProactiveTickAt, logger } = params;
  if (!config.proactive_mode || !llmClient) {
    return lastProactiveTickAt;
  }
  if (Date.now() - lastProactiveTickAt < config.proactive_interval_ms) {
    return lastProactiveTickAt;
  }

  try {
    const goalSummaries = state.active_goals.length > 0
      ? state.active_goals.map((id) => `- ${id}`).join("\n")
      : "(no active goals)";

    const prompt = `${getInternalIdentityPrefix("proactive engine")} Given the current state of all goals:\n${goalSummaries}\n\nDecide what action to take:\n- "suggest_goal": A new goal should be created (provide title + description)\n- "investigate": Something needs investigation (provide what and why)\n- "preemptive_check": Run a pre-emptive observation (provide goal_id)\n- "sleep": Nothing needs attention right now\n\nRespond with JSON: { "action": "...", "details": { ... } }`;

    const response = await llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      { model_tier: "light" },
    );
    const parsed = ProactiveResponseSchema.safeParse(
      llmClient.parseJSON(response.content, ProactiveResponseSchema),
    );

    if (!parsed.success) {
      logger.warn("Proactive tick: failed to parse LLM response", {
        raw: response.content,
        error: parsed.error.message,
      });
      return Date.now();
    }

    const { action, details } = parsed.data;
    if (action === "sleep") {
      logger.debug("Proactive tick: LLM decided to sleep");
    } else {
      logger.info(`Proactive tick: action=${action}`, { details });
    }
  } catch (err) {
    logger.warn("Proactive tick: LLM error (ignored)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return Date.now();
}

export async function getMaxGapScoreForGoals(
  driveSystem: DriveSystem,
  goalIds: string[],
): Promise<number> {
  let max = 0;
  for (const goalId of goalIds) {
    try {
      const schedule = await driveSystem.getSchedule(goalId);
      const score = (schedule as Record<string, unknown>)["last_gap_score"];
      if (typeof score === "number" && score > max) {
        max = score;
      }
    } catch {
      // Non-fatal — just use 0 for this goal
    }
  }
  return max;
}

function getPersistedDaemonStateSnapshot(state: DaemonState): string {
  return JSON.stringify({
    status: state.status,
    active_goals: [...state.active_goals],
    loop_count: state.loop_count,
    last_loop_at: state.last_loop_at,
    interrupted_goals: state.interrupted_goals ? [...state.interrupted_goals] : undefined,
  });
}

export async function runSupervisorMaintenanceCycleForDaemon(params: {
  currentGoalIds: string[];
  driveSystem: DriveSystem;
  supervisor: { activateGoal(goalId: string): void } | null;
  processCronTasks: () => Promise<void>;
  processScheduleEntries: () => Promise<void>;
  proactiveTick: () => Promise<void>;
  saveDaemonState: () => Promise<void>;
  eventServer?: { broadcast?(event: string, payload: Record<string, unknown>): void | Promise<void> };
  state: DaemonState;
}): Promise<void> {
  const activeGoals = await determineActiveGoalsForCycle(
    params.driveSystem,
    [...params.currentGoalIds],
  );
  const stateBeforeMaintenance = getPersistedDaemonStateSnapshot(params.state);
  for (const goalId of activeGoals) {
    params.supervisor?.activateGoal(goalId);
  }

  await params.processCronTasks();
  await params.processScheduleEntries();
  await params.proactiveTick();
  if (getPersistedDaemonStateSnapshot(params.state) !== stateBeforeMaintenance) {
    await params.saveDaemonState();
  }

  if (params.eventServer) {
    void params.eventServer.broadcast?.("daemon_status", {
      status: params.state.status,
      activeGoals: params.state.active_goals,
      loopCount: params.state.loop_count,
      lastLoopAt: params.state.last_loop_at,
    });
  }
}

export async function writeChatMessageEvent(
  driveSystem: DriveSystem,
  goalId: string,
  message: string,
): Promise<void> {
  await driveSystem.writeEvent(
    PulSeedEventSchema.parse({
      type: "internal",
      source: "command-dispatcher",
      timestamp: new Date().toISOString(),
      data: {
        goal_id: goalId,
        kind: "chat_message",
        message,
      },
    }),
  );
}
