import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ILLMClient } from "../../llm/llm-client.js";
import { extractJSON } from "../../llm/llm-client.js";
import type { VectorIndex } from "../vector-index.js";
import type { StateManager } from "../../state/state-manager.js";
import type { IPromptGateway } from "../../prompt/gateway.js";
import {
  LearningTriggerSchema,
  LearnedPatternSchema,
  FeedbackEntrySchema,
  FeedbackTargetStepEnum,
  LearningPipelineConfigSchema,
  LearnedPatternTypeEnum,
} from "../../types/learning.js";
import type {
  LearningTrigger,
  LearnedPattern,
  FeedbackEntry,
  FeedbackTargetStep,
  LearningPipelineConfig,
  StructuralFeedback,
  StructuralFeedbackType,
  ParameterTuning,
  FeedbackAggregation,
  CrossGoalPattern,
  PatternSharingResult,
} from "../../types/learning.js";
import type { StallReport } from "../../types/stall.js";
import {
  getStructuralFeedback,
  recordStructuralFeedback,
  aggregateFeedback,
  autoTuneParameters,
} from "./learning-feedback.js";
import {
  extractCrossGoalPatterns,
  sharePatternsAcrossGoals,
} from "./learning-cross-goal.js";
import {
  TripletSchema,
  TripletsResponseSchema,
  PatternItemSchema,
  PatternsResponseSchema,
  buildExtractionPrompt,
  buildPatternizationPrompt,
} from "./learning-pipeline-prompts.js";
import type { Triplet } from "./learning-pipeline-prompts.js";

// ─── LearningPipeline ───

/**
 * LearningPipeline extracts patterns from goal execution logs and
 * applies feedback to future iterations via SessionManager context injection.
 *
 * File layout:
 *   <base>/learning/<goal_id>_logs.json
 *   <base>/learning/<goal_id>_patterns.json
 *   <base>/learning/<goal_id>_feedback.json
 */
export class LearningPipeline {
  private readonly config: LearningPipelineConfig;
  private knowledgeTransfer?: { updateMetaPatternsIncremental(): Promise<number> };
  private readonly gateway?: IPromptGateway;

  constructor(
    private readonly llmClient: ILLMClient,
    private readonly vectorIndex: VectorIndex | null,
    private readonly stateManager: StateManager,
    config?: LearningPipelineConfig,
    gateway?: IPromptGateway
  ) {
    this.config = config ?? LearningPipelineConfigSchema.parse({});
    this.gateway = gateway;
  }

  setKnowledgeTransfer(kt: { updateMetaPatternsIncremental(): Promise<number> }): void {
    this.knowledgeTransfer = kt;
  }

  // ─── Trigger Handlers ───

  /**
   * Called when a goal dimension reaches a milestone threshold.
   */
  async onMilestoneReached(
    goalId: string,
    milestoneContext: string
  ): Promise<LearnedPattern[]> {
    const trigger = LearningTriggerSchema.parse({
      type: "milestone_reached",
      goal_id: goalId,
      context: milestoneContext,
      timestamp: new Date().toISOString(),
    });
    const patterns = await this.analyzeLogs(trigger);
    if (patterns.length > 0) {
      await this.generateFeedback(patterns);
    }
    return patterns;
  }

  /**
   * Called when a stall is detected for a goal.
   */
  async onStallDetected(
    goalId: string,
    stallInfo: StallReport
  ): Promise<LearnedPattern[]> {
    const trigger = LearningTriggerSchema.parse({
      type: "stall_detected",
      goal_id: goalId,
      context: JSON.stringify(stallInfo),
      timestamp: new Date().toISOString(),
    });
    const patterns = await this.analyzeLogs(trigger);
    if (patterns.length > 0) {
      await this.generateFeedback(patterns);
    }
    return patterns;
  }

