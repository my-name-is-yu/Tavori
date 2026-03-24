/**
 * negotiator-steps.ts — Shared pipeline steps for negotiate() and renegotiate().
 *
 * Extracted from goal-negotiator.ts to keep that file under 500 lines.
 * These are pure/functional helpers; they do NOT save state.
 */

import { z } from "zod";
import type { ILLMClient } from "../llm/llm-client.js";
import type { IPromptGateway } from "../prompt/gateway.js";
import type { ObservationEngine } from "../observation/observation-engine.js";
import type { Logger } from "../runtime/logger.js";
import { sanitizeThresholdTypes, sanitizeThresholdValues } from "./refiner-prompts.js";
import {
  DimensionDecompositionSchema,
  FeasibilityResultSchema,
  CapabilityCheckLogSchema,
} from "../types/negotiation.js";
import type {
  DimensionDecomposition,
  FeasibilityResult,
  NegotiationLog,
  NegotiationResponse,
} from "../types/negotiation.js";
import type { Dimension } from "../types/goal.js";
import type { CharacterConfig } from "../types/character.js";
import {
  buildDecompositionPrompt,
  buildFeasibilityPrompt,
  buildResponsePrompt,
  QualitativeFeasibilitySchema,
} from "./negotiator-prompts.js";
import {
  buildCapabilityCheckPrompt,
  CapabilityCheckResultSchema,
} from "./goal-suggest.js";
import {
  deduplicateDimensionKeys,
  findBestDimensionMatch,
} from "./goal-validation.js";

// ─── Constants ───

export const FEASIBILITY_RATIO_THRESHOLD_REALISTIC = 1.5;
export const REALISTIC_TARGET_ACCELERATION_FACTOR = 1.3;
export const DEFAULT_TIME_HORIZON_DAYS = 90;

// ─── getFeasibilityThreshold ───

export function getFeasibilityThreshold(characterConfig: CharacterConfig): number {
  return 1.5 + characterConfig.caution_level * 0.5;
}

// ─── Step 2: Dimension Decomposition ───

export async function runDecompositionStep(
  goalDescription: string,
  constraints: string[],
  observationEngine: ObservationEngine,
  llmClient: ILLMClient,
  workspaceContext?: string,
  logger?: Logger,
  gateway?: IPromptGateway
): Promise<{ dimensions: DimensionDecomposition[]; availableDataSources: ReturnType<ObservationEngine["getAvailableDimensionInfo"]> }> {
  const availableDataSources = observationEngine.getAvailableDimensionInfo();
  const decompositionPrompt = buildDecompositionPrompt(
    goalDescription,
    constraints,
    availableDataSources,
    workspaceContext
  );

  let dimensions: DimensionDecomposition[];
  if (gateway) {
    dimensions = await gateway.execute({
      purpose: "goal_decomposition",
      responseSchema: z.array(DimensionDecompositionSchema),
      additionalContext: {
        prompt: decompositionPrompt,
        goalDescription,
        constraints: constraints.join(", "),
        ...(workspaceContext ? { workspaceContext } : {}),
      },
    });
  } else {
    const decompositionResponse = await llmClient.sendMessage(
      [{ role: "user", content: decompositionPrompt }],
      { temperature: 0, model_tier: 'main' }
    );
    const sanitized = sanitizeThresholdValues(sanitizeThresholdTypes(decompositionResponse.content));
    dimensions = llmClient.parseJSON(
      sanitized,
      z.array(DimensionDecompositionSchema)
    );
  }

  // Post-process: map dimension names to DataSource dimensions when similar
  if (availableDataSources.length > 0) {
    const allDsNames = availableDataSources.flatMap((ds) => ds.dimensions);
    for (const dim of dimensions) {
      if (!allDsNames.includes(dim.name)) {
        const match = findBestDimensionMatch(dim.name, allDsNames);
        if (match) {
          dim.name = match;
        }
      }
    }

    // Warn if all dimensions were remapped to DataSource dimensions
    const allRemapped =
      dimensions.length > 0 && dimensions.every((dim) => allDsNames.includes(dim.name));
    if (allRemapped) {
      logger?.warn(
        "[GoalNegotiator] Warning: all dimensions were remapped to DataSource dimensions. " +
          "Quality-specific dimensions may be missing. Consider adding dimensions that directly " +
          "measure the goal's quality aspects."
      );
    }
  }

  // Post-process: ensure all dimension keys are unique
  deduplicateDimensionKeys(dimensions);

  return { dimensions, availableDataSources };
}

// ─── Step 3: Baseline (new goal) ───

export function buildInitialBaseline(dimensions: DimensionDecomposition[]): Array<{
  dimension: string;
  value: number | string | boolean | null;
  confidence: number;
  method: string;
}> {
  return dimensions.map((dim) => ({
    dimension: dim.name,
    value: null,
    confidence: 0,
    method: "initial_baseline",
  }));
}

