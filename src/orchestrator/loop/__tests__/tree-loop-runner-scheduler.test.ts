import { describe, it, expect, vi } from "vitest";
import { runMultiGoalIteration } from "../tree-loop-runner.js";
import type { CoreLoopDeps, ResolvedLoopConfig } from "../core-loop/contracts.js";
import type { LoopIterationResult } from "../loop-result-types.js";

function makeIterationResult(goalId: string, loopIndex = 0): LoopIterationResult {
  return {
    loopIndex,
    goalId,
    gapAggregate: 0,
    driveScores: [],
    taskResult: null,
    stallDetected: false,
    stallReport: null,
    pivotOccurred: false,
    completionJudgment: {
      is_complete: false,
      blocking_dimensions: [],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    },
    elapsedMs: 0,
    error: null,
  };
}

function makeConfig(goalIds: string[]): ResolvedLoopConfig {
  return {
    maxIterations: 10,
    maxConsecutiveErrors: 3,
    delayBetweenLoopsMs: 0,
    adapterType: "openai_codex_cli",
    treeMode: false,
    multiGoalMode: true,
    goalIds,
    minIterations: 1,
    autoArchive: false,
    dryRun: false,
    maxConsecutiveSkips: 5,
    autoDecompose: true,
    autoConsolidateOnComplete: true,
    consolidationRawThreshold: 20,
    iterationBudget: undefined,
  };
}

describe("tree-loop-runner scheduler options", () => {
  it("prioritizes directive goals when no portfolio manager is available", async () => {
    const runOneIteration = vi.fn(async (goalId: string, loopIndex: number) => makeIterationResult(goalId, loopIndex));

    const result = await runMultiGoalIteration(
      0,
      {} as CoreLoopDeps,
      makeConfig(["goal-1", "goal-2"]),
      runOneIteration,
      {
        getPendingDirective: (goalId) => goalId === "goal-2"
          ? {
              sourcePhase: "knowledge_refresh",
              reason: "refresh first",
              requestedPhase: "knowledge_refresh",
            }
          : undefined,
      }
    );

    expect(runOneIteration).toHaveBeenCalledWith("goal-2", 0);
    expect(result.goalId).toBe("goal-2");
  });

  it("queries directive goals first when portfolio manager is available", async () => {
    const portfolioManager = {
      selectNextStrategyAcrossGoals: vi.fn().mockResolvedValue({
        goal_id: "goal-2",
        strategy_id: "strategy-2",
        selection_reason: "preferred directive goal",
      }),
      recordGoalTaskDispatched: vi.fn(),
    };
    const runOneIteration = vi.fn(async (goalId: string, loopIndex: number) => makeIterationResult(goalId, loopIndex));

    const result = await runMultiGoalIteration(
      0,
      { portfolioManager } as unknown as CoreLoopDeps,
      makeConfig(["goal-1", "goal-2", "goal-3"]),
      runOneIteration,
      {
        getPendingDirective: (goalId) => goalId === "goal-2"
          ? {
              sourcePhase: "replanning_options",
              reason: "follow replanning",
              preferredAction: "continue",
              requestedPhase: "normal",
            }
          : undefined,
      }
    );

    expect(portfolioManager.selectNextStrategyAcrossGoals).toHaveBeenCalledTimes(1);
    expect(portfolioManager.selectNextStrategyAcrossGoals).toHaveBeenCalledWith(
      ["goal-2"],
      expect.any(Map)
    );
    expect(portfolioManager.recordGoalTaskDispatched).toHaveBeenCalledWith("goal-2");
    expect(runOneIteration).toHaveBeenCalledWith("goal-2", 0);
    expect(result.goalId).toBe("goal-2");
  });

  it("falls back to prioritized global selection when directive goals have no available strategy", async () => {
    const portfolioManager = {
      selectNextStrategyAcrossGoals: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          goal_id: "goal-1",
          strategy_id: "strategy-1",
          selection_reason: "fallback goal",
        }),
      recordGoalTaskDispatched: vi.fn(),
    };
    const runOneIteration = vi.fn(async (goalId: string, loopIndex: number) => makeIterationResult(goalId, loopIndex));

    const result = await runMultiGoalIteration(
      0,
      { portfolioManager } as unknown as CoreLoopDeps,
      makeConfig(["goal-1", "goal-2", "goal-3"]),
      runOneIteration,
      {
        getPendingDirective: (goalId) => goalId === "goal-2"
          ? {
              sourcePhase: "replanning_options",
              reason: "try this first",
              requestedPhase: "normal",
            }
          : undefined,
      }
    );

    expect(portfolioManager.selectNextStrategyAcrossGoals).toHaveBeenNthCalledWith(
      1,
      ["goal-2"],
      expect.any(Map)
    );
    expect(portfolioManager.selectNextStrategyAcrossGoals).toHaveBeenNthCalledWith(
      2,
      ["goal-2", "goal-1", "goal-3"],
      expect.any(Map)
    );
    expect(portfolioManager.recordGoalTaskDispatched).toHaveBeenCalledWith("goal-1");
    expect(runOneIteration).toHaveBeenCalledWith("goal-1", 0);
    expect(result.goalId).toBe("goal-1");
  });
});