  /**
   * Called during periodic review of a goal.
   */
  async onPeriodicReview(goalId: string): Promise<LearnedPattern[]> {
    const trigger = LearningTriggerSchema.parse({
      type: "periodic_review",
      goal_id: goalId,
      context: `Periodic review at ${new Date().toISOString()}`,
      timestamp: new Date().toISOString(),
    });
    const patterns = await this.analyzeLogs(trigger);
    if (patterns.length > 0) {
      await this.generateFeedback(patterns);
    }
    return patterns;
  }

  /**
   * Called when a goal is marked as completed.
   * Also triggers cross-goal pattern sharing if enabled.
   */
  async onGoalCompleted(goalId: string): Promise<LearnedPattern[]> {
    const trigger = LearningTriggerSchema.parse({
      type: "goal_completed",
      goal_id: goalId,
      context: `Goal ${goalId} completed at ${new Date().toISOString()}`,
      timestamp: new Date().toISOString(),
    });
    const patterns = await this.analyzeLogs(trigger);
    if (patterns.length > 0) {
      await this.generateFeedback(patterns);
      // Share patterns across goals if enabled
      if (this.config.cross_goal_sharing_enabled) {
        for (const pattern of patterns) {
          try {
            await this.sharePatternAcrossGoals(pattern.pattern_id);
          } catch {
            // non-fatal: sharing failure should not block completion handling
          }
        }
      }
    }
    return patterns;
  }

  // ─── Analysis Pipeline ───

