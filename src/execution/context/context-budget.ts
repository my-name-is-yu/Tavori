import type { TierBudget } from "../../types/memory-lifecycle.js";

// ─── Tier Budget Allocation ───

/**
 * Distributes a total token budget across memory tiers.
 * - core: 50% (always included items)
 * - recall: 35% (recent observations, strategy history)
 * - archival: remaining (completed-goal knowledge)
 */
export function allocateTierBudget(totalTokens: number): TierBudget {
  const core = Math.floor(totalTokens * 0.50);
  const recall = Math.floor(totalTokens * 0.35);
  const archival = totalTokens - core - recall;
  return { core, recall, archival };
}

// ─── Budget Allocation ───

export interface BudgetAllocation {
  goalDefinition: number;
  observations: number;
  knowledge: number;
  transferKnowledge: number;
  meta: number;
}

export function allocateBudget(totalBudget: number): BudgetAllocation {
  return {
    goalDefinition: Math.floor(totalBudget * 0.20),
    observations: Math.floor(totalBudget * 0.30),
    knowledge: Math.floor(totalBudget * 0.30),
    transferKnowledge: Math.floor(totalBudget * 0.15),
    meta: Math.floor(totalBudget * 0.05),
  };
}

// ─── Token Estimation ───

/** Estimate token count. Heuristic: 1 token ≈ 4 characters. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Progressive Disclosure Selection ───

/**
 * Select candidates greedily by similarity (descending) until the budget is exhausted.
 * Assumes `candidates` is already sorted by similarity descending.
 */
export function selectWithinBudget<T extends { text: string; similarity: number }>(
  candidates: T[],
  budgetTokens: number
): T[] {
  const selected: T[] = [];
  let usedTokens = 0;
  for (const candidate of candidates) {
    const tokens = estimateTokens(candidate.text);
    if (usedTokens + tokens > budgetTokens) break;
    selected.push(candidate);
    usedTokens += tokens;
  }
  return selected;
}

// ─── Budget Trimming ───

/**
 * When total actual usage exceeds the budget, reduce allocations starting from
 * the lowest-priority categories.
 *
 * Priority order (highest first): observations, knowledge, goalDefinition,
 * transferKnowledge, meta.
 */
export function trimToBudget(
  allocation: BudgetAllocation,
  actualUsage: Record<keyof BudgetAllocation, number>,
  totalBudget: number
): BudgetAllocation {
  const trimOrder: (keyof BudgetAllocation)[] = [
    "meta",
    "transferKnowledge",
    "goalDefinition",
    "knowledge",
    "observations",
  ];
  const result = { ...allocation };
  let totalUsed = Object.values(actualUsage).reduce((a, b) => a + b, 0);

  for (const category of trimOrder) {
    if (totalUsed <= totalBudget) break;
    const excess = totalUsed - totalBudget;
    const reduction = Math.min(result[category], excess);
    result[category] -= reduction;
    totalUsed -= reduction;
  }
  return result;
}
