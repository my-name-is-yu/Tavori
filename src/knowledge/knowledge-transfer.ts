import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ILLMClient } from "../llm/llm-client.js";
import { extractJSON } from "../llm/llm-client.js";
import type { KnowledgeManager } from "./knowledge-manager.js";
import type { VectorIndex } from "./vector-index.js";
import type { LearningPipeline } from "./learning-pipeline.js";
import type { EthicsGate } from "../traits/ethics-gate.js";
import type { StateManager } from "../state-manager.js";
import {
  TransferCandidateSchema,
  TransferResultSchema,
  TransferEffectivenessSchema,
} from "../types/cross-portfolio.js";
import type {
  TransferCandidate,
  TransferResult,
  TransferEffectivenessRecord,
  TransferEffectiveness,
} from "../types/cross-portfolio.js";
import type { LearnedPattern, CrossGoalPattern, StructuralFeedbackType } from "../types/learning.js";
import { CrossGoalPatternSchema } from "../types/learning.js";

// ─── LLM Response Schemas ───

const AdaptationResponseSchema = z.object({
  adaptation_description: z.string(),
  adapted_content: z.string(),
  success: z.boolean(),
});

const MetaPatternsResponseSchema = z.object({
  meta_patterns: z.array(
    z.object({
      description: z.string(),
      applicable_domains: z.array(z.string()),
      source_pattern_ids: z.array(z.string()),
    })
  ),
});

// ─── Internal Storage Types ───

interface TransferContext {
  candidate: TransferCandidate;
  /** gap score at apply time (lower is better) */
  gap_at_apply: number;
  source_pattern: LearnedPattern | null;
}

/** Track consecutive neutral/negative outcomes per source pattern */
interface PatternEffectivenessTracker {
  consecutive_non_positive: number;
  invalidated: boolean;
}

// ─── KnowledgeTransfer ───

/**
 * KnowledgeTransfer implements cross-goal knowledge and strategy transfer.
 *
 * Phase 1 (MVP): Transfer is always suggestion-only.
 * applyTransfer() exists but should only be called after explicit user approval.
 *
 * Stored in-memory (Map/array). No file persistence for MVP.
 */
export class KnowledgeTransfer {
  private readonly deps: {
    llmClient: ILLMClient;
    knowledgeManager: KnowledgeManager;
    vectorIndex: VectorIndex | null;
    learningPipeline: LearningPipeline;
    ethicsGate: EthicsGate;
    stateManager: StateManager;
  };

  /** In-memory candidate store: candidate_id → TransferCandidate */
  private readonly candidates: Map<string, TransferCandidate> = new Map();

  /** In-memory result store: transfer_id → TransferResult */
  private readonly results: Map<string, TransferResult> = new Map();

  /** Context stored at apply time: transfer_id → TransferContext */
  private readonly applyContexts: Map<string, TransferContext> = new Map();

  /** Effectiveness records: transfer_id → TransferEffectivenessRecord */
  private readonly effectivenessRecords: Map<
    string,
    TransferEffectivenessRecord
  > = new Map();

  /** Per-pattern consecutive non-positive outcome tracker */
  private readonly patternTrackers: Map<
    string,
    PatternEffectivenessTracker
  > = new Map();

  /** Cross-goal pattern store: pattern id → CrossGoalPattern */
  private readonly crossGoalPatterns: Map<string, CrossGoalPattern> = new Map();

  constructor(deps: {
    llmClient: ILLMClient;
    knowledgeManager: KnowledgeManager;
    vectorIndex: VectorIndex | null;
    learningPipeline: LearningPipeline;
    ethicsGate: EthicsGate;
    stateManager: StateManager;
  }) {
    this.deps = deps;
  }

  // ─── detectTransferOpportunities ───