  /**
   * Core analysis pipeline: reads logs, extracts triplets via LLM,
   * detects patterns, filters by confidence, and persists results.
   */
  async analyzeLogs(trigger: LearningTrigger): Promise<LearnedPattern[]> {
    // 1. Load experience logs
    const logsKey = `learning/${trigger.goal_id}_logs.json`;
    const rawLogs = await this.stateManager.readRaw(logsKey);
    if (!rawLogs) {
      return [];
    }

    // 2. Stage 1: Extract triplets via LLM
    let triplets: Triplet[];
    try {
      const extractionPrompt = buildExtractionPrompt(trigger, rawLogs);
      if (this.gateway) {
        const extractionParsed = await this.gateway.execute({
          purpose: "learning_extraction",
          goalId: trigger.goal_id,
          additionalContext: { extraction_prompt: extractionPrompt },
          responseSchema: TripletsResponseSchema,
          maxTokens: 2048,
        });
        triplets = extractionParsed.triplets;
      } else {
        const extractionResponse = await this.llmClient.sendMessage(
          [{ role: "user", content: extractionPrompt }],
          { max_tokens: 2048 }
        );
        const extractionJson = extractJSON(extractionResponse.content);
        const extractionRaw = JSON.parse(extractionJson) as unknown;
        const extractionParsed = TripletsResponseSchema.parse(extractionRaw);
        triplets = extractionParsed.triplets;
      }
    } catch {
      // LLM failure or parse failure — return empty (non-fatal)
      return [];
    }

    if (triplets.length === 0) {
      return [];
    }

    // 3. Stage 2: Patternize triplets via LLM
    let patternItems: z.infer<typeof PatternItemSchema>[];
    try {
      const patternizationPrompt = buildPatternizationPrompt(triplets);
      if (this.gateway) {
        const patternizationParsed = await this.gateway.execute({
          purpose: "learning_patternize",
          goalId: trigger.goal_id,
          additionalContext: { patternize_prompt: patternizationPrompt },
          responseSchema: PatternsResponseSchema,
          maxTokens: 2048,
        });
        patternItems = patternizationParsed.patterns
          .filter((p) => p.is_specific)
          .map((p) => ({ ...p, applicable_domains: p.applicable_domains ?? [] }));
      } else {
        const patternizationResponse = await this.llmClient.sendMessage(
          [{ role: "user", content: patternizationPrompt }],
          { max_tokens: 2048 }
        );
        const patternizationJson = extractJSON(patternizationResponse.content);
        const patternizationRaw = JSON.parse(patternizationJson) as unknown;
        const patternizationParsed = PatternsResponseSchema.parse(patternizationRaw);
        patternItems = patternizationParsed.patterns
          .filter((p) => p.is_specific)
          .map((p) => ({ ...p, applicable_domains: p.applicable_domains ?? [] }));
      }
    } catch {
      // LLM failure or parse failure — return empty (non-fatal)
      return [];
    }

    // 4. Compute confidence (TypeScript-side) and filter
    const now = new Date().toISOString();
    const newPatterns: LearnedPattern[] = [];

    for (const item of patternItems) {
      const occurrenceFrequency = item.occurrence_count / item.total_count;
      const resultConsistency =
        item.occurrence_count > 0
          ? item.consistent_count / item.occurrence_count
          : 0;
      const confidence = occurrenceFrequency * resultConsistency;

      if (confidence < this.config.min_confidence_threshold) {
        continue;
      }

      const pattern = LearnedPatternSchema.parse({
        pattern_id: `pat_${randomUUID()}`,
        type: item.pattern_type,
        description: item.description,
        confidence,
        evidence_count: item.occurrence_count,
        source_goal_ids: [trigger.goal_id],
        applicable_domains: item.applicable_domains,
        embedding_id: null,
        created_at: now,
        last_applied_at: null,
      });

      newPatterns.push(pattern);
    }

    if (newPatterns.length === 0) {
      return [];
    }

    // 5. Merge with existing patterns (respecting max_patterns_per_goal)
    const existing = await this.getPatterns(trigger.goal_id);
    const merged = [...existing, ...newPatterns];

    // If over limit, remove lowest-confidence patterns
    if (merged.length > this.config.max_patterns_per_goal) {
      merged.sort((a, b) => b.confidence - a.confidence);
      merged.splice(this.config.max_patterns_per_goal);
    }

    await this.savePatterns(trigger.goal_id, merged);

    // 6. Register embeddings in VectorIndex if available
    if (this.vectorIndex !== null) {
      for (const pattern of newPatterns) {
        try {
          const entry = await this.vectorIndex.add(
            pattern.pattern_id,
            pattern.description,
            {
              pattern_id: pattern.pattern_id,
              type: pattern.type,
              goal_id: trigger.goal_id,
              confidence: pattern.confidence,
            }
          );

          // Update pattern with embedding_id
          const updatedPatterns = (await this.getPatterns(trigger.goal_id)).map((p) =>
            p.pattern_id === pattern.pattern_id
              ? { ...p, embedding_id: entry.id }
              : p
          );
          await this.savePatterns(trigger.goal_id, updatedPatterns);
        } catch {
          // non-fatal: embedding failure should not block pattern registration
        }
      }
    }

    // Trigger incremental meta-pattern update after new patterns are learned
    if (this.knowledgeTransfer && newPatterns.length > 0) {
      await this.knowledgeTransfer.updateMetaPatternsIncremental().catch(e => {
        // non-fatal: meta-pattern update failure should not block pattern registration
        void e;
      });
    }

    return newPatterns;
  }

