import type { CoreLoopDeps, ResolvedLoopConfig, LoopIterationResult } from "./core-loop/contracts.js";
import { makeEmptyIterationResult } from "./core-loop/contracts.js";
import type { Logger } from "../../runtime/logger.js";
import type { IterationBudget } from "./iteration-budget.js";
import type { NextIterationDirective } from "./loop-result-types.js";

export interface LoopSchedulerOptions {
  getPendingDirective?: (goalId: string) => NextIterationDirective | undefined;
}

function prioritizeGoalIdsWithDirectives(
  goalIds: string[],
  schedulerOptions?: LoopSchedulerOptions
): string[] {
  const getPendingDirective = schedulerOptions?.getPendingDirective;
  if (!getPendingDirective) return [...goalIds];

  const scored = goalIds.map((goalId, index) => {
    const directive = getPendingDirective(goalId);
    const priority = directive
      ? (directive.requestedPhase === "knowledge_refresh" ? 0 : 1)
      : 2;
    return { goalId, index, priority };
  });

  scored.sort((a, b) => a.priority - b.priority || a.index - b.index);
  return scored.map((entry) => entry.goalId);
}

async function collectDirectivePreferredTreeNodeIds(
  rootId: string,
  deps: CoreLoopDeps,
  schedulerOptions?: LoopSchedulerOptions
): Promise<string[]> {
  const getPendingDirective = schedulerOptions?.getPendingDirective;
  if (!getPendingDirective) return [];

  const root = await deps.stateManager.loadGoal(rootId);
  if (!root) return [];

  const collected: string[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const goal = currentId === rootId ? root : await deps.stateManager.loadGoal(currentId);
    if (!goal) continue;

    if (getPendingDirective(currentId)) {
      collected.push(currentId);
    }

    queue.push(...goal.children_ids);
  }

  return collected;
}

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
  nodeConsumedMap: Map<string, number>,
  schedulerOptions?: LoopSchedulerOptions
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
  console.log(`  [TREE] rootGoal loaded: ${!!rootGoalForDecomp}, children: ${rootGoalForDecomp?.children_ids.length ?? "N/A"}, hasTLO: ${!!deps.treeLoopOrchestrator}, hasRefiner: ${!!deps.goalRefiner}`);
  if (rootGoalForDecomp && rootGoalForDecomp.children_ids.length === 0) {
    const defaultConfig = { min_specificity: 0.7, max_depth: 3, parallel_loop_limit: 3, auto_prune_threshold: 0.3 };
    if (deps.treeLoopOrchestrator) {
      try {
        console.log("  [TREE] Calling ensureGoalRefined(force=true)...");
        await deps.treeLoopOrchestrator.ensureGoalRefined(rootId, { force: true });
        console.log("  [TREE] ensureGoalRefined complete. Starting tree execution...");
        await deps.treeLoopOrchestrator.startTreeExecution(rootId, defaultConfig);
        const rootAfterRefine = await deps.stateManager.loadGoal(rootId);
        decomposed = (rootAfterRefine?.children_ids.length ?? 0) > 0;
        console.log(`  [TREE] Refinement result: decomposed=${decomposed}, children=${rootAfterRefine?.children_ids.length ?? 0}`);
      } catch (err) {
        logger?.warn("CoreLoop: refinement failed, falling back to flat iteration", { rootId, err });
      }
    } else if (deps.goalTreeManager) {
      try {
        logger?.info("CoreLoop: auto-decomposing goal tree", { rootId });
        const decompResult = await deps.goalTreeManager.decomposeGoal(rootId, defaultConfig);
        logger?.info("CoreLoop: decomposition complete", { rootId, childCount: decompResult.children.length });
        await orchestrator.startTreeExecution(rootId, defaultConfig);
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
  let selectedNodeId: string | null;
  const preferredNodeIds = await collectDirectivePreferredTreeNodeIds(rootId, deps, schedulerOptions);
  if (preferredNodeIds.length > 0 && "selectPreferredNode" in orchestrator && typeof orchestrator.selectPreferredNode === "function") {
    const preferredSelection = await orchestrator.selectPreferredNode(rootId, preferredNodeIds);
    if (preferredSelection === undefined) {
      selectedNodeId = await orchestrator.selectNextNode(rootId);
    } else {
      selectedNodeId = preferredSelection;
    }
  } else {
    selectedNodeId = await orchestrator.selectNextNode(rootId);
  }

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
  runOneIteration: (goalId: string, loopIndex: number) => Promise<LoopIterationResult>,
  schedulerOptions?: LoopSchedulerOptions
): Promise<LoopIterationResult> {
  if (!config.multiGoalMode || !config.goalIds || config.goalIds.length === 0) {
    throw new Error(
      "runMultiGoalIteration requires config.multiGoalMode=true and config.goalIds to be non-empty"
    );
  }

  const goalIds = config.goalIds;
  const prioritizedGoalIds = prioritizeGoalIdsWithDirectives(goalIds, schedulerOptions);
  const directiveGoalIds = prioritizedGoalIds.filter((goalId) => schedulerOptions?.getPendingDirective?.(goalId));

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
    const selectedGoalId = directiveGoalIds[0] ?? prioritizedGoalIds[loopIndex % prioritizedGoalIds.length]!;
    return runOneIteration(selectedGoalId, loopIndex);
  }

  let selection: {
    goal_id: string;
    strategy_id: string | null;
    selection_reason: string;
  } | null = null;
  if (directiveGoalIds.length > 0) {
    selection = await deps.portfolioManager.selectNextStrategyAcrossGoals(
      directiveGoalIds,
      allocationMap
    );
  }

  if (selection === null) {
    selection = await deps.portfolioManager.selectNextStrategyAcrossGoals(
      prioritizedGoalIds,
      allocationMap
    );
  }

  if (selection === null) {
    // No strategies available — return a no-op result for the first goal
    const fallbackGoalId = prioritizedGoalIds[0]!;
    return runOneIteration(fallbackGoalId, loopIndex);
  }

  // Record that a task was dispatched for this goal
  deps.portfolioManager.recordGoalTaskDispatched(selection.goal_id);

  // Run normal iteration for the selected goal
  const result = await runOneIteration(selection.goal_id, loopIndex);

  return result;
}