  /**
   * Detect transfer opportunities for the given target goal.
   *
   * Steps:
   * 1. Cross-goal knowledge search via KnowledgeManager
   * 2. Load all learned patterns across goals
   * 3. Filter patterns whose source_goal_ids doesn't include the target
   * 4. Score each pattern: similarity × source_confidence × effectiveness
   * 5. Filter: similarity >= 0.7, confidence >= 0.6
   * 6. Build TransferCandidate for each qualifying pattern
   * 7. Store and return ranked candidates
   */
  async detectTransferOpportunities(
    goalId: string
  ): Promise<TransferCandidate[]> {
    const allGoalIds = await this.deps.stateManager.listGoalIds();
    const sourceGoalIds = allGoalIds.filter((id) => id !== goalId);

    // Collect all learned patterns from other goals
    const allPatterns: Array<{ pattern: LearnedPattern; sourceGoalId: string }> =
      [];
    for (const sourceGoalId of sourceGoalIds) {
      const patterns = await this.deps.learningPipeline.getPatterns(sourceGoalId);
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
    const vectorIndexHasEntries = this.deps.vectorIndex !== null && this.deps.vectorIndex.size > 0;

    const scored: Array<{
      pattern: LearnedPattern;
      sourceGoalId: string;
      similarityScore: number;
      rankScore: number;
    }> = [];

    for (const { pattern, sourceGoalId } of allPatterns) {
      let similarityScore = 0.7; // default (no vector data available)

      if (vectorIndexHasEntries && this.deps.vectorIndex !== null && pattern.embedding_id !== null) {
        try {
          const vi = this.deps.vectorIndex;
          // Search for the pattern description in the vector index
          const searchResults = await vi.search(
            pattern.description,
            10,
            0.0
          );
          // Find the entry for this pattern's embedding_id or the best match
          const ownEntry = searchResults.find(
            (r) => r.id === pattern.embedding_id
          );
          if (ownEntry) {
            // Use average similarity of top matches as proxy for goal context similarity
            const topMatches = searchResults.slice(0, 5);
            if (topMatches.length > 0) {
              const avgSimilarity =
                topMatches.reduce((sum, r) => sum + r.similarity, 0) /
                topMatches.length;
              similarityScore = avgSimilarity;
            }
          } else {
            // Fall back to direct search for goal-level similarity
            const goalSearchResults = await vi.search(
              pattern.description,
              5,
              0.0
            );
            if (goalSearchResults.length > 0) {
              similarityScore = goalSearchResults[0]!.similarity;
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
      const tracker = this.patternTrackers.get(pattern.pattern_id);
      if (tracker?.invalidated) {
        continue;
      }

      // effectiveness_score: use 0.5 as neutral default
      const effectivenessScore = 0.5;

      const rankScore =
        similarityScore * pattern.confidence * effectivenessScore;

      scored.push({ pattern, sourceGoalId, similarityScore, rankScore });
    }

    // Sort by rank score descending
    scored.sort((a, b) => b.rankScore - a.rankScore);

    const newCandidates: TransferCandidate[] = [];
    const seenPatternIds = new Set<string>();

    for (const { pattern, sourceGoalId, similarityScore, rankScore } of scored) {
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
      });

      this.candidates.set(candidate.candidate_id, candidate);
      newCandidates.push(candidate);
    }

    return newCandidates;
  }

  // ─── applyTransfer ───

  /**
   * Apply a transfer candidate to the target goal.
   *
   * Phase 1: Should only be called after explicit user approval.
   *
   * Steps:
   * 1. Look up candidate
   * 2. Ethics gate check
   * 3. LLM adaptation of source pattern to target context
   * 4. Record and return TransferResult
   */
  async applyTransfer(
    candidateId: string,
    targetGoalId: string
  ): Promise<TransferResult> {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) {
      const failResult = TransferResultSchema.parse({
        transfer_id: `tr_${randomUUID()}`,
        candidate_id: candidateId,
        applied_at: new Date().toISOString(),
        adaptation_description: "Candidate not found",
        success: false,
      });
      this.results.set(failResult.transfer_id, failResult);
      return failResult;
    }

    // Ethics gate check
    const ethicsDescription = `Transfer pattern "${candidate.source_item_id}" from goal "${candidate.source_goal_id}" to goal "${targetGoalId}". Estimated benefit: ${candidate.estimated_benefit}`;

    let ethicsVerdict: Awaited<ReturnType<EthicsGate["check"]>>;
    try {
      ethicsVerdict = await this.deps.ethicsGate.check(
        "task",
        candidateId,
        ethicsDescription
      );
    } catch {
      const failResult = TransferResultSchema.parse({
        transfer_id: `tr_${randomUUID()}`,
        candidate_id: candidateId,
        applied_at: new Date().toISOString(),
        adaptation_description: "Ethics gate check failed",
        success: false,
      });
      this.results.set(failResult.transfer_id, failResult);
      return failResult;
    }

    if (ethicsVerdict.verdict === "reject") {
      const failResult = TransferResultSchema.parse({
        transfer_id: `tr_${randomUUID()}`,
        candidate_id: candidateId,
        applied_at: new Date().toISOString(),
        adaptation_description: `Ethics gate rejected: ${ethicsVerdict.reasoning}`,
        success: false,
      });
      this.results.set(failResult.transfer_id, failResult);
      return failResult;
    }

    // Find the source pattern
    const sourceGoalId = candidate.source_goal_id;
    const allSourcePatterns =
      await this.deps.learningPipeline.getPatterns(sourceGoalId);
    const sourcePattern =
      allSourcePatterns.find((p) => p.pattern_id === candidate.source_item_id) ??
      null;

    // Capture gap at apply time for later effectiveness evaluation
    const gapAtApply = await this._estimateCurrentGap(targetGoalId);

    // LLM adaptation
    let adaptationDescription = candidate.estimated_benefit;
    let adaptationSuccess = true;

    if (sourcePattern !== null) {
      try {
        const adaptationPrompt = buildAdaptationPrompt(
          sourcePattern,
          sourceGoalId,
          targetGoalId
        );
        const adaptationResponse = await this.deps.llmClient.sendMessage(
          [{ role: "user", content: adaptationPrompt }],
          { max_tokens: 1024 }
        );
        const adaptationJson = extractJSON(adaptationResponse.content);
        const adaptationRaw = JSON.parse(adaptationJson) as unknown;
        const adaptationParsed = AdaptationResponseSchema.parse(adaptationRaw);
        adaptationDescription = adaptationParsed.adaptation_description;
        adaptationSuccess = adaptationParsed.success;
      } catch {
        // non-fatal: fall back to estimated_benefit
        adaptationSuccess = true; // assume it can be applied
      }
    }

    const transferId = `tr_${randomUUID()}`;
    const result = TransferResultSchema.parse({
      transfer_id: transferId,
      candidate_id: candidateId,
      applied_at: new Date().toISOString(),
      adaptation_description: adaptationDescription,
      success: adaptationSuccess,
    });

    this.results.set(result.transfer_id, result);

    // Store context for effectiveness evaluation
    this.applyContexts.set(result.transfer_id, {
      candidate,
      gap_at_apply: gapAtApply,
      source_pattern: sourcePattern,
    });

    return result;
  }

  // ─── evaluateTransferEffect ───

  /**
   * Evaluate the effectiveness of a previously applied transfer.
   *
   * Compares gap before and after application.
   * If 3 consecutive neutral/negative for the same source pattern,
   * marks that pattern as ineffective for transfer.
   */
  async evaluateTransferEffect(transferId: string): Promise<TransferEffectivenessRecord> {
    const result = this.results.get(transferId);
    const context = this.applyContexts.get(transferId);

    if (!result || !context) {
      // Return a neutral record when the transfer is unknown
      return TransferEffectivenessSchema.parse({
        transfer_id: transferId,
        gap_delta_before: 0,
        gap_delta_after: 0,
        effectiveness: "neutral" satisfies TransferEffectiveness,
        evaluated_at: new Date().toISOString(),
      });
    }

    const gapNow = await this._estimateCurrentGap(context.candidate.target_goal_id);
    const gapDeltaBefore = context.gap_at_apply;
    const gapDeltaAfter = gapNow;

    // Determine effectiveness based on gap delta
    // Positive = gap reduced (improvement), negative = gap increased (worse)
    const delta = gapDeltaBefore - gapDeltaAfter;
    let effectiveness: TransferEffectiveness;
    if (delta > 0.05) {
      effectiveness = "positive";
    } else if (delta < -0.05) {
      effectiveness = "negative";
    } else {
      effectiveness = "neutral";
    }

    const record = TransferEffectivenessSchema.parse({
      transfer_id: transferId,
      gap_delta_before: gapDeltaBefore,
      gap_delta_after: gapDeltaAfter,
      effectiveness,
      evaluated_at: new Date().toISOString(),
    });

    this.effectivenessRecords.set(transferId, record);

    // Track consecutive non-positive outcomes for the source pattern
    if (context.source_pattern !== null) {
      const patternId = context.source_pattern.pattern_id;
      const tracker = this.patternTrackers.get(patternId) ?? {
        consecutive_non_positive: 0,
        invalidated: false,
      };

      if (effectiveness === "positive") {
        tracker.consecutive_non_positive = 0;
      } else {
        tracker.consecutive_non_positive += 1;
      }

      // Auto-invalidate after 3 consecutive neutral/negative
      if (tracker.consecutive_non_positive >= 3) {
        tracker.invalidated = true;
      }

      this.patternTrackers.set(patternId, tracker);
    }

    return record;
  }

  // ─── buildCrossGoalKnowledgeBase ───

  /**
   * Aggregate all LearnedPatterns across all goals and extract
   * cross-domain meta-patterns via LLM.
   *
   * Stores meta-patterns internally.
   */
  async buildCrossGoalKnowledgeBase(): Promise<void> {
    const allGoalIds = await this.deps.stateManager.listGoalIds();

    // Collect all high-confidence patterns
    const highConfidencePatterns: LearnedPattern[] = [];
    for (const goalId of allGoalIds) {
      const patterns = await this.deps.learningPipeline.getPatterns(goalId);
      for (const pattern of patterns) {
        if (pattern.confidence >= 0.6) {
          highConfidencePatterns.push(pattern);
        }
      }
    }

    if (highConfidencePatterns.length === 0) {
      return;
    }

    // Use LLM to extract cross-domain meta-patterns
    try {
      const metaPrompt = buildMetaPatternPrompt(highConfidencePatterns);
      const metaResponse = await this.deps.llmClient.sendMessage(
        [{ role: "user", content: metaPrompt }],
        { max_tokens: 2048 }
      );
      const metaJson = extractJSON(metaResponse.content);
      const metaRaw = JSON.parse(metaJson) as unknown;
      const metaParsed = MetaPatternsResponseSchema.parse(metaRaw);

      // Store meta-patterns in VectorIndex for future retrieval
      if (this.deps.vectorIndex === null) return;
      for (const meta of metaParsed.meta_patterns) {
        const metaId = `meta_${randomUUID()}`;
        try {
          await this.deps.vectorIndex.add(metaId, meta.description, {
            type: "meta_pattern",
            applicable_domains: meta.applicable_domains,
            source_pattern_ids: meta.source_pattern_ids,
            created_at: new Date().toISOString(),
          });
        } catch {
          // non-fatal: embedding failure should not block
        }
      }
    } catch {
      // non-fatal: LLM failure or parse failure
    }
  }

  // ─── Accessors ───

  /** Return all detected transfer candidates */
  getTransferCandidates(): TransferCandidate[] {
    return Array.from(this.candidates.values());
  }

  /** Return all transfer results */
  getTransferResults(): TransferResult[] {
    return Array.from(this.results.values());
  }

  // ─── Cross-Goal Pattern Storage ───

  /**
   * Store a CrossGoalPattern for later retrieval.
   * Uses KnowledgeGraph if available, otherwise stores in-memory.
   */
  storePattern(pattern: CrossGoalPattern): void {
    const validated = CrossGoalPatternSchema.parse(pattern);
    this.crossGoalPatterns.set(validated.id, validated);

    // Optionally store in VectorIndex for semantic retrieval
    if (this.deps.vectorIndex !== null) {
      this.deps.vectorIndex
        .add(validated.id, validated.description, {
          type: "cross_goal_pattern",
          patternType: validated.patternType,
          feedbackType: validated.feedbackType,
          confidence: validated.confidence,
        })
        .catch(() => {
          // non-fatal: embedding failure should not block storage
        });
    }
  }

  /**
   * Retrieve stored CrossGoalPatterns, optionally filtered by feedbackType or patternType.
   */
  retrievePatterns(filter?: {
    feedbackType?: StructuralFeedbackType;
    patternType?: CrossGoalPattern["patternType"];
  }): CrossGoalPattern[] {
    let results = Array.from(this.crossGoalPatterns.values());

    if (filter?.feedbackType !== undefined) {
      results = results.filter((p) => p.feedbackType === filter.feedbackType);
    }

    if (filter?.patternType !== undefined) {
      results = results.filter((p) => p.patternType === filter.patternType);
    }

    return results;
  }

  // ─── Private Helpers ───

  /**
   * Estimate the current gap for a goal.
   * Returns 0.5 as a neutral default if goal state is unavailable.
   */
  private async _estimateCurrentGap(goalId: string): Promise<number> {
    try {
      const raw = await this.deps.stateManager.readRaw(
        `goals/${goalId}/state.json`
      );
      if (raw && typeof raw === "object" && raw !== null) {
        const state = raw as Record<string, unknown>;
        if (typeof state["gap"] === "number") {
          return state["gap"] as number;
        }
        // Try gap_score from loop state
        if (typeof state["gap_score"] === "number") {
          return state["gap_score"] as number;
        }
      }
    } catch {
      // non-fatal
    }
    return 0.5;
  }
}

// ─── Prompt Builders ───

function buildAdaptationPrompt(
  sourcePattern: LearnedPattern,
  sourceGoalId: string,
  targetGoalId: string
): string {
  return `You are adapting a learned pattern from one goal context to another.

Source Goal ID: ${sourceGoalId}
Target Goal ID: ${targetGoalId}

Source Pattern:
  ID: ${sourcePattern.pattern_id}
  Type: ${sourcePattern.type}
  Description: ${sourcePattern.description}
  Confidence: ${sourcePattern.confidence}
  Applicable Domains: ${sourcePattern.applicable_domains.join(", ") || "none"}

Task: Adapt this pattern so it is relevant and applicable for the target goal context.
- Remove goal-specific details from the source
- Generalize where needed
- Identify if direct application is possible

Respond with JSON:
{
  "adaptation_description": "<concise description of how the pattern was adapted for the target goal>",
  "adapted_content": "<the adapted pattern description ready for injection into target goal context>",
  "success": <boolean — true if adaptation is meaningful and applicable>
}

Return ONLY the JSON object, no other text.`;
}

function buildMetaPatternPrompt(patterns: LearnedPattern[]): string {
  const patternSummaries = patterns
    .slice(0, 50) // limit to avoid token overflow
    .map(
      (p) =>
        `- [${p.type}] ${p.description} (confidence: ${p.confidence.toFixed(2)}, domains: ${p.applicable_domains.join(", ") || "general"})`
    )
    .join("\n");

  return `You are extracting cross-domain meta-patterns from a collection of learned patterns across multiple goals.

Learned Patterns (${patterns.length} total, showing up to 50):
${patternSummaries}

Identify 3-7 meta-patterns that generalize across multiple learned patterns and domains.
Each meta-pattern should:
- Be applicable across different domains and goals
- Abstract away goal-specific details
- Capture universal principles about effective execution

Output JSON:
{
  "meta_patterns": [
    {
      "description": "<concrete, actionable meta-pattern description>",
      "applicable_domains": ["<domain1>", "<domain2>"],
      "source_pattern_ids": ["<pattern_id_1>", "<pattern_id_2>"]
    }
  ]
}

Return ONLY the JSON object, no other text.`;
}
