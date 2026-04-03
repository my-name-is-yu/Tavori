import { randomUUID } from "node:crypto";
import type { KnowledgeManager } from "../knowledge-manager.js";
import type { VectorIndex } from "../vector-index.js";
import type { LearningPipeline } from "../learning/learning-pipeline.js";
import type { StateManager } from "../../state/state-manager.js";
import { TransferCandidateSchema } from "../../types/cross-portfolio.js";
import type { TransferCandidate } from "../../types/cross-portfolio.js";
import type { LearnedPattern } from "../../types/learning.js";
import type { TransferTrustManager } from "./transfer-trust.js";
import type { PatternEffectivenessTracker } from "./knowledge-transfer-types.js";

// ─── Deps ───

export interface DetectDeps {
  stateManager: StateManager;
  learningPipeline: LearningPipeline;
  vectorIndex: VectorIndex | null;
  knowledgeManager: KnowledgeManager;
  transferTrust: TransferTrustManager;
}

// ─── detectTransferOpportunities ───

/**
 * Detect transfer opportunities for the given target goal.
 *
 * Steps:
 * 1. Cross-goal knowledge search via KnowledgeManager
 * 2. Load all learned patterns across goals
 * 3. Filter patterns whose source_goal_ids doesn't include the target
 * 4. Score each pattern: similarity × source_confidence × trust_score
 * 5. Filter: similarity >= 0.7, confidence >= 0.6
 * 6. Build TransferCandidate for each qualifying pattern
 * 7. Store and return ranked candidates
 */
export async function detectTransferOpportunities(
  goalId: string,
  deps: DetectDeps,
  candidates: Map<string, TransferCandidate>,
  patternTrackers: Map<string, PatternEffectivenessTracker>
): Promise<TransferCandidate[]> {
  const allGoalIds = await deps.stateManager.listGoalIds();
  const sourceGoalIds = allGoalIds.filter((id) => id !== goalId);

  // Collect all learned patterns from other goals
  const allPatterns: Array<{ pattern: LearnedPattern; sourceGoalId: string }> = [];
  for (const sourceGoalId of sourceGoalIds) {
    const patterns = await deps.learningPipeline.getPatterns(sourceGoalId);
    for (const pattern of patterns) {
      // Only include patterns that haven't already been sourced from the target
      if (!pattern.source_goal_ids.includes(goalId)) {
        allPatterns.push({ pattern, sourceGoalId });
      }
    }
  }

  if (allPatterns.length === 0) {
    return [];
  }

  // Check if VectorIndex has entries to use for semantic similarity
  const vectorIndexHasEntries =
    deps.vectorIndex !== null && deps.vectorIndex.size > 0;

  const scored: Array<{
    pattern: LearnedPattern;
    sourceGoalId: string;
    similarityScore: number;
    rankScore: number;
    domainTagMatch: boolean;
  }> = [];

  for (const { pattern, sourceGoalId } of allPatterns) {
    let similarityScore = 0.7; // default (no vector data available)

    if (
      vectorIndexHasEntries &&
      deps.vectorIndex !== null &&
      pattern.embedding_id !== null
    ) {
      try {
        const vi = deps.vectorIndex;
        const searchResults = await vi.search(pattern.description, 10, 0.0);
        const ownEntry = searchResults.find((r) => r.id === pattern.embedding_id);
        if (ownEntry) {
          const topMatches = searchResults.slice(0, 5);
          if (topMatches.length > 0) {
            const avgSimilarity =
              topMatches.reduce((sum, r) => sum + r.similarity, 0) /
              topMatches.length;
            similarityScore = avgSimilarity;
          }
        } else {
          const goalSearchResults = await vi.search(pattern.description, 5, 0.0);
          if (goalSearchResults.length > 0) {
            similarityScore = goalSearchResults[0]?.similarity ?? similarityScore;
          }
        }
      } catch {
        // non-fatal: keep default similarity
      }
    }

    // Filter by minimum thresholds
    if (similarityScore < 0.7 || pattern.confidence < 0.6) {
      continue;
    }

    // Check if pattern has been invalidated
    const tracker = patternTrackers.get(pattern.pattern_id);
    if (tracker?.invalidated) {
      continue;
    }

    // Build domain pair key from pattern's applicable_domains (sorted for consistency)
    const domainPair =
      pattern.applicable_domains.length > 0
        ? [...pattern.applicable_domains].sort().join("::")
        : `${sourceGoalId}::${goalId}`;

    // Get trust score for this domain pair
    let trustScore = 0.5;
    try {
      const trustRecord = await deps.transferTrust.getTrustScore(domainPair);
      trustScore = trustRecord.trust_score;
    } catch {
      // non-fatal: use default
    }

    // Check if this domain pair should be skipped due to invalidation
    try {
      const shouldSkip = await deps.transferTrust.shouldInvalidate(domainPair);
      if (shouldSkip) {
        continue;
      }
    } catch {
      // non-fatal: proceed
    }

    // domain_tag_match: true if pattern has at least one applicable domain
    const domainTagMatch = pattern.applicable_domains.length > 0;

    // Scoring: similarity * confidence * trust_score + domain_tag bonus
    const baseScore = similarityScore * pattern.confidence * trustScore;
    const rankScore = domainTagMatch ? Math.min(1.0, baseScore + 0.1) : baseScore;

    scored.push({ pattern, sourceGoalId, similarityScore, rankScore, domainTagMatch });
  }

  // Sort by rank score descending
  scored.sort((a, b) => b.rankScore - a.rankScore);

  const newCandidates: TransferCandidate[] = [];
  const seenPatternIds = new Set<string>();

  for (const {
    pattern,
    sourceGoalId,
    similarityScore,
    rankScore,
    domainTagMatch,
  } of scored) {
    // Deduplicate: same pattern from multiple source goals → keep highest-ranked
    if (seenPatternIds.has(pattern.pattern_id)) {
      continue;
    }
    seenPatternIds.add(pattern.pattern_id);
    const candidate = TransferCandidateSchema.parse({
      candidate_id: `tc_${randomUUID()}`,
      source_goal_id: sourceGoalId,
      target_goal_id: goalId,
      type: "pattern",
      source_item_id: pattern.pattern_id,
      similarity_score: similarityScore,
      estimated_benefit: `Pattern "${pattern.description.slice(0, 80)}" (confidence: ${pattern.confidence.toFixed(2)}, rank: ${rankScore.toFixed(3)})`,
      domain_tag_match: domainTagMatch,
    });

    candidates.set(candidate.candidate_id, candidate);
    newCandidates.push(candidate);
  }

  return newCandidates;
}
