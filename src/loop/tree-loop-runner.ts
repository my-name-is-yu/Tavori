import type { CoreLoopDeps, LoopConfig, LoopIterationResult } from "./core-loop-types.js";
import type { Logger } from "../runtime/logger.js";

/**
 * Standalone function extracted from CoreLoop.runTreeIteration.
 *
 * Tree-mode iteration: select one node via TreeLoopOrchestrator, run a
 * normal observe→gap→score→task cycle on that node, then aggregate upward.
 */
export async function runTreeIteration(
  rootId: string,
  loopIndex: number,
  deps: CoreLoopDeps,
  config: Required<LoopConfig>,
  logger: Logger | undefined,
  runOneIteration: (goalId: string, loopIndex: number) => Promise<LoopIterationResult>
): Promise<LoopIterationResult> {
  const orchestrator = deps.treeLoopOrchestrator!;

  // 0. Auto-decompose if root has no children yet
  const rootGoalForDecomp = await deps.stateManager.loadGoal(rootId);
  if (rootGoalForDecomp && rootGoalForDecomp.children_ids.length === 0 && deps.goalTreeManager) {
    const defaultConfig = { min_specificity: 0.7, max_depth: 3, parallel_loop_limit: 3, auto_prune_threshold: 0.3 };
    try {
      logger?.info("CoreLoop: auto-decomposing goal tree", { rootId });
      const decompResult = await deps.goalTreeManager.decomposeGoal(rootId, defaultConfig);
      logger?.info("CoreLoop: decomposition complete", { rootId, childCount: decompResult.children.length });
      await deps.treeLoopOrchestrator?.startTreeExecution(rootId, defaultConfig);
    } catch (err) {
      logger?.warn("CoreLoop: decomposition failed, falling back to flat iteration", { rootId, err });
    }
  }

  // 1. Select next node to iterate
  const selectedNodeId = await orchestrator.selectNextNode(rootId);

  // 2. If null, all nodes are completed/paused — check root completion
  if (selectedNodeId === null) {
    const rootGoal = await deps.stateManager.loadGoal(rootId);
    const isComplete = rootGoal
      ? (rootGoal.children_ids.length > 0
          ? await deps.satisficingJudge.judgeTreeCompletion(rootId)
          : deps.satisficingJudge.isGoalComplete(rootGoal))
      : { is_complete: false, blocking_dimensions: [], low_confidence_dimensions: [], needs_verification_task: false, checked_at: new Date().toISOString() };

    return {
      loopIndex,
      goalId: rootId,
      gapAggregate: 0,
      driveScores: [],
      taskResult: null,
      stallDetected: false,
      stallReport: null,
      pivotOccurred: false,
      completionJudgment: isComplete,
      elapsedMs: 0,
      error: null,
    };
  }

  // 3. Run normal iteration on selected node
  const result = await runOneIteration(selectedNodeId, loopIndex);

  // 3b. After each iteration, propagate state upward through parent chain
  if (deps.stateAggregator) {
    const selectedGoal = await deps.stateManager.loadGoal(selectedNodeId);
    let parentId = selectedGoal?.parent_id ?? null;
    while (parentId !== null) {
      try {
        await deps.stateAggregator.aggregateChildStates(parentId);
      } catch { break; }
      const parent = await deps.stateManager.loadGoal(parentId);
      parentId = parent?.parent_id ?? null;
    }
  }

  // 4. If the node's goal is now completed, call onNodeCompleted
  if (result.completionJudgment.is_complete) {
    await orchestrator.onNodeCompleted(selectedNodeId);
  }

  return result;
}

/**
 * Standalone function extracted from CoreLoop.runMultiGoalIteration.
 *
 * Run one iteration of the multi-goal loop.
 *
 * Uses CrossGoalPortfolio (if available) to determine goal allocations,
 * then calls portfolioManager.selectNextStrategyAcrossGoals() to pick
 * which goal gets the next iteration. Falls back to equal allocation if
 * CrossGoalPortfolio is not injected.
 *
 * Requires config.multiGoalMode=true and config.goalIds to be set.
 * Throws if CrossGoalPortfolio is not injected and multiGoalMode is enabled.
 */
export async function runMultiGoalIteration(
  loopIndex: number,
  deps: CoreLoopDeps,
  config: Required<LoopConfig>,
  runOneIteration: (goalId: string, loopIndex: number) => Promise<LoopIterationResult>
): Promise<LoopIterationResult> {
  if (!config.multiGoalMode || !config.goalIds || config.goalIds.length === 0) {
    throw new Error(
      "runMultiGoalIteration requires config.multiGoalMode=true and config.goalIds to be non-empty"
    );
  }

  const goalIds = config.goalIds;

  // Build allocation map
  let allocationMap: Map<string, number>;

  if (deps.crossGoalPortfolio) {
    allocationMap = await deps.crossGoalPortfolio.getAllocationMap(goalIds);
  } else {
    // Fall back to equal allocation when CrossGoalPortfolio is not provided
    const equalShare = 1.0 / goalIds.length;
    allocationMap = new Map(goalIds.map((id) => [id, equalShare]));
  }

  // Select next goal + strategy using PortfolioManager
  if (!deps.portfolioManager) {
    // Without a portfolio manager, round-robin by loopIndex
    const selectedGoalId = goalIds[loopIndex % goalIds.length]!;
    return runOneIteration(selectedGoalId, loopIndex);
  }

  const selection = await deps.portfolioManager.selectNextStrategyAcrossGoals(
    goalIds,
    allocationMap
  );

  if (selection === null) {
    // No strategies available — return a no-op result for the first goal
    const fallbackGoalId = goalIds[0]!;
    return runOneIteration(fallbackGoalId, loopIndex);
  }

  // Record that a task was dispatched for this goal
  deps.portfolioManager.recordGoalTaskDispatched(selection.goal_id);

  // Run normal iteration for the selected goal
  const result = await runOneIteration(selection.goal_id, loopIndex);

  return result;
}