// ─── Step 3: Baseline (renegotiation) ───

export function buildRenegotiationBaseline(
  dimensions: DimensionDecomposition[],
  existingDimensions: Dimension[]
): Array<{
  dimension: string;
  value: number | string | boolean | null;
  confidence: number;
  method: string;
}> {
  return dimensions.map((dim) => {
    const existingDim = existingDimensions.find((d) => d.name === dim.name);
    return {
      dimension: dim.name,
      value: existingDim?.current_value ?? null,
      confidence: existingDim?.confidence ?? 0,
      method: "existing_observation",
    };
  });
}

// ─── Step 4: Qualitative Feasibility Evaluation ───

export async function evaluateQualitatively(
  llmClient: ILLMClient,
  dimensionName: string,
  goalDescription: string,
  baselineValue: number | string | boolean | null,
  thresholdValue: number | string | boolean | (number | string)[] | null,
  timeHorizonDays: number,
  gateway?: IPromptGateway
): Promise<FeasibilityResult> {
  const prompt = buildFeasibilityPrompt(
    dimensionName,
    goalDescription,
    baselineValue,
    thresholdValue,
    timeHorizonDays
  );

  try {
    let parsed: { assessment: string; confidence: string; reasoning: string; key_assumptions: string[]; main_risks: string[] };
    if (gateway) {
      parsed = await gateway.execute({
        purpose: "negotiation_feasibility",
        responseSchema: QualitativeFeasibilitySchema,
        additionalContext: {
          prompt,
          dimensionName,
          goalDescription,
          baselineValue: String(baselineValue),
          thresholdValue: String(thresholdValue),
          timeHorizonDays: String(timeHorizonDays),
        },
      });
    } else {
      const response = await llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { temperature: 0, model_tier: 'main' }
      );
      parsed = llmClient.parseJSON(response.content, QualitativeFeasibilitySchema);
    }
    return FeasibilityResultSchema.parse({
      dimension: dimensionName,
      path: "qualitative",
      feasibility_ratio: null,
      assessment: parsed.assessment,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      key_assumptions: parsed.key_assumptions,
      main_risks: parsed.main_risks,
    });
  } catch {
    return FeasibilityResultSchema.parse({
      dimension: dimensionName,
      path: "qualitative",
      feasibility_ratio: null,
      assessment: "ambitious",
      confidence: "low",
      reasoning: "Failed to parse feasibility assessment, defaulting to ambitious.",
      key_assumptions: [],
      main_risks: ["Unable to assess feasibility"],
    });
  }
}

// ─── Step 4b: Capability Check ───

export async function runCapabilityCheckStep(
  llmClient: ILLMClient,
  goalDescription: string,
  dimensions: DimensionDecomposition[],
  adapterCapabilities: Array<{ adapterType: string; capabilities: string[] }>,
  feasibilityResults: FeasibilityResult[],
  log: NegotiationLog,
  logger?: Logger,
  gateway?: IPromptGateway
): Promise<void> {
  try {
    const capCheckPrompt = buildCapabilityCheckPrompt(
      goalDescription,
      dimensions,
      adapterCapabilities
    );
    let capCheckResult: z.infer<typeof CapabilityCheckResultSchema>;
    if (gateway) {
      capCheckResult = await gateway.execute({
        purpose: "negotiation_capability",
        responseSchema: CapabilityCheckResultSchema,
        additionalContext: {
          prompt: capCheckPrompt,
          goalDescription,
          dimensions: dimensions.map((d) => d.name).join(", "),
          capabilities: adapterCapabilities.flatMap((ac) => ac.capabilities).join(", "),
        },
      });
    } else {
      const capCheckResponse = await llmClient.sendMessage(
        [{ role: "user", content: capCheckPrompt }],
        { temperature: 0, model_tier: 'main' }
      );
      capCheckResult = llmClient.parseJSON(
        capCheckResponse.content,
        CapabilityCheckResultSchema
      );
    }

    const allCapabilities = adapterCapabilities.flatMap((ac) => ac.capabilities);
    const infeasibleDimensions: string[] = [];

    for (const gap of capCheckResult.gaps) {
      if (!gap.acquirable) {
        const existing = feasibilityResults.find((r) => r.dimension === gap.dimension);
        if (existing) {
          existing.assessment = "infeasible";
          existing.reasoning = `Capability gap: ${gap.reason}`;
        }
        infeasibleDimensions.push(gap.dimension);
      }
    }

    log.step4_capability_check = CapabilityCheckLogSchema.parse({
      capabilities_available: allCapabilities,
      gaps_detected: capCheckResult.gaps.map((g) => ({
        dimension: g.dimension,
        required_capability: g.required_capability,
        acquirable: g.acquirable,
      })),
      infeasible_dimensions: infeasibleDimensions,
    });
  } catch {
    logger?.warn(
      "[GoalNegotiator] Step 4b capability check failed, continuing without it"
    );
  }
}

