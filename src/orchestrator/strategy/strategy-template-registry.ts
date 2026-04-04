import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { ValidationError } from "../../base/utils/errors.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { Logger } from "../../runtime/logger.js";
import type { IEmbeddingClient } from "../../platform/knowledge/embedding-client.js";
import type { IPromptGateway } from "../../prompt/gateway.js";
import { VectorIndex } from "../../platform/knowledge/vector-index.js";
import { StrategyTemplateSchema } from "../../base/types/cross-portfolio.js";
import type {
  StrategyTemplate,
  EmbeddingRecommendation,
  HybridRecommendation,
} from "../../base/types/cross-portfolio.js";
import { StrategySchema } from "../../base/types/strategy.js";
import type { Strategy } from "../../base/types/strategy.js";

// ─── LLM Response Schemas ───

const GeneralizeHypothesisResponseSchema = z.object({
  hypothesis_pattern: z.string(),
  domain_tags: z.array(z.string()),
  applicable_dimensions: z.array(z.string()),
});

const AdaptTemplateResponseSchema = z.object({
  hypothesis: z.string(),
  target_dimensions: z.array(z.string()),
  expected_effect: z.array(
    z.object({
      dimension: z.string(),
      direction: z.enum(["increase", "decrease"]),
      magnitude: z.enum(["small", "medium", "large"]),
    })
  ),
});

// ─── StrategyTemplateRegistry ───

/**
 * StrategyTemplateRegistry manages successful strategy templates for cross-goal reuse.
 *
 * It stores templates derived from completed strategies, generates semantic embeddings
 * for semantic search, and can adapt templates to new goal contexts.
 *
 * Persistence: {basePath}/strategy-templates.json
 */
export class StrategyTemplateRegistry {
  private readonly templates: Map<string, StrategyTemplate> = new Map();
  private readonly persistPath: string;
  private readonly logger?: Logger;

  constructor(
    private readonly llmClient: ILLMClient,
    private readonly vectorIndex: VectorIndex,
    private readonly embeddingClient: IEmbeddingClient,
    private readonly basePath: string,
    logger?: Logger,
    private readonly promptGateway?: IPromptGateway
  ) {
    this.persistPath = path.join(basePath, "strategy-templates.json");
    this.logger = logger;
  }

  /**
   * Register a completed, effective strategy as a reusable template.
   * Preconditions: strategy.state === "completed" AND effectiveness_score >= 0.5
   */
  async registerTemplate(
    strategy: Strategy,
    goalId: string
  ): Promise<StrategyTemplate> {
    if (strategy.state !== "completed") {
      throw new ValidationError(
        `Cannot register template: strategy state is "${strategy.state}", expected "completed"`
      );
    }
    if (
      strategy.effectiveness_score === null ||
      strategy.effectiveness_score < 0.5
    ) {
      throw new ValidationError(
        `Cannot register template: effectiveness_score is ${strategy.effectiveness_score ?? "null"}, must be >= 0.5`
      );
    }

    // Ask LLM to generalize the hypothesis into a reusable pattern
    const generalizePrompt = [
      "Generalize this successful strategy hypothesis into a reusable pattern.",
      "Remove domain-specific details and keep the core approach.",
      "",
      `Hypothesis: ${strategy.hypothesis}`,
      `Target dimensions: ${strategy.target_dimensions.join(", ")}`,
      `Expected effects: ${JSON.stringify(strategy.expected_effect)}`,
      "",
      'Output JSON: { "hypothesis_pattern": string, "domain_tags": string[], "applicable_dimensions": string[] }',
    ].join("\n");

    let generalized: z.infer<typeof GeneralizeHypothesisResponseSchema>;
    if (this.promptGateway) {
      generalized = await this.promptGateway.execute({
        purpose: "strategy_generation",
        goalId,
        additionalContext: { generalize_prompt: generalizePrompt },
        responseSchema: GeneralizeHypothesisResponseSchema,
      });
    } else {
      const llmResponse = await this.llmClient.sendMessage([
        { role: "user", content: generalizePrompt },
      ]);
      generalized = this.llmClient.parseJSON(
        llmResponse.content,
        GeneralizeHypothesisResponseSchema
      );
    }

    // Create a VectorIndex entry for semantic search
    const embeddingId = `tmpl-emb-${randomUUID()}`;
    await this.vectorIndex.add(embeddingId, generalized.hypothesis_pattern, {
      template_type: "strategy-template",
      domain_tags: generalized.domain_tags,
      applicable_dimensions: generalized.applicable_dimensions,
      source_goal_id: goalId,
      source_strategy_id: strategy.id,
    });

    // Create the StrategyTemplate object
    const template: StrategyTemplate = StrategyTemplateSchema.parse({
      template_id: `tmpl-${randomUUID()}`,
      source_goal_id: goalId,
      source_strategy_id: strategy.id,
      hypothesis_pattern: generalized.hypothesis_pattern,
      domain_tags: generalized.domain_tags,
      effectiveness_score: strategy.effectiveness_score,
      applicable_dimensions: generalized.applicable_dimensions,
      embedding_id: embeddingId,
      created_at: new Date().toISOString(),
    });

    this.templates.set(template.template_id, template);
    await this.save();

    return template;
  }

