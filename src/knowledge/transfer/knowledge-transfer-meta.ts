import { randomUUID } from "node:crypto";
import type { ILLMClient } from "../../llm/llm-client.js";
import { extractJSON } from "../../llm/llm-client.js";
import type { IPromptGateway } from "../../prompt/gateway.js";
import type { LearningPipeline } from "../learning/learning-pipeline.js";
import type { VectorIndex } from "../vector-index.js";
import type { StateManager } from "../../state/state-manager.js";
import type { CrossGoalPattern, StructuralFeedbackType } from "../../types/learning.js";
import { CrossGoalPatternSchema } from "../../types/learning.js";
import {
  MetaPatternsResponseSchema,
  buildMetaPatternPrompt,
  buildIncrementalMetaPatternPrompt,
} from "./knowledge-transfer-prompts.js";

// ─── Deps ───

export interface MetaDeps {
  llmClient: ILLMClient;
  learningPipeline: LearningPipeline;
  vectorIndex: VectorIndex | null;
  stateManager: StateManager;
  gateway?: IPromptGateway;
}

// ─── buildCrossGoalKnowledgeBase ───

/**
 * Aggregate all LearnedPatterns across all goals and extract
 * cross-domain meta-patterns via LLM.
 *
 * Stores meta-patterns in VectorIndex.
 */
export async function buildCrossGoalKnowledgeBase(deps: MetaDeps): Promise<void> {
  const allGoalIds = await deps.stateManager.listGoalIds();

  // Collect all high-confidence patterns
  const highConfidencePatterns = [];
  for (const goalId of allGoalIds) {
    const patterns = await deps.learningPipeline.getPatterns(goalId);
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
    let metaParsed: {
      meta_patterns: Array<{
        description: string;
        applicable_domains: string[];
        source_pattern_ids: string[];
      }>;
    };
    if (deps.gateway) {
      metaParsed = await deps.gateway.execute({
        purpose: "knowledge_transfer_meta_patterns",
        additionalContext: { meta_pattern_prompt: metaPrompt },
        responseSchema: MetaPatternsResponseSchema,
        maxTokens: 2048,
      });
    } else {
      const metaResponse = await deps.llmClient.sendMessage(
        [{ role: "user", content: metaPrompt }],
        { max_tokens: 2048 }
      );
      const metaJson = extractJSON(metaResponse.content);
      const metaRaw = JSON.parse(metaJson) as unknown;
      metaParsed = MetaPatternsResponseSchema.parse(metaRaw);
    }

    // Store meta-patterns in VectorIndex for future retrieval
    if (deps.vectorIndex === null) return;
    for (const meta of metaParsed.meta_patterns) {
      const metaId = `meta_${randomUUID()}`;
      try {
        await deps.vectorIndex.add(metaId, meta.description, {
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

// ─── updateMetaPatternsIncremental ───

/**
 * Incremental meta-pattern update — processes only patterns created since last aggregation.
 * Called by LearningPipeline after analyzeLogs() produces new patterns.
 */
export async function updateMetaPatternsIncremental(
  deps: MetaDeps,
  getLastAggregatedAt: () => Promise<string | null>,
  saveLastAggregatedAt: (ts: string) => Promise<void>
): Promise<number> {
  const lastTs = await getLastAggregatedAt();
  const now = new Date().toISOString();

  // Collect all patterns across all goals
  const allGoalIds = await deps.stateManager.listGoalIds();
  const allPatterns = [];
  for (const goalId of allGoalIds) {
    const patterns = await deps.learningPipeline.getPatterns(goalId);
    for (const pattern of patterns) {
      allPatterns.push(pattern);
    }
  }

  // Filter to new ones since last aggregation
  const newPatterns = lastTs
    ? allPatterns.filter((p) => p.created_at > lastTs)
    : allPatterns;

  // Only high-confidence patterns
  const highConfidence = newPatterns.filter((p) => p.confidence >= 0.6);

  if (highConfidence.length === 0) {
    await saveLastAggregatedAt(now);
    return 0;
  }

  // Build prompt from new patterns
  const patternDescriptions = highConfidence
    .map(
      (p) =>
        `[${p.type}] ${p.description} (confidence: ${p.confidence}, domains: ${p.applicable_domains.join(",")})`
    )
    .join("\n");

  const prompt = buildIncrementalMetaPatternPrompt(patternDescriptions);

  try {
    let metaParsed: {
      meta_patterns: Array<{
        description: string;
        applicable_domains: string[];
        source_pattern_ids: string[];
      }>;
    };
    if (deps.gateway) {
      metaParsed = await deps.gateway.execute({
        purpose: "knowledge_transfer_incremental",
        additionalContext: { incremental_prompt: prompt },
        responseSchema: MetaPatternsResponseSchema,
        maxTokens: 1024,
      });
    } else {
      const response = await deps.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { max_tokens: 1024 }
      );
      const metaJson = extractJSON(response.content);
      const metaRaw = JSON.parse(metaJson) as unknown;
      metaParsed = MetaPatternsResponseSchema.parse(metaRaw);
    }

    // Register in VectorIndex (if available)
    let registered = 0;
    if (deps.vectorIndex !== null) {
      for (const mp of metaParsed.meta_patterns) {
        if (!mp.description) continue;
        const metaId = `meta_${randomUUID()}`;
        try {
          await deps.vectorIndex.add(metaId, mp.description, {
            type: "meta_pattern",
            applicable_domains: mp.applicable_domains ?? [],
            source_pattern_ids: mp.source_pattern_ids ?? [],
            created_at: now,
          });
        } catch {
          // non-fatal: embedding failure should not block
        }
        registered++;
      }
    }

    await saveLastAggregatedAt(now);
    return registered;
  } catch {
    // non-fatal: LLM failure or parse failure
    await saveLastAggregatedAt(now);
    return 0;
  }
}

// ─── Cross-Goal Pattern Storage ───

/**
 * Store a CrossGoalPattern for later retrieval.
 * Uses VectorIndex if available.
 */
export function storePattern(
  pattern: CrossGoalPattern,
  crossGoalPatterns: Map<string, CrossGoalPattern>,
  vectorIndex: VectorIndex | null
): void {
  const validated = CrossGoalPatternSchema.parse(pattern);
  crossGoalPatterns.set(validated.id, validated);

  // Optionally store in VectorIndex for semantic retrieval
  if (vectorIndex !== null) {
    vectorIndex
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
export function retrievePatterns(
  crossGoalPatterns: Map<string, CrossGoalPattern>,
  filter?: {
    feedbackType?: StructuralFeedbackType;
    patternType?: CrossGoalPattern["patternType"];
  }
): CrossGoalPattern[] {
  let results = Array.from(crossGoalPatterns.values());

  if (filter?.feedbackType !== undefined) {
    results = results.filter((p) => p.feedbackType === filter.feedbackType);
  }

  if (filter?.patternType !== undefined) {
    results = results.filter((p) => p.patternType === filter.patternType);
  }

  return results;
}