// ─── Step 5: Determine Response Type ───

export function determineResponseType(
  feasibilityResults: FeasibilityResult[],
  baselineObservations: Array<{
    dimension: string;
    value: number | string | boolean | null;
    confidence: number;
    method: string;
  }>,
  timeHorizonDays: number
): {
  responseType: "accept" | "counter_propose" | "flag_as_ambitious";
  counterProposal?: {
    realistic_target: number;
    reasoning: string;
    alternatives: string[];
  };
  initialConfidence: "high" | "medium" | "low";
} {
  const hasInfeasible = feasibilityResults.some((r) => r.assessment === "infeasible");
  const hasLowConfidence = feasibilityResults.some((r) => r.confidence === "low");
  const allRealisticOrAmbitious = feasibilityResults.every(
    (r) => r.assessment === "realistic" || r.assessment === "ambitious"
  );

  let initialConfidence: "high" | "medium" | "low";
  if (hasLowConfidence) {
    initialConfidence = "low";
  } else if (feasibilityResults.some((r) => r.confidence === "medium")) {
    initialConfidence = "medium";
  } else {
    initialConfidence = "high";
  }

  if (hasInfeasible) {
    const infeasible = feasibilityResults.find((r) => r.assessment === "infeasible")!;
    const baseline = baselineObservations.find((o) => o.dimension === infeasible.dimension);
    const baselineValue = typeof baseline?.value === "number" ? baseline.value : 0;

    let realisticTarget: number;
    if (infeasible.feasibility_ratio !== null && infeasible.feasibility_ratio > 0) {
      const gap =
        (timeHorizonDays * REALISTIC_TARGET_ACCELERATION_FACTOR) /
        infeasible.feasibility_ratio;
      realisticTarget = baselineValue + gap;
    } else {
      realisticTarget = baselineValue;
    }

    return {
      responseType: "counter_propose",
      counterProposal: {
        realistic_target: realisticTarget,
        reasoning: infeasible.reasoning,
        alternatives:
          infeasible.main_risks.length > 0
            ? [`Address risks: ${infeasible.main_risks.join(", ")}`]
            : ["Consider reducing scope or extending timeline"],
      },
      initialConfidence: "low",
    };
  }

  if (hasLowConfidence && allRealisticOrAmbitious) {
    return { responseType: "flag_as_ambitious", initialConfidence: "low" };
  }

  return { responseType: "accept", initialConfidence };
}

// ─── Step 5: Build Response ───

export async function buildNegotiationResponse(
  llmClient: ILLMClient,
  goalDescription: string,
  responseType: "accept" | "counter_propose" | "flag_as_ambitious",
  feasibilityResults: FeasibilityResult[],
  counterProposal: { realistic_target: number; reasoning: string; alternatives: string[] } | undefined,
  ethicsFlags: string[] | undefined,
  initialConfidence: "high" | "medium" | "low",
  gateway?: IPromptGateway
): Promise<NegotiationResponse> {
  const responsePrompt = buildResponsePrompt(
    goalDescription,
    responseType,
    feasibilityResults,
    counterProposal
  );

  let messageContent: string;
  if (gateway) {
    const result = await gateway.execute({
      purpose: "negotiation_response",
      responseSchema: z.object({ message: z.string() }),
      additionalContext: {
        prompt: responsePrompt,
        goalDescription,
        responseType,
      },
    });
    messageContent = result.message;
  } else {
    const responseMessage = await llmClient.sendMessage(
      [{ role: "user", content: responsePrompt }],
      { temperature: 0, model_tier: 'main' }
    );
    messageContent = responseMessage.content.trim();
  }

  return {
    type: responseType,
    message: messageContent,
    accepted: responseType === "accept" || responseType === "flag_as_ambitious",
    initial_confidence: initialConfidence,
    ...(counterProposal ? { counter_proposal: counterProposal } : {}),
    ...(ethicsFlags ? { flags: ethicsFlags } : {}),
  };
}

// ─── estimateChangeRate ───

export function estimateChangeRate(dimension: Dimension): number | null {
  const history = dimension.history;
  if (history.length < 2) return null;

  const numericEntries = history.filter(
    (h): h is typeof h & { value: number } => typeof h.value === "number"
  );
  if (numericEntries.length < 2) return null;

  const first = numericEntries[0]!;
  const last = numericEntries[numericEntries.length - 1]!;

  const timeDiffMs =
    new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime();
  const timeDiffDays = timeDiffMs / (1000 * 60 * 60 * 24);
  if (timeDiffDays <= 0) return null;

  return Math.abs(last.value - first.value) / timeDiffDays;
}
