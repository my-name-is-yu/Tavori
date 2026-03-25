import type { CoreLoopDeps, ResolvedLoopConfig, LoopIterationResult } from "./core-loop-types.js";
import { makeEmptyIterationResult } from "./core-loop-types.js";
import type { Logger } from "../runtime/logger.js";
import type { IterationBudget } from "./iteration-budget.js";

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
  config: ResolvedLoopConfig,
  logger: Logger | undefined,
  runOneIteration: (goalId: string, loopIndex: number) => Promise<LoopIterationResult>,
  nodeConsumedMap: Map<string, number>
): Promise<LoopIterationResult> {
  const orchestrator = deps.treeLoopOrchestrator!;

  // 0. Auto-decompose (or refine) if root has no children yet.
  // If root already has children (e.g. resumed session), reset all nodes to "idle"
  // so that stale "running" statuses from a prior run do not block node selection.
  const rootGoalForDecomp = await deps.stateManager.loadGoal(rootId);
  // On the first iteration, if root already has children (resumed session), reset all
  // nodes to "idle" so stale "running" statuses from a prior run do not block selection.
  if (rootGoalForDecomp && rootGoalForDecomp.children_ids.length > 0 && loopIndex === 0) {
    const defaultConfig = { min_specificity: 0.7, max_depth: 3, parallel_loop_limit: 3, auto_prune_threshold: 0.3 };
    await deps.treeLoopOrchestrator?.startTreeExecution(rootId, defaultConfig);
  }
  let decomposed = false;
  if (rootGoalForDecomp && rootGoalForDecomp.children_ids.length === 0) {
    const defaultConfig = { min_specificity: 0.7, max_depth: 3, parallel_loop_limit: 3, auto_prune_threshold: 0.3 };
    if (deps.goalRefiner) {
      try {
        logger?.info("CoreLoop: refining goal tree via GoalRefiner", { rootId });
        const refineResult = await deps.goalRefiner.refine(rootId);
        logger?.info("CoreLoop: refinement complete", { rootId, leaf: refineResult.leaf });
        await deps.treeLoopOrchestrator?.startTreeExecution(rootId, defaultConfig);
        decomposed = true;
      } catch (err) {
        logger?.warn("CoreLoop: refinement failed, falling back to flat iteration", { rootId, err });
      }
    } else if (deps.goalTreeManager) {
      try {
        logger?.info("CoreLoop: auto-decomposing goal tree", { rootId });
        const decompResult = await deps.goalTreeManager.decomposeGoal(rootId, defaultConfig);
        logger?.info("CoreLoop: decomposition complete", { rootId, childCount: decompResult.children.length });
        await deps.treeLoopOrchestrator?.startTreeExecution(rootId, defaultConfig);
        decomposed = true;
      } catch (err) {
        logger?.warn("CoreLoop: decomposition failed, falling back to flat iteration", { rootId, err });
      }
    }
  }

  // 0b. If goal still has no children after any decomposition attempt, fall back to
  // flat iteration — tree mode cannot proceed without subgoals.
  // We check this regardless of whether goalTreeManager was present, so that the
  // no-goalTreeManager path (where decomposition was skipped) is also covered.
  const rootGoalCheck = decomposed
    ? await deps.stateManager.loadGoal(rootId)
    : rootGoalForDecomp;
  if (rootGoalCheck && rootGoalCheck.children_ids.length === 0) {
    logger?.info("[TREE] Goal has no subgoals, falling back to flat iteration", { rootId });
    return runOneIteration(rootId, loopIndex);
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

    return makeEmptyIterationResult(rootId, loopIndex, { completionJudgment: isComplete });
  }

  // 3. Enforce per-node limit if a shared budget with per_node_limit is configured
  const budget = config.iterationBudget;
  if (budget && budget.perNodeLimit !== undefined) {
    const nodeCount = nodeConsumedMap.get(selectedNodeId) ?? 0;
    if (nodeCount >= budget.perNodeLimit) {
      logger?.info(
        `[TREE] Node "${selectedNodeId}" has reached per-node limit (${budget.perNodeLimit}), skipping`,
        { selectedNodeId, nodeCount }
      );
      // Return a no-op result so the loop can continue with the next node
      return makeEmptyIterationResult(rootId, loopIndex, {
        skipped: true,
        skipReason: "per_node_limit",
      });
    }
    nodeConsumedMap.set(selectedNodeId, nodeCount + 1);
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

  // 4. If the node's goal is now completed, call onNodeCompleted.
  // Otherwise reset loop_status to "idle" so the node remains eligible for
  // future iterations (the eligibility filter skips "running" nodes).
  if (result.completionJudgment.is_complete) {
    await orchestrator.onNodeCompleted(selectedNodeId);
  } else {
    const nodeGoal = await deps.stateManager.loadGoal(selectedNodeId);
    if (nodeGoal) {
      await deps.stateManager.saveGoal({
        ...nodeGoal,
        loop_status: "idle",
        updated_at: new Date().toISOString(),
      });
    }
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
  config: ResolvedLoopConfig,
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