  /**
   * Search templates by semantic similarity.
   * Optionally filter by domain tags (at least one tag must overlap).
   */
  async searchTemplates(
    query: string,
    limit: number = 5,
    domainTags?: string[]
  ): Promise<StrategyTemplate[]> {
    if (this.templates.size === 0) {
      return [];
    }

    // Generate embedding for query and search VectorIndex
    const queryVector = await this.embeddingClient.embed(query);
    const searchResults = this.vectorIndex.searchByVector(
      queryVector,
      this.templates.size // fetch all, we'll slice after filtering
    );

    // Map results to StrategyTemplate objects, filtering by domain tags if needed
    const matched: Array<{ template: StrategyTemplate; similarity: number }> =
      [];

    for (const result of searchResults) {
      // Each VectorIndex entry has the embeddingId as its id
      // Find the template that references this embeddingId
      const template = this._findTemplateByEmbeddingId(result.id);
      if (!template) continue;

      // Filter by domain tags if specified
      if (domainTags && domainTags.length > 0) {
        const overlap = template.domain_tags.some((tag) =>
          domainTags.includes(tag)
        );
        if (!overlap) continue;
      }

      matched.push({ template, similarity: result.similarity });
    }

    // Sort by similarity descending (searchByVector already sorts, but re-sort after filtering)
    matched.sort((a, b) => b.similarity - a.similarity);

    return matched.slice(0, limit).map((m) => m.template);
  }

  /**
   * Adapt a template to a new goal context, generating a concrete Strategy.
   * The caller is responsible for persisting the returned Strategy.
   */
  async applyTemplate(
    templateId: string,
    goalId: string,
    goalContext: string
  ): Promise<Strategy> {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    // Ask LLM to adapt the template to the new goal context
    const adaptPrompt = [
      "Adapt this strategy template to the following goal context.",
      "Create a concrete strategy hypothesis.",
      "",
      `Template hypothesis pattern: ${template.hypothesis_pattern}`,
      `Applicable dimensions: ${template.applicable_dimensions.join(", ")}`,
      `Goal context: ${goalContext}`,
      "",
      'Output JSON: { "hypothesis": string, "target_dimensions": string[], "expected_effect": Array<{ "dimension": string, "direction": "increase"|"decrease", "magnitude": "small"|"medium"|"large" }> }',
    ].join("\n");

    let adapted: z.infer<typeof AdaptTemplateResponseSchema>;
    if (this.promptGateway) {
      adapted = await this.promptGateway.execute({
        purpose: "strategy_generation",
        goalId,
        additionalContext: { adapt_prompt: adaptPrompt },
        responseSchema: AdaptTemplateResponseSchema,
      });
    } else {
      const llmResponse = await this.llmClient.sendMessage([
        { role: "user", content: adaptPrompt },
      ]);
      adapted = this.llmClient.parseJSON(
        llmResponse.content,
        AdaptTemplateResponseSchema
      );
    }

    // Create a new Strategy object
    const now = new Date().toISOString();
    const strategy: Strategy = StrategySchema.parse({
      id: `strat-${randomUUID()}`,
      goal_id: goalId,
      target_dimensions: adapted.target_dimensions,
      primary_dimension: adapted.target_dimensions[0] ?? "default",
      hypothesis: adapted.hypothesis,
      expected_effect: adapted.expected_effect,
      resource_estimate: {
        sessions: 1,
        duration: { unit: "hours", value: 1 },
        llm_calls: null,
      },
      state: "candidate",
      allocation: 0,
      created_at: now,
      started_at: null,
      completed_at: null,
      gap_snapshot_at_start: null,
      tasks_generated: [],
      effectiveness_score: null,
      consecutive_stall_count: 0,
      source_template_id: templateId,
      cross_goal_context: goalContext,
    });

    return strategy;
  }

  /**
   * Index all registered templates into a VectorIndex using the provided embedding client.
   * Each template's hypothesis_pattern is embedded and stored with its template_id as metadata.
   * Call this once after loading templates to enable recommendByEmbedding() / recommendHybrid().
   */
  async indexTemplates(
    embeddingClient: IEmbeddingClient,
    vectorIndex: VectorIndex
  ): Promise<void> {
    for (const template of this.templates.values()) {
      const indexId = `idx-${template.template_id}`;
      await vectorIndex.add(indexId, template.hypothesis_pattern, {
        template_id: template.template_id,
        domain_tags: template.domain_tags,
      });
    }
  }