  /**
   * Generate FeedbackEntry objects from learned patterns.
   * Maps each pattern type to a target step and persists the feedback.
   */
  async generateFeedback(patterns: LearnedPattern[]): Promise<FeedbackEntry[]> {
    const targetStepMap: Record<
      z.infer<typeof LearnedPatternTypeEnum>,
      FeedbackTargetStep
    > = {
      observation_accuracy: "observation",
      strategy_selection: "strategy",
      scope_sizing: "task",
      task_generation: "task",
    };

    const now = new Date().toISOString();
    const entries: FeedbackEntry[] = patterns.map((pattern, index) => {
      const targetStep = targetStepMap[pattern.type];
      return FeedbackEntrySchema.parse({
        feedback_id: `fb_${Date.now()}_${index}`,
        pattern_id: pattern.pattern_id,
        target_step: targetStep,
        adjustment: pattern.description,
        applied_at: now,
        effect_observed: null,
      });
    });

    // Group by goal: patterns share source_goal_ids[0] as the owner
    const byGoal = new Map<string, FeedbackEntry[]>();
    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i]!;
      const entry = entries[i]!;
      const goalId = pattern.source_goal_ids[0];
      if (!goalId) continue;
      const existing = byGoal.get(goalId) ?? [];
      existing.push(entry);
      byGoal.set(goalId, existing);
    }

    for (const [goalId, newEntries] of byGoal) {
      const existing = await this.getFeedbackEntries(goalId);
      await this.saveFeedbackEntries(goalId, [...existing, ...newEntries]);
    }

    return entries;
  }

  /**
   * Return adjustment strings for a given goal and target step.
   * Returns at most 3 entries sorted by confidence descending.
   */
  async applyFeedback(goalId: string, step: FeedbackTargetStep): Promise<string[]> {
    const allEntries = await this.getFeedbackEntries(goalId);
    const stepEntries = allEntries.filter((e) => e.target_step === step);

    // Enrich with pattern confidence for sorting
    const patterns = await this.getPatterns(goalId);
    const patternConfidenceMap = new Map<string, number>(
      patterns.map((p) => [p.pattern_id, p.confidence])
    );

    const enriched = stepEntries.map((e) => ({
      entry: e,
      confidence: patternConfidenceMap.get(e.pattern_id) ?? 0,
    }));

    // Sort by confidence descending, take top 3
    enriched.sort((a, b) => b.confidence - a.confidence);
    const top3 = enriched.slice(0, 3);

    return top3.map((e) => e.entry.adjustment);
  }

  /**
   * Share a pattern from its source goal to similar goals in the VectorIndex.
   * Only runs if vectorIndex is available and cross_goal_sharing_enabled.
   */
  async sharePatternAcrossGoals(patternId: string): Promise<void> {
    if (!this.vectorIndex || !this.config.cross_goal_sharing_enabled) {
      return;
    }

    // Find the pattern across all goals
    const allGoalIds = await this.stateManager.listGoalIds();
    let sourcePattern: LearnedPattern | null = null;
    let sourceGoalId: string | null = null;

    for (const goalId of allGoalIds) {
      const patterns = await this.getPatterns(goalId);
      const found = patterns.find((p) => p.pattern_id === patternId);
      if (found) {
        sourcePattern = found;
        sourceGoalId = goalId;
        break;
      }
    }

    if (!sourcePattern || !sourceGoalId) {
      return;
    }

    // Search for similar goals using the pattern description
    let similarResults: Array<{ id: string; similarity: number }>;
    try {
      similarResults = await this.vectorIndex.search(
        sourcePattern.description,
        10,
        0.7
      );
    } catch {
      // non-fatal
      return;
    }

    // Filter to goal-level entries only (metadata.goal_id present but different from source)
    const targetGoalIds = new Set<string>();
    for (const result of similarResults) {
      const entry = this.vectorIndex.getEntry(result.id);
      if (!entry) continue;
      const metaGoalId = entry.metadata?.["goal_id"] as string | undefined;
      if (metaGoalId && metaGoalId !== sourceGoalId) {
        targetGoalIds.add(metaGoalId);
      }
    }

    // Share to each target goal with confidence discount
    for (const targetGoalId of targetGoalIds) {
      const targetPatterns = await this.getPatterns(targetGoalId);

      // Duplicate check: skip if same pattern_id already in target
      const alreadyShared = targetPatterns.some(
        (p) => p.pattern_id === patternId
      );
      if (alreadyShared) continue;

      // Apply confidence discount
      const transferredConfidence = sourcePattern.confidence * 0.7;

      // Skip if transferred confidence is below threshold
      if (transferredConfidence < this.config.min_confidence_threshold) {
        continue;
      }

      const sharedPattern = LearnedPatternSchema.parse({
        ...sourcePattern,
        pattern_id: `pat_${randomUUID()}`, // New ID for the shared copy
        confidence: transferredConfidence,
        source_goal_ids: [...sourcePattern.source_goal_ids, sourceGoalId],
        created_at: new Date().toISOString(),
        last_applied_at: null,
        embedding_id: null,
      });

      const updatedTargetPatterns = [...targetPatterns, sharedPattern];

      // Respect max_patterns_per_goal limit
      if (updatedTargetPatterns.length > this.config.max_patterns_per_goal) {
        updatedTargetPatterns.sort((a, b) => b.confidence - a.confidence);
        updatedTargetPatterns.splice(this.config.max_patterns_per_goal);
      }

      await this.savePatterns(targetGoalId, updatedTargetPatterns);
    }
  }

  // ─── Persistence ───

  /**
   * Load learned patterns for a goal. Returns empty array if not found.
   */
  async getPatterns(goalId: string): Promise<LearnedPattern[]> {
    const raw = await this.stateManager.readRaw(`learning/${goalId}_patterns.json`);
    if (!raw || !Array.isArray(raw)) return [];
    try {
      return (raw as unknown[]).map((item) => LearnedPatternSchema.parse(item));
    } catch {
      return [];
    }
  }

  /**
   * Persist learned patterns for a goal.
   */
  async savePatterns(goalId: string, patterns: LearnedPattern[]): Promise<void> {
    await this.stateManager.writeRaw(`learning/${goalId}_patterns.json`, patterns);
  }

  /**
   * Load feedback entries for a goal. Returns empty array if not found.
   */
  async getFeedbackEntries(goalId: string): Promise<FeedbackEntry[]> {
    const raw = await this.stateManager.readRaw(`learning/${goalId}_feedback.json`);
    if (!raw || !Array.isArray(raw)) return [];
    try {
      return (raw as unknown[]).map((item) => FeedbackEntrySchema.parse(item));
    } catch {
      return [];
    }
  }

  /**
   * Persist feedback entries for a goal.
   */
  async saveFeedbackEntries(goalId: string, entries: FeedbackEntry[]): Promise<void> {
    await this.stateManager.writeRaw(`learning/${goalId}_feedback.json`, entries);
  }

  // ─── Structural Feedback (thin wrappers over learning-feedback.ts) ───

  /**
   * Record a structural feedback entry for a goal/iteration.
   */
  async recordStructuralFeedback(feedback: StructuralFeedback): Promise<void> {
    await recordStructuralFeedback(
      { stateManager: this.stateManager, config: this.config },
      feedback
    );
  }

  /**
   * Load structural feedback for a goal.
   */
  async getStructuralFeedback(goalId: string): Promise<StructuralFeedback[]> {
    return getStructuralFeedback(
      { stateManager: this.stateManager, config: this.config },
      goalId
    );
  }

  /**
   * Aggregate structural feedback for a goal, optionally filtered by type.
   */
  async aggregateFeedback(
    goalId: string,
    feedbackType?: StructuralFeedbackType
  ): Promise<FeedbackAggregation[]> {
    return aggregateFeedback(
      { stateManager: this.stateManager, config: this.config },
      goalId,
      feedbackType
    );
  }

  /**
   * Analyze feedback history and suggest parameter adjustments.
   */
  async autoTuneParameters(goalId: string): Promise<ParameterTuning[]> {
    return await autoTuneParameters(
      { stateManager: this.stateManager, config: this.config },
      goalId
    );
  }

  // ─── Cross-Goal Pattern Methods (thin wrappers over learning-cross-goal.ts) ───

  /**
   * Extract cross-goal patterns by analyzing structural feedback across multiple goals.
   */
  async extractCrossGoalPatterns(goalIds: string[]): Promise<CrossGoalPattern[]> {
    return await extractCrossGoalPatterns(
      { stateManager: this.stateManager, config: this.config },
      goalIds
    );
  }

  /**
   * Apply cross-goal patterns to target goals as feedback insights.
   */
  async sharePatternsAcrossGoals(
    patterns: CrossGoalPattern[],
    targetGoalIds: string[]
  ): Promise<PatternSharingResult> {
    return await sharePatternsAcrossGoals(
      { stateManager: this.stateManager, config: this.config },
      patterns,
      targetGoalIds
    );
  }
}
