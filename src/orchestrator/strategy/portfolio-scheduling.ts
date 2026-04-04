import type { GoalDependencyGraph } from "../goal/goal-dependency-graph.js";
import type {
  DependencySchedule,
  DependencyPhase,
} from "../../base/types/cross-portfolio.js";

// ─── Scheduling ───

/**
 * Build a phased dependency schedule for the given goals using the provided
 * GoalDependencyGraph instance.
 *
 * The schedule uses topological sort to group goals into phases where all
 * goals in a phase can run concurrently. Phase 0 contains goals with no
 * prerequisites; subsequent phases contain goals whose prerequisites are
 * all satisfied by earlier phases.
 *
 * The critical path is the longest chain of prerequisite edges through the
 * DAG (measured in number of nodes).
 *
 * @param goalIds — IDs of goals to schedule
 * @param graph — the GoalDependencyGraph instance to query
 * @returns DependencySchedule
 */
export function buildDependencySchedule(
  goalIds: string[],
  graph: GoalDependencyGraph
): DependencySchedule {
  if (goalIds.length === 0) {
    return { phases: [], criticalPath: [] };
  }

  const goalSet = new Set(goalIds);

  // Build adjacency: prereqMap[child] = Set of parents that must complete first
  const prereqMap = new Map<string, Set<string>>();
  for (const id of goalIds) {
    prereqMap.set(id, new Set());
  }

  for (const id of goalIds) {
    const blockers = graph.getBlockingGoals(id).filter((b) => goalSet.has(b));
    for (const blocker of blockers) {
      prereqMap.get(id)?.add(blocker);
    }
  }

  // Kahn's algorithm for topological sort into phases
  const phases: DependencyPhase[] = [];
  const completed = new Set<string>();
  const remaining = new Set(goalIds);

  let phaseIndex = 0;
  while (remaining.size > 0) {
    // Goals whose all prerequisites are completed
    const readyGoals: string[] = [];
    for (const id of remaining) {
      const prereqs = prereqMap.get(id)!;
      const allSatisfied = [...prereqs].every((p) => completed.has(p));
      if (allSatisfied) {
        readyGoals.push(id);
      }
    }

    if (readyGoals.length === 0) {
      // Cycle detected or unresolvable — put all remaining in one phase
      const cycleGoals = [...remaining];
      const blockedBy = cycleGoals.flatMap((id) =>
        [...(prereqMap.get(id) ?? [])].filter((p) => !completed.has(p))
      );
      phases.push({
        phase: phaseIndex,
        goalIds: cycleGoals,
        blockedBy: [...new Set(blockedBy)],
      });
      break;
    }

    // Collect the set of blockers for this phase's goals
    const phaseBlockedBy = readyGoals.flatMap((id) =>
      [...(prereqMap.get(id) ?? [])]
    );

    phases.push({
      phase: phaseIndex,
      goalIds: readyGoals,
      blockedBy: [...new Set(phaseBlockedBy)],
    });

    for (const id of readyGoals) {
      completed.add(id);
      remaining.delete(id);
    }

    phaseIndex++;
  }

  // Critical path: longest chain of prerequisite edges (BFS/DFS from each node)
  const criticalPath = computeCriticalPath(goalIds, prereqMap);

  return { phases, criticalPath };
}

/**
 * Compute the critical path (longest prerequisite chain) among the given goals.
 * Returns the sequence of goalIds on the critical path.
 */
export function computeCriticalPath(
  goalIds: string[],
  prereqMap: Map<string, Set<string>>
): string[] {
  // dp[id] = longest path length ending at id (in nodes)
  const dp = new Map<string, number>();
  const parent = new Map<string, string | null>();

  function longestFrom(id: string): number {
    const cached = dp.get(id);
    if (cached !== undefined) return cached;

    const prereqs = prereqMap.get(id) ?? new Set();
    if (prereqs.size === 0) {
      dp.set(id, 1);
      parent.set(id, null);
      return 1;
    }

    let best = 0;
    let bestParent: string | null = null;
    for (const p of prereqs) {
      const len = longestFrom(p);
      if (len > best) {
        best = len;
        bestParent = p;
      }
    }

    dp.set(id, best + 1);
    parent.set(id, bestParent);
    return best + 1;
  }

  // Compute for all goals
  for (const id of goalIds) {
    longestFrom(id);
  }

  // Find the goal with the highest dp value
  let maxLen = 0;
  let maxGoal = goalIds[0] ?? "";
  for (const id of goalIds) {
    const len = dp.get(id) ?? 0;
    if (len > maxLen) {
      maxLen = len;
      maxGoal = id;
    }
  }

  if (maxLen === 0) return [];

  // Reconstruct path by following parent pointers
  const path: string[] = [];
  let current: string | null = maxGoal;
  while (current !== null) {
    path.unshift(current);
    current = parent.get(current) ?? null;
  }

  return path;
}
