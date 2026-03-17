import type { VectorIndex } from "../knowledge/vector-index.js";
import type { KnowledgeTransfer } from "../knowledge/knowledge-transfer.js";
import type { TransferCandidate } from "../types/cross-portfolio.js";
import type { Goal } from "../types/goal.js";

// ─── Deps for standalone functions ───

export interface TransferDetectionDeps {
  vectorIndex?: VectorIndex;
  knowledgeTransfer?: KnowledgeTransfer;
}

// ─── Phase 2: Embedding-based Detection ───

/**
 * Detect semantically similar dimensions across goals using VectorIndex.
 * Returns cross-goal transfers with similarity > 0.7.
 */
export async function detectSemanticTransfer(
  goalId: string,
  dimensions: string[],
  deps: TransferDetectionDeps
): Promise<Array<{ source_goal_id: string; dimension: string; similarity: number }>> {
  if (!deps.vectorIndex) return [];

  const transfers: Array<{ source_goal_id: string; dimension: string; similarity: number }> = [];

  for (const dim of dimensions) {
    const results = await deps.vectorIndex.search(dim, 5, 0.7);
    for (const result of results) {
      const sourceGoalId = result.metadata.goal_id as string;
      if (sourceGoalId && sourceGoalId !== goalId) {
        transfers.push({
          source_goal_id: sourceGoalId,
          dimension: dim,
          similarity: result.similarity,
        });
      }
    }
  }

  return transfers;
}

// ─── Stage 14F: KnowledgeTransfer Integration ───

/**
 * Detect cross-goal knowledge transfer opportunities for all active goals.
 * Requires knowledgeTransfer to be injected — returns [] otherwise.
 *
 * For each active goal, calls KnowledgeTransfer.detectTransferOpportunities()
 * and converts the resulting TransferCandidates into a flat list.
 * Results are suggestion-only (Phase 1); no transfers are applied automatically.
 */
export async function detectKnowledgeTransferOpportunities(
  goals: Goal[],
  deps: TransferDetectionDeps
): Promise<TransferCandidate[]> {
  if (!deps.knowledgeTransfer) return [];

  const activeGoals = goals.filter((g) => g.status === "active");
  const allCandidates: TransferCandidate[] = [];

  for (const goal of activeGoals) {
    try {
      const candidates = await deps.knowledgeTransfer.detectTransferOpportunities(goal.id);
      allCandidates.push(...candidates);
    } catch {
      // non-fatal: transfer detection failure should not block curiosity loop
    }
  }

  return allCandidates;
}
