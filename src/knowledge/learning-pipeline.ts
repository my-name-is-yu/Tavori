import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ILLMClient } from "../llm/llm-client.js";
import { extractJSON } from "../llm/llm-client.js";
import type { VectorIndex } from "./vector-index.js";
import type { StateManager } from "../state-manager.js";
import {
  LearningTriggerSchema,
  LearnedPatternSchema,
  LearnedPatternTypeEnum,
  FeedbackEntrySchema,
  FeedbackTargetStepEnum,
  LearningPipelineConfigSchema,
} from "../types/learning.js";
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
} from "../types/learning.js";
import type { StallReport } from "../types/stall.js";
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

// ─── LLM Response Schemas ───

const TripletSchema = z.object({
  state_context: z.string(),
  action_taken: z.string(),
  outcome: z.string(),
  gap_delta: z.number(),
});
type Triplet = z.infer<typeof TripletSchema>;

const TripletsResponseSchema = z.object({
  triplets: z.array(TripletSchema),
});

const PatternItemSchema = z.object({
  description: z.string(),
  pattern_type: LearnedPatternTypeEnum,
  action_group: z.string(),
  applicable_domains: z.array(z.string()).default([]),
  occurrence_count: z.number().int().min(0),
  consistent_count: z.number().int().min(0),
  total_count: z.number().int().min(1),
  is_specific: z.boolean(),
});

const PatternsResponseSchema = z.object({
  patterns: z.array(PatternItemSchema),
});

// ─── Prompt Builders ───

function buildExtractionPrompt(
  trigger: LearningTrigger,
  logs: unknown
): string {
  return `Analyze the experience logs for goal "${trigger.goal_id}" and extract state→action→outcome triplets.

Trigger type: ${trigger.type}
Context: ${trigger.context}
Timestamp: ${trigger.timestamp}

Experience logs:
${JSON.stringify(logs, null, 2)}

Extract concrete triplets describing what happened. Each triplet must include:
- state_context: the observable state when the action was taken
- action_taken: a specific, concrete action that was executed
- outcome: what actually happened as a result
- gap_delta: change in goal gap (-1.0 to 1.0, negative means gap reduced/improved)

IMPORTANT: Only include triplets where action_taken describes a specific, concrete action.
Examples of ACCEPTED actions: "reduced task scope to 3 steps", "added prerequisite check at start", "estimated effort at 1.5x"
Examples of REJECTED actions: "did something better", "made improvements", "tried harder"

Output JSON:
{
  "triplets": [
    {
      "state_context": "<specific state description>",
      "action_taken": "<concrete specific action>",
      "outcome": "<measurable outcome>",
      "gap_delta": <number -1.0 to 1.0>
    }
  ]
}

Return ONLY the JSON object, no other text.`;
}

function buildPatternizationPrompt(triplets: Triplet[]): string {
  return `Analyze the following state→action→outcome triplets and identify repeating patterns.

Triplets:
${JSON.stringify(triplets, null, 2)}

For each group of similar actions, create a pattern entry. Each pattern must have:
- description: a concrete, actionable description (must specify what to do exactly)
- pattern_type: one of "observation_accuracy", "strategy_selection", "scope_sizing", "task_generation"
- action_group: the common action theme across the grouped triplets
- applicable_domains: list of domains where this pattern applies (infer from context)
- occurrence_count: how many triplets have this action group
- consistent_count: how many of those triplets showed consistent outcome direction (all improving or all worsening)
- total_count: total number of triplets analyzed
- is_specific: true if description is concrete enough to act on directly (false for vague descriptions like "do better")

Pattern type mapping:
- "observation_accuracy": patterns about how well observations matched reality
- "strategy_selection": patterns about which strategies worked/failed in which contexts
- "scope_sizing": patterns about task scope, size, or granularity
- "task_generation": patterns about task structure, format, or prerequisites

Only include patterns where is_specific = true AND occurrence_count >= 2.

Output JSON:
{
  "patterns": [
    {
      "description": "<concrete actionable description>",
      "pattern_type": "<type>",
      "action_group": "<common action theme>",
      "applicable_domains": ["<domain1>"],
      "occurrence_count": <int>,
      "consistent_count": <int>,
      "total_count": <int>,
      "is_specific": <boolean>
    }
  ]
}

Return ONLY the JSON object, no other text.`;
}

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

  constructor(
    private readonly llmClient: ILLMClient,
    private readonly vectorIndex: VectorIndex | null,
    private readonly stateManager: StateManager,
    config?: LearningPipelineConfig
  ) {
    this.config = config ?? LearningPipelineConfigSchema.parse({});
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
      this.generateFeedback(patterns);
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
      this.generateFeedback(patterns);
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
      this.generateFeedback(patterns);
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
      this.generateFeedback(patterns);
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
      const extractionResponse = await this.llmClient.sendMessage(
        [{ role: "user", content: extractionPrompt }],
        { max_tokens: 2048 }
      );
      const extractionJson = extractJSON(extractionResponse.content);
      const extractionRaw = JSON.parse(extractionJson) as unknown;
      const extractionParsed = TripletsResponseSchema.parse(extractionRaw);
      triplets = extractionParsed.triplets;
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
      const patternizationResponse = await this.llmClient.sendMessage(
        [{ role: "user", content: patternizationPrompt }],
        { max_tokens: 2048 }
      );
      const patternizationJson = extractJSON(patternizationResponse.content);
      const patternizationRaw = JSON.parse(patternizationJson) as unknown;
      const patternizationParsed = PatternsResponseSchema.parse(patternizationRaw);
      patternItems = patternizationParsed.patterns.filter((p) => p.is_specific);
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

// ─── Re-exports for backward compatibility ───
export type {
  StructuralFeedback,
  StructuralFeedbackType,
  FeedbackAggregation,
  ParameterTuning,
  CrossGoalPattern,
  PatternSharingResult,
} from "../types/learning.js";
export {
  getStructuralFeedback,
  recordStructuralFeedback,
  aggregateFeedback,
  autoTuneParameters,
} from "./learning-feedback.js";
export {
  extractCrossGoalPatterns,
  sharePatternsAcrossGoals,
} from "./learning-cross-goal.js";
