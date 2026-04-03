import type { StateManager } from "../state/state-manager.js";
import type { GoalTreeManager } from "./goal-tree-manager.js";
import type { GoalRefiner } from "./goal-refiner.js";
import { hasValidatedDimensions } from "./goal-refiner.js";
import type { StateAggregator } from "./state-aggregator.js";
import type { SatisficingJudge } from "../drive/satisficing-judge.js";
import type { GoalDecompositionConfig } from "../types/goal-tree.js";
import type { Goal } from "../types/goal.js";
import { estimateDifficulty, curriculumSort } from "./subgoal-curriculum.js";

/**
 * TreeLoopOrchestrator manages the execution of independent loops across
 * all nodes in a goal tree.
 *
 * Responsibilities:
 *   - Selecting the next node to execute (leaf-first priority)
 *   - Enforcing parallel_loop_limit for concurrent execution
 *   - Tracking loop_status transitions (idle → running → idle/paused)
 *   - Triggering state aggregation on node completion
 *   - Detecting and cascading completion up the tree
 *
 * Design ref: docs/design/goal-tree.md §14C
 */
export class TreeLoopOrchestrator {
  /**
   * GoalDecompositionConfig used to control parallel execution limits.
   * Updated by startTreeExecution(); defaults applied until first call.
   */
  private config: GoalDecompositionConfig = {
    max_depth: 5,
    min_specificity: 0.7,
    auto_prune_threshold: 0.3,
    parallel_loop_limit: 3,
  };

  constructor(
    private readonly stateManager: StateManager,
    private readonly goalTreeManager: GoalTreeManager,
    private readonly stateAggregator: StateAggregator,
    private readonly satisficingJudge: SatisficingJudge,
    private readonly goalRefiner?: GoalRefiner
  ) {}

  // ─── Tree Execution Initialization ───

  /**
   * Initialize tree execution.
   * Saves the config and optionally resets all node loop_status to "idle".
   * The actual per-node loops are driven by CoreLoop calling selectNextNode()
   * in a tree-mode iteration.
   */
  async startTreeExecution(
    rootId: string,
    config: GoalDecompositionConfig
  ): Promise<void> {
    this.config = config;

    // Reset all nodes in the tree to loop_status: "idle" to ensure clean state
    const root = await this.stateManager.loadGoal(rootId);
    if (!root) return;

    const now = new Date().toISOString();
    const allIds = [rootId, ...await this._collectAllDescendantIds(rootId)];

    for (const id of allIds) {
      const goal = await this.stateManager.loadGoal(id);
      if (goal && goal.loop_status !== "idle") {
        await this.stateManager.saveGoal({
          ...goal,
          loop_status: "idle",
          updated_at: now,
        });
      }
    }
  }

  // ─── Node Selection ───

  /**
   * Ensure the goal at goalId has been refined (has validated leaves or children).
   * When GoalRefiner is available and the goal has no validated leaf dimensions
   * and no children, calls refiner.refine(goalId).
   * Falls back to GoalTreeManager.decomposeGoal() if refiner is absent.
   * No-op if the goal already has children or validated dimensions.
   */
  async ensureGoalRefined(goalId: string, options?: { force?: boolean }): Promise<void> {
    const goal = await this.stateManager.loadGoal(goalId);
    if (!goal) return;

    // Already has children — no refinement needed
    if (goal.children_ids.length > 0) return;

    // Already has validated dimensions — no refinement needed (skip check when forced)
    if (!options?.force && hasValidatedDimensions(goal)) return;

    const defaultDecompConfig: GoalDecompositionConfig = {
      max_depth: this.config.max_depth,
      min_specificity: this.config.min_specificity,
      auto_prune_threshold: this.config.auto_prune_threshold,
      parallel_loop_limit: this.config.parallel_loop_limit,
    };

    if (this.goalRefiner) {
      try {
        await this.goalRefiner.refine(goalId, options?.force ? { force: true } : undefined);
      } catch {
        // Non-fatal: fall back to raw decompose if refiner errors
        try {
          await this.goalTreeManager.decomposeGoal(goalId, defaultDecompConfig);
        } catch { /* ignore */ }
      }
    } else {
      try {
        await this.goalTreeManager.decomposeGoal(goalId, defaultDecompConfig);
      } catch { /* ignore */ }
    }
  }