  /**
   * Recommend templates for a goal description using semantic embedding similarity.
   * Searches the provided VectorIndex for the top-K closest templates.
   * Returns EmbeddingRecommendation[] sorted by similarity descending.
   */
  async recommendByEmbedding(
    goalDescription: string,
    embeddingClient: IEmbeddingClient,
    vectorIndex: VectorIndex,
    topK: number = 5
  ): Promise<EmbeddingRecommendation[]> {
    if (this.templates.size === 0) {
      return [];
    }

    const queryVector = await embeddingClient.embed(goalDescription);
    const searchResults = vectorIndex.searchByVector(queryVector, topK);

    const recommendations: EmbeddingRecommendation[] = [];

    for (const result of searchResults) {
      // Each indexed entry stores template_id in metadata
      const templateId = result.metadata?.["template_id"] as string | undefined;
      if (!templateId) continue;

      const template = this.templates.get(templateId);
      if (!template) continue;

      recommendations.push({
        templateId,
        similarity: result.similarity,
        matchReason: `Semantic similarity to hypothesis pattern: "${template.hypothesis_pattern}"`,
      });
    }

    return recommendations;
  }

  /**
   * Hybrid recommendation combining tag-based matching with embedding similarity.
   * tagScore: fraction of goal tags that overlap with template domain_tags (0 if no tags supplied).
   * embeddingScore: cosine similarity from VectorIndex.
   * combinedScore: tagWeight * tagScore + embeddingWeight * embeddingScore (default 0.4 / 0.6).
   * Returns HybridRecommendation[] sorted by combinedScore descending.
   */
  async recommendHybrid(
    goalDescription: string,
    goalTags: string[],
    embeddingClient: IEmbeddingClient,
    vectorIndex: VectorIndex,
    options: { tagWeight?: number; embeddingWeight?: number; topK?: number } = {}
  ): Promise<HybridRecommendation[]> {
    const {
      tagWeight = 0.4,
      embeddingWeight = 0.6,
      topK = 5,
    } = options;

    if (this.templates.size === 0) {
      return [];
    }

    // Get embedding scores for all templates (fetch all, we slice after combining)
    const queryVector = await embeddingClient.embed(goalDescription);
    const searchResults = vectorIndex.searchByVector(
      queryVector,
      this.templates.size
    );

    // Build a lookup from templateId → embedding similarity
    const embeddingMap = new Map<string, number>();
    for (const result of searchResults) {
      const templateId = result.metadata?.["template_id"] as string | undefined;
      if (templateId) {
        embeddingMap.set(templateId, result.similarity);
      }
    }

    const hybrid: HybridRecommendation[] = [];

    for (const template of this.templates.values()) {
      // Tag score: fraction of goal tags present in template domain_tags
      let tagScore = 0;
      if (goalTags.length > 0 && template.domain_tags.length > 0) {
        const matchCount = goalTags.filter((t) =>
          template.domain_tags.includes(t)
        ).length;
        tagScore = matchCount / goalTags.length;
      }

      const embeddingScore = embeddingMap.get(template.template_id) ?? 0;
      const combinedScore = tagWeight * tagScore + embeddingWeight * embeddingScore;

      hybrid.push({
        templateId: template.template_id,
        tagScore,
        embeddingScore,
        combinedScore,
      });
    }

    hybrid.sort((a, b) => b.combinedScore - a.combinedScore);
    return hybrid.slice(0, topK);
  }

  /**
   * Persist all templates to JSON file (atomic write).
   */
  async save(): Promise<void> {
    const dir = path.dirname(this.persistPath);
    await fsp.mkdir(dir, { recursive: true });

    const data = JSON.stringify(
      Array.from(this.templates.values()),
      null,
      2
    );
    const tmpPath = `${this.persistPath}.tmp`;
    await fsp.writeFile(tmpPath, data, "utf-8");
    await fsp.rename(tmpPath, this.persistPath);
  }

  /**
   * Load templates from JSON file.
   * Silently succeeds if the file does not exist.
   */
  async load(): Promise<void> {
    try { await fsp.access(this.persistPath); } catch { return; }

    try {
      const raw = await fsp.readFile(this.persistPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown[];
      this.templates.clear();
      for (const item of parsed) {
        const template = StrategyTemplateSchema.parse(item);
        this.templates.set(template.template_id, template);
      }
    } catch (err) {
      this.logger?.warn(`[StrategyTemplateRegistry] Failed to load templates from ${this.persistPath}, starting fresh: ${err}`);
    }
  }

  /**
   * Return the number of templates currently in the registry.
   */
  get size(): number {
    return this.templates.size;
  }

  /**
   * Retrieve a template by ID. Returns undefined if not found.
   */
  getTemplate(templateId: string): StrategyTemplate | undefined {
    return this.templates.get(templateId);
  }

  // ─── Private Helpers ───

  private _findTemplateByEmbeddingId(
    embeddingId: string
  ): StrategyTemplate | undefined {
    for (const template of this.templates.values()) {
      if (template.embedding_id === embeddingId) {
        return template;
      }
    }
    return undefined;
  }
}
