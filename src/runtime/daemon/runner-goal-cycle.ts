import type { LoopResult } from "../../orchestrator/loop/core-loop.js";
import type { GoalCycleScheduleSnapshotEntry } from "./maintenance.js";

const MAX_IDLE_SLEEP_MS = 5_000;

export type GoalCycleRunnerContext = any;

export async function runDaemonGoalCycleLoop(context: GoalCycleRunnerContext): Promise<void> {
  while (context.running && !context.shuttingDown) {
    try {
      const goalIds = [...context.currentGoalIds];
      context.refreshOperationalState();
      const cycleSnapshot = await context.collectGoalCycleSnapshot(goalIds);
      const activeGoals = await context.determineActiveGoals(goalIds, cycleSnapshot);
      await context.maybeRefreshProviderRuntime(activeGoals.length);

      if (activeGoals.length === 0) {
        context.logger.info("No goals need activation this cycle", { checked: goalIds.length });
      }

      for (const goalId of activeGoals) {
        if (!context.running) break;

        context.logger.info(`Running loop for goal: ${goalId}`);

        try {
          const iterationsPerCycle = context.config.iterations_per_cycle ?? 1;
          const result: LoopResult = await context.coreLoop.run(goalId, { maxIterations: iterationsPerCycle });
          context.state.loop_count++;
          context.currentLoopIndex = context.state.loop_count;
          context.state.last_loop_at = new Date().toISOString();
          context.logger.info(`Loop completed for goal: ${goalId}`, {
            status: result.finalStatus,
            iterations: result.totalIterations,
          });
          if (context.eventServer) {
            const goal = await context.stateManager.loadGoal(goalId).catch(() => null);
            void context.eventServer.broadcast?.("iteration_complete", {
              goalId,
              loopCount: context.state.loop_count,
              status: goal?.status ?? "unknown",
            });
          }
          await context.broadcastGoalUpdated(goalId, result.finalStatus);
        } catch (err) {
          context.handleLoopError(goalId, err);
        }

        if (!context.running) break;
      }

      context.refreshOperationalState();
      await context.saveDaemonState();
      if (context.eventServer) {
        void context.eventServer.broadcast?.("daemon_status", {
          status: context.state.status,
          activeGoals: context.state.active_goals,
          loopCount: context.state.loop_count,
          lastLoopAt: context.state.last_loop_at,
        });
      }

      await context.processCronTasks();
      await context.processScheduleEntries();

      if (context.state.loop_count > 0 && context.state.loop_count % 100 === 0) {
        await context.expireCronTasks();
      }

      if (context.running) {
        await context.proactiveTick();
      }

      if (context.running) {
        await context.runRuntimeStoreMaintenance();
      }

      if (activeGoals.length > 0) {
        context.consecutiveIdleCycles = 0;
      } else {
        context.consecutiveIdleCycles++;
      }

      if (context.running) {
        const baseIntervalMs = context.getNextInterval(goalIds);
        const maxGapScore = await context.getMaxGapScore(goalIds, cycleSnapshot);
        const intervalMs = context.calculateAdaptiveInterval(
          baseIntervalMs,
          activeGoals.length,
          maxGapScore,
          context.consecutiveIdleCycles,
        );
        const sleepIntervalMs =
          activeGoals.length === 0 ? Math.min(intervalMs, MAX_IDLE_SLEEP_MS) : intervalMs;
        context.logger.info(`Sleeping for ${sleepIntervalMs}ms until next check`);
        await context.sleep(sleepIntervalMs);
      }
    } catch (err) {
      await context.handleCriticalError(err);
    }
  }

  await context.cleanup();
}