  /**
   * Select the next node to execute from the tree rooted at rootId.
   *
   * Algorithm (MVP: leaf-first):
   *   1. Get tree state — if active_loops.length >= parallel_loop_limit, return null.
   *   2. Collect all goal IDs in the tree (root + descendants).
   *   3. Filter to active + idle nodes (not running, not paused).
   *   4. Prefer leaf nodes (node_type === "leaf") over non-leaf nodes.
   *   5. Return the first candidate's ID and set its loop_status to "running".
   *
   * Returns null when:
   *   - parallel_loop_limit is already reached
   *   - No eligible (active + idle) nodes remain
   */
  async selectNextNode(rootId: string): Promise<string | null> {
    // Step 1: Check parallel limit
    const treeState = await this.goalTreeManager.getTreeState(rootId);
    if (treeState.active_loops.length >= this.config.parallel_loop_limit) {
      return null;
    }

    // Step 2: Collect all IDs (root + all descendants)
    const allIds = [rootId, ...await this._collectAllDescendantIds(rootId)];
    const selectedId = await this._selectEligibleNodeId(allIds);

    if (selectedId === null) return null;

    // Mark selected node as running
    const selected = await this.stateManager.loadGoal(selectedId);
    if (selected) {
      await this.stateManager.saveGoal({
        ...selected,
        loop_status: "running",
        updated_at: new Date().toISOString(),
      });
    }

    return selectedId;
  }

  // ─── Node Loop Control ───

  /**
   * Pause the loop for a specific node.
   * Sets loop_status to "paused".
   * No-op if the goal is not found.
   */
  async pauseNodeLoop(goalId: string): Promise<void> {
    const goal = await this.stateManager.loadGoal(goalId);
    if (!goal) return;

    await this.stateManager.saveGoal({
      ...goal,
      loop_status: "paused",
      updated_at: new Date().toISOString(),
    });
  }

  /**
   * Resume the loop for a specific node.
   * Sets loop_status to "running".
   * No-op if the goal is not found.
   */
  async resumeNodeLoop(goalId: string): Promise<void> {
    const goal = await this.stateManager.loadGoal(goalId);
    if (!goal) return;

    await this.stateManager.saveGoal({
      ...goal,
      loop_status: "running",
      updated_at: new Date().toISOString(),
    });
  }

  // ─── Node Completion Callback ───

  /**
   * Called when a node's execution cycle completes.
   *
   * Actions:
   *   1. Reset loop_status to "idle" (release the execution slot).
   *   2. Aggregate state bottom-up to the root.
   *   3. Run completion cascade to auto-complete ancestor nodes whose
   *      children are all done.
   */
  async onNodeCompleted(goalId: string): Promise<void> {
    const now = new Date().toISOString();

    // Step 1: Reset loop_status to "idle"
    const goal = await this.stateManager.loadGoal(goalId);
    if (goal) {
      await this.stateManager.saveGoal({
        ...goal,
        loop_status: "idle",
        updated_at: now,
      });
    }

    // Step 2: Aggregate parent chain bottom-up
    let parentId = goal?.parent_id ?? null;
    while (parentId !== null) {
      try {
        await this.stateAggregator.aggregateChildStates(parentId);
      } catch {
        // Non-fatal: parent may be missing or have no children
        break;
      }
      const parent = await this.stateManager.loadGoal(parentId);
      parentId = parent?.parent_id ?? null;
    }

    // Step 3: Completion cascade
    await this._applyCompletionCascade(goalId, now);
  }

  // ─── Private Helpers ───

  /**
   * Collect all descendant IDs (not including rootId itself).
   */
  private async _collectAllDescendantIds(goalId: string): Promise<string[]> {
    const goal = await this.stateManager.loadGoal(goalId);
    if (!goal) return [];
    const result: string[] = [];
    for (const childId of goal.children_ids) {
      result.push(childId);
      result.push(...await this._collectAllDescendantIds(childId));
    }
    return result;
  }

  /**
   * Select the best eligible node from the tree, preferring active idle leaves
   * and deeper leaves before non-leaf nodes.
   */
  private async _selectEligibleNodeId(allIds: string[]): Promise<string | null> {
    const eligibleLeaves: Array<{ id: string; depth: number; difficulty: number }> = [];
    const eligibleNonLeaves: string[] = [];

    for (const id of allIds) {
      const goal = await this.stateManager.loadGoal(id);
      if (!goal) continue;
      if (goal.status !== "active") continue;
      if (goal.loop_status === "running" || goal.loop_status === "paused") continue;

      if (goal.node_type === "leaf") {
        eligibleLeaves.push({ id, depth: goal.decomposition_depth ?? 0, difficulty: estimateDifficulty(goal) });
      } else {
        eligibleNonLeaves.push(id);
      }
    }

    curriculumSort(eligibleLeaves);
    return eligibleLeaves[0]?.id ?? eligibleNonLeaves[0] ?? null;
  }

  /**
   * Apply completion cascade results by marking each ancestor as completed.
   */
  private async _applyCompletionCascade(goalId: string, now: string): Promise<void> {
    const cascadeIds = await this.stateAggregator.checkCompletionCascade(goalId);
    for (const ancestorId of cascadeIds) {
      const ancestor = await this.stateManager.loadGoal(ancestorId);
      if (ancestor && ancestor.status !== "completed") {
        await this.stateManager.saveGoal({
          ...ancestor,
          status: "completed",
          updated_at: now,
        });
      }
    }
  }
}
