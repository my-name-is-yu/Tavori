import { describe, expect, it, vi } from "vitest";
import type { DaemonState } from "../../../base/types/daemon.js";
import {
  handleCriticalDaemonError,
  handleDaemonLoopError,
  runCommandWithHealth,
} from "../runner-errors.js";

function makeState(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    pid: process.pid,
    started_at: new Date().toISOString(),
    last_loop_at: null,
    loop_count: 0,
    active_goals: ["goal-1"],
    status: "running",
    crash_count: 0,
    last_error: null,
    last_resident_at: null,
    resident_activity: null,
    ...overrides,
  };
}

describe("runner-errors", () => {
  it("records loop errors and stops when max retries is reached", () => {
    const state = makeState({ crash_count: 2 });
    const observeTaskExecution = vi.fn().mockResolvedValue(undefined);
    const logger = { error: vi.fn() };

    const result = handleDaemonLoopError({
      goalId: "goal-1",
      error: new Error("loop failed"),
      state,
      maxRetries: 3,
      logger,
      observeTaskExecution,
    });

    expect(result.shouldStop).toBe(true);
    expect(state.last_error).toBe("loop failed");
    expect(state.crash_count).toBe(3);
    expect(observeTaskExecution).toHaveBeenCalledWith(
      "failed",
      "loop error for goal-1: loop failed",
    );
  });

  it("marks daemon state crashed for critical errors and persists it", async () => {
    const state = makeState({ active_goals: ["goal-a", "goal-b"] });
    const observeTaskExecution = vi.fn().mockResolvedValue(undefined);
    const saveDaemonState = vi.fn().mockResolvedValue(undefined);
    const logger = { error: vi.fn() };

    await handleCriticalDaemonError({
      error: "disk full",
      state,
      logger,
      observeTaskExecution,
      saveDaemonState,
    });

    expect(state.status).toBe("crashed");
    expect(state.last_error).toBe("disk full");
    expect(state.interrupted_goals).toEqual(["goal-a", "goal-b"]);
    expect(observeTaskExecution).toHaveBeenCalledWith(
      "failed",
      "critical daemon error: disk full",
    );
    expect(saveDaemonState).toHaveBeenCalledOnce();
  });

  it("records command health and rethrows failed command errors", async () => {
    const observeCommandAcceptance = vi.fn().mockResolvedValue(undefined);
    const commandError = new Error("command rejected");

    await expect(
      runCommandWithHealth(
        "goal_start",
        async () => {
          throw commandError;
        },
        observeCommandAcceptance,
      )
    ).rejects.toThrow(commandError);

    expect(observeCommandAcceptance).toHaveBeenCalledWith(
      "failed",
      "goal_start failed: command rejected",
    );
  });
});
