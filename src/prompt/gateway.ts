/**
 * gateway.ts
 * Thin orchestrator: assembles context, calls LLM, parses response.
 */

import { z } from "zod";
import type { ILLMClient } from "../base/llm/llm-client.js";
import { ContextAssembler } from "./context-assembler.js";
import { PURPOSE_CONFIGS } from "./purposes/index.js";
import type { ContextPurpose } from "./slot-definitions.js";
import { getInternalIdentityPrefix } from "../base/config/identity-loader.js";

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface PromptGatewayInput<T> {
  purpose: ContextPurpose;
  goalId?: string;
  dimensionName?: string;
  additionalContext?: Record<string, string>;
  responseSchema: z.ZodSchema<T>;
  maxTokens?: number;
  temperature?: number;
}

export interface IPromptGateway {
  execute<T>(input: PromptGatewayInput<T>): Promise<T>;
}

// ─── Purpose → Role mapping ───────────────────────────────────────────────────

function purposeToRole(purpose: ContextPurpose): string {
  const roleMap: Partial<Record<ContextPurpose, string>> = {
    observation: "observer",
    strategy_generation: "strategist",
    strategy_template_match: "strategist",
    strategy_template_adapt: "strategist",
    task_generation: "task planner",
    verification: "verifier",
    goal_decomposition: "goal analyst",
    goal_quality_assessment: "goal quality checker",
    goal_quality_improvement: "goal quality checker",
    goal_quality_validation: "goal quality checker",
    goal_suggestion: "goal analyst",
    goal_specificity_evaluation: "goal analyst",
    goal_subgoal_decomposition: "goal analyst",
    goal_coverage_validation: "goal analyst",
    checkpoint_adapt: "checkpoint reviewer",
    checkpoint_analyze: "checkpoint reviewer",
    curiosity_propose: "curiosity analyzer",
    ethics_evaluate: "ethics evaluator",
    ethics_explain: "ethics evaluator",
    learning_extraction: "learning extractor",
    learning_patternize: "learning analyst",
    learning_pattern_extract: "learning extractor",
    learning_insight_generate: "learning analyst",
    capability_detect: "capability detector",
    capability_goal_gap: "capability analyst",
    capability_verify: "capability verifier",
    capability_assess: "capability analyst",
    capability_plan: "capability planner",
    knowledge_gap_detection: "knowledge analyst",
    knowledge_acquisition: "knowledge analyst",
    knowledge_contradiction: "knowledge analyst",
    knowledge_enrichment: "knowledge analyst",
    knowledge_stability: "knowledge analyst",
    knowledge_extraction: "knowledge analyst",
    knowledge_consolidation: "knowledge analyst",
    knowledge_query: "knowledge analyst",
    knowledge_decision: "knowledge analyst",
    knowledge_revalidation: "knowledge analyst",
    knowledge_transfer_adapt: "knowledge transfer specialist",
    knowledge_transfer_meta_patterns: "knowledge transfer specialist",
    knowledge_transfer_incremental: "knowledge transfer specialist",
    knowledge_transfer_extract: "knowledge transfer specialist",
    knowledge_transfer_apply: "knowledge transfer specialist",
    knowledge_transfer_validate: "knowledge transfer specialist",
    memory_distill_extract_patterns: "memory distiller",
    memory_distill_lessons: "memory distiller",
    memory_distill_summarize: "memory distiller",
    memory_distill_prioritize: "memory distiller",
    dependency_analysis: "dependency analyst",
    reflection_generation: "reflector",
    impact_analysis: "impact analyst",
    result_reconciliation: "result reconciler",
    negotiation_feasibility: "negotiator",
    negotiation_capability: "negotiator",
    negotiation_response: "negotiator",
  };
  return roleMap[purpose] ?? "assistant";
}

// ─── PromptGateway ────────────────────────────────────────────────────────────

export class PromptGateway implements IPromptGateway {
  constructor(
    private llmClient: ILLMClient,
    private assembler: ContextAssembler,
    private options?: { logger?: (msg: string) => void }
  ) {}

  async execute<T>(input: PromptGatewayInput<T>): Promise<T> {
    const config = PURPOSE_CONFIGS[input.purpose];

    let assembled;
    try {
      assembled = await this.assembler.build(
        input.purpose,
        input.goalId,
        input.dimensionName,
        input.additionalContext
      );
    } catch (err) {
      throw new Error(
        `[PromptGateway] context assembly failed (purpose=${input.purpose}, goalId=${input.goalId ?? "none"}): ${err}`
      );
    }

    const identityPrefix = getInternalIdentityPrefix(purposeToRole(input.purpose));
    const baseSystemPrompt = assembled.systemPrompt || config.systemPrompt;
    const fullSystemPrompt = `${identityPrefix}

${baseSystemPrompt}`;

    let response;
    try {
      response = await this.llmClient.sendMessage(
        [{ role: "user", content: assembled.contextBlock }],
        {
          system: fullSystemPrompt,
          max_tokens: input.maxTokens ?? config.defaultMaxTokens,
          temperature: input.temperature ?? config.defaultTemperature,
        }
      );
    } catch (err) {
      throw new Error(
        `[PromptGateway] LLM call failed (purpose=${input.purpose}, goalId=${input.goalId ?? "none"}): ${err}`
      );
    }

    const parsed = this.llmClient.parseJSON(response.content, input.responseSchema);

    if (this.options?.logger) {
      this.options.logger(
        `[PromptGateway] ${input.purpose} | tokens: ${response.usage.input_tokens}+${response.usage.output_tokens} | context: ${assembled.totalTokensUsed}`
      );
    }

    return parsed;
  }
}
