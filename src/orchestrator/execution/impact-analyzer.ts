/**
 * impact-analyzer.ts
 *
 * Detects unintended side effects after task execution by asking an LLM
 * to compare the task output against the expected target scope.
 */

import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { IPromptGateway } from "../../prompt/gateway.js";
import type { Logger } from "../../runtime/logger.js";
import { ImpactAnalysisSchema } from "../../base/types/pipeline.js";
import type { ImpactAnalysis } from "../../base/types/pipeline.js";

export interface ImpactAnalyzerDeps {
  llmClient: ILLMClient;
  logger: Logger;
  gateway?: IPromptGateway;
}

export interface ImpactAnalyzerContext {
  taskDescription: string;
  taskOutput: string;
  verificationVerdict: string;
  /** Expected files/resources to be affected */
  targetScope: string[];
}

const FALLBACK_RESULT: ImpactAnalysis = {
  verdict: "partial",
  side_effects: ["Unable to analyze impact"],
  confidence: "uncertain",
};

export async function analyzeImpact(
  deps: ImpactAnalyzerDeps,
  context: ImpactAnalyzerContext
): Promise<ImpactAnalysis> {
  const { taskDescription, taskOutput, verificationVerdict, targetScope } = context;

  const scopeList = targetScope.length > 0
    ? targetScope.map((s) => `- ${s}`).join("\n")
    : "- (no specific scope defined)";

  const prompt = `Analyze this task execution for unintended side effects.

Task: ${taskDescription}
Verification verdict: ${verificationVerdict}
Expected scope (files/resources that should be affected):
${scopeList}

Task output (first 2000 chars):
${taskOutput.slice(0, 2000)}

Determine if the task affected anything OUTSIDE the expected scope.

Return JSON only:
{
  "verdict": "pass" | "partial" | "fail",
  "side_effects": ["<description of each unintended side effect>"],
  "confidence": "confirmed" | "likely" | "uncertain"
}

Rules:
- verdict "pass": no side effects detected outside scope
- verdict "partial": minor side effects that are acceptable
- verdict "fail": significant unintended side effects detected
- side_effects: empty array if none detected
- confidence: how certain you are about the analysis`;

  if (deps.gateway) {
    try {
      const raw = await deps.gateway.execute({
        purpose: "impact_analysis",
        additionalContext: { impact_analysis_prompt: prompt },
        responseSchema: ImpactAnalysisSchema,
        maxTokens: 1024,
      });
      return ImpactAnalysisSchema.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.logger.error(`[impact-analyzer] gateway call failed: ${msg}`);
      return FALLBACK_RESULT;
    }
  } else {
    let rawContent: string;
    try {
      const response = await deps.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        {
          system: "You are an impact analyzer. Identify unintended side effects objectively. Respond with JSON only.",
          max_tokens: 1024,
        }
      );
      rawContent = response.content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.logger.error(`[impact-analyzer] LLM call failed: ${msg}`);
      return FALLBACK_RESULT;
    }

    try {
      const sanitized = rawContent
        .replace(/```json\n?/g, "")
        .replace(/```/g, "")
        .trim();
      const parsed = JSON.parse(sanitized);
      return ImpactAnalysisSchema.parse(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.logger.error(`[impact-analyzer] Parse failed: ${msg}`);
      return FALLBACK_RESULT;
    }
  }
}
