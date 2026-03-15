import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StateManager } from "./state-manager.js";
import type { ILLMClient } from "./llm-client.js";
import { EthicsGate } from "./ethics-gate.js";
import { ObservationEngine } from "./observation-engine.js";
import { GoalSchema } from "./types/goal.js";
import type { Goal, Dimension } from "./types/goal.js";
import type { EthicsVerdict } from "./types/ethics.js";
import {
  DimensionDecompositionSchema,
  NegotiationLogSchema,
  FeasibilityResultSchema,
  CapabilityCheckLogSchema,
} from "./types/negotiation.js";
import type {
  DimensionDecomposition,
  FeasibilityResult,
  NegotiationLog,
  NegotiationResponse,
} from "./types/negotiation.js";
import type { CharacterConfig } from "./types/character.js";
import { DEFAULT_CHARACTER_CONFIG } from "./types/character.js";
import type { SatisficingJudge } from "./satisficing-judge.js";
import type { GoalTreeManager } from "./goal-tree-manager.js";
import type {
  GoalDecompositionConfig,
  DecompositionResult,
} from "./types/goal-tree.js";

// ─── Constants ───

const FEASIBILITY_RATIO_THRESHOLD_REALISTIC = 1.5;
// FEASIBILITY_RATIO_THRESHOLD_AMBITIOUS is now dynamic — see getFeasibilityThreshold()
const REALISTIC_TARGET_ACCELERATION_FACTOR = 1.3;
const DEFAULT_TIME_HORIZON_DAYS = 90;

// ─── Error class ───

export class EthicsRejectedError extends Error {
  constructor(public readonly verdict: EthicsVerdict) {
    super(`Goal rejected by ethics gate: ${verdict.reasoning}`);
    this.name = "EthicsRejectedError";
  }
}

// ─── Prompts ───

function buildDecompositionPrompt(
  description: string,
  constraints: string[],
  availableDataSources?: Array<{ name: string; dimensions: string[] }>
): string {
  const constraintsSection =
    constraints.length > 0
      ? `\nConstraints:\n${constraints.map((c) => `- ${c}`).join("\n")}`
      : "";

  const dataSourcesSection =
    availableDataSources && availableDataSources.length > 0
      ? `\nCRITICAL CONSTRAINT: If DataSource dimensions are listed below, you MUST use those exact dimension names as your dimension \`name\` fields. Do NOT invent new dimension names when DataSource dimensions are available. Map your conceptual dimensions to the closest matching DataSource dimension.\n\nAvailable Data Sources:\n${availableDataSources.map((ds) => `- "${ds.name}" provides: ${ds.dimensions.join(", ")}`).join("\n")}\n`
      : "";

  return `Decompose the following goal into measurable dimensions.

Goal: ${description}${constraintsSection}
${dataSourcesSection}
For each dimension, provide:
- name: a snake_case identifier (MUST match a DataSource dimension name if one is listed above)
- label: human-readable label
- threshold_type: one of "min", "max", "range", "present", "match"
- threshold_value: the target value (number, string, or boolean), or null if not yet determined
- observation_method_hint: how to measure this dimension

Return a JSON array of dimension objects. Example:
[
  {
    "name": "test_coverage",
    "label": "Test Coverage",
    "threshold_type": "min",
    "threshold_value": 80,
    "observation_method_hint": "Run test suite and check coverage report"
  }
]

Return ONLY a JSON array, no other text.`;
}

function buildFeasibilityPrompt(
  dimension: string,
  description: string,
  baselineValue: number | string | boolean | null,
  thresholdValue: number | string | boolean | (number | string)[] | null,
  timeHorizonDays: number
): string {
  return `Assess the feasibility of achieving this dimension target.

Dimension: ${dimension}
Goal context: ${description}
Current baseline: ${baselineValue === null ? "unknown" : String(baselineValue)}
Target value: ${thresholdValue === null ? "not yet determined" : String(thresholdValue)}
Time horizon: ${timeHorizonDays} days

Return a JSON object with:
{
  "assessment": "realistic" | "ambitious" | "infeasible",
  "confidence": "high" | "medium" | "low",
  "reasoning": "brief explanation",
  "key_assumptions": ["assumption1", ...],
  "main_risks": ["risk1", ...]
}

Return ONLY a JSON object, no other text.`;
}

function buildResponsePrompt(
  description: string,
  responseType: "accept" | "counter_propose" | "flag_as_ambitious",
  feasibilityResults: FeasibilityResult[],
  counterProposal?: { realistic_target: number; reasoning: string }
): string {
  const feasibilitySummary = feasibilityResults
    .map((r) => `- ${r.dimension}: ${r.assessment} (confidence: ${r.confidence})`)
    .join("\n");

  let instruction = "";
  if (responseType === "accept") {
    instruction = "Generate an encouraging acceptance message for the user.";
  } else if (responseType === "counter_propose") {
    instruction = `Generate a counter-proposal message. The realistic target is ${counterProposal?.realistic_target}. Reasoning: ${counterProposal?.reasoning}. Suggest this as a safer alternative.`;
  } else {
    instruction =
      "Generate a message flagging this goal as ambitious. List the risks and suggest the user review carefully.";
  }

  return `Goal: ${description}

Feasibility assessment:
${feasibilitySummary}

${instruction}

Return a brief, user-facing message (1-3 sentences). Return ONLY the message text, no JSON.`;
}

function buildCapabilityCheckPrompt(
  goalDescription: string,
  dimensions: DimensionDecomposition[],
  adapterCapabilities: Array<{ adapterType: string; capabilities: string[] }>
): string {
  const dimensionsList = dimensions
    .map((d) => `- ${d.name}: ${d.label} (threshold_type: ${d.threshold_type}, observation_hint: ${d.observation_method_hint})`)
    .join("\n");

  const capabilitiesList = adapterCapabilities
    .map((ac) => `- ${ac.adapterType}: ${ac.capabilities.join(", ")}`)
    .join("\n");

  return `You are assessing whether an agent can achieve each dimension of a goal given its available capabilities.

Goal: ${goalDescription}

Dimensions to achieve:
${dimensionsList}

Available adapter capabilities:
${capabilitiesList}

For each dimension that requires a capability NOT available in the listed adapters, report it as a gap.
Also indicate whether the missing capability is acquirable (i.e., can the agent learn or install it during execution).

Return a JSON object:
{
  "gaps": [
    {
      "dimension": "dimension_name",
      "required_capability": "capability_name",
      "acquirable": false,
      "reason": "brief explanation why this capability is missing and whether it can be acquired"
    }
  ]
}

If all dimensions can be achieved with the available capabilities, return { "gaps": [] }.
Return ONLY a JSON object, no other text.`;
}

function buildSubgoalDecompositionPrompt(parentGoal: Goal): string {
  const dimensionsList = parentGoal.dimensions
    .map((d) => `- ${d.label} (${d.name}): target=${JSON.stringify(d.threshold)}`)
    .join("\n");

  return `Break down this goal into actionable subgoals.

Goal: ${parentGoal.title}
Description: ${parentGoal.description}
Dimensions:
${dimensionsList}

For each subgoal, provide:
- title: a clear subgoal title
- description: what needs to be achieved
- dimensions: array of dimension decompositions (same format as goal dimensions)

Return a JSON array of subgoal objects:
[
  {
    "title": "Subgoal Title",
    "description": "What to achieve",
    "dimensions": [
      {
        "name": "dimension_name",
        "label": "Dimension Label",
        "threshold_type": "min",
        "threshold_value": 50,
        "observation_method_hint": "How to measure"
      }
    ]
  }
]

Return ONLY a JSON array, no other text.`;
}

// ─── Capability check schema for LLM parsing ───

const CapabilityCheckResultSchema = z.object({
  gaps: z.array(z.object({
    dimension: z.string(),
    required_capability: z.string(),
    acquirable: z.boolean(),
    reason: z.string(),
  })),
});

// ─── Subgoal schema for LLM parsing ───

const SubgoalLLMSchema = z.object({
  title: z.string(),
  description: z.string(),
  dimensions: z.array(DimensionDecompositionSchema),
});

const SubgoalListSchema = z.array(SubgoalLLMSchema);

// ─── Qualitative feasibility schema for LLM parsing ───

const QualitativeFeasibilitySchema = z.object({
  assessment: z.enum(["realistic", "ambitious", "infeasible"]),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string(),
  key_assumptions: z.array(z.string()),
  main_risks: z.array(z.string()),
});

// ─── Helper: convert DimensionDecomposition to Dimension ───

function decompositionToDimension(d: DimensionDecomposition): Dimension {
  const threshold = buildThreshold(d.threshold_type, d.threshold_value);
  return {
    name: d.name,
    label: d.label,
    current_value: null,
    threshold,
    confidence: 0,
    observation_method: {
      type: "llm_review",
      source: d.observation_method_hint,
      schedule: null,
      endpoint: null,
      confidence_tier: "self_report",
    },
    last_updated: null,
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok",
    dimension_mapping: null,
  };
}

function buildThreshold(
  thresholdType: "min" | "max" | "range" | "present" | "match",
  thresholdValue: number | string | boolean | (number | string)[] | null
): Dimension["threshold"] {
  switch (thresholdType) {
    case "min":
      return { type: "min", value: typeof thresholdValue === "number" ? thresholdValue : 0 };
    case "max":
      return { type: "max", value: typeof thresholdValue === "number" ? thresholdValue : 100 };
    case "range": {
      if (Array.isArray(thresholdValue)) {
        const low = typeof thresholdValue[0] === "number" ? thresholdValue[0] : 0;
        const high = typeof thresholdValue[1] === "number" ? thresholdValue[1] : 100;
        return { type: "range", low, high };
      }
      return { type: "range", low: 0, high: typeof thresholdValue === "number" ? thresholdValue : 100 };
    }
    case "present":
      return { type: "present" };
    case "match":
      return {
        type: "match",
        value:
          thresholdValue !== null && !Array.isArray(thresholdValue)
            ? (thresholdValue as string | number | boolean)
            : "",
      };
  }
}

// ─── GoalNegotiator ───

export class GoalNegotiator {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;
  private readonly ethicsGate: EthicsGate;
  private readonly observationEngine: ObservationEngine;
  private readonly characterConfig: CharacterConfig;
  private readonly satisficingJudge?: SatisficingJudge;
  private readonly goalTreeManager?: GoalTreeManager;
  private readonly adapterCapabilities?: Array<{ adapterType: string; capabilities: string[] }>;

  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    ethicsGate: EthicsGate,
    observationEngine: ObservationEngine,
    characterConfig?: CharacterConfig,
    satisficingJudge?: SatisficingJudge,  // Phase 2: auto-mapping proposals
    goalTreeManager?: GoalTreeManager,
    adapterCapabilities?: Array<{ adapterType: string; capabilities: string[] }>
  ) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
    this.ethicsGate = ethicsGate;
    this.observationEngine = observationEngine;
    this.characterConfig = characterConfig ?? DEFAULT_CHARACTER_CONFIG;
    this.satisficingJudge = satisficingJudge;
    this.goalTreeManager = goalTreeManager;
    this.adapterCapabilities = adapterCapabilities;
  }

  /**
   * Compute the feasibility ratio threshold for "ambitious" vs "infeasible".
   * Driven by caution_level (1=conservative/strict → 2.0, 5=ambitious → 4.0).
   * Formula: threshold = 1.5 + (caution_level * 0.5)
   */
  private getFeasibilityThreshold(): number {
    return 1.5 + this.characterConfig.caution_level * 0.5;
  }

  // ─── negotiate() — 6-step flow ───

  async negotiate(
    rawGoalDescription: string,
    options?: {
      deadline?: string;
      constraints?: string[];
      timeHorizonDays?: number;
    }
  ): Promise<{
    goal: Goal;
    response: NegotiationResponse;
    log: NegotiationLog;
  }> {
    const goalId = randomUUID();
    const deadline = options?.deadline ?? null;
    const constraints = options?.constraints ?? [];
    const timeHorizonDays = options?.timeHorizonDays ?? DEFAULT_TIME_HORIZON_DAYS;
    const now = new Date().toISOString();

    // Initialize negotiation log
    const log: NegotiationLog = NegotiationLogSchema.parse({
      goal_id: goalId,
      timestamp: now,
      is_renegotiation: false,
      renegotiation_trigger: null,
    });

    // Step 0: Ethics Gate
    const ethicsVerdict = await this.ethicsGate.check("goal", goalId, rawGoalDescription);

    if (ethicsVerdict.verdict === "reject") {
      throw new EthicsRejectedError(ethicsVerdict);
    }

    const ethicsFlags =
      ethicsVerdict.verdict === "flag" ? ethicsVerdict.risks : undefined;

    // Step 1: Goal Intake
    // (parsed from options above)

    // Step 2: Dimension Decomposition (LLM)
    const availableDataSources = this.observationEngine.getAvailableDimensionInfo();
    const decompositionPrompt = buildDecompositionPrompt(rawGoalDescription, constraints, availableDataSources);
    const decompositionResponse = await this.llmClient.sendMessage(
      [{ role: "user", content: decompositionPrompt }],
      { temperature: 0 }
    );

    const dimensions = this.llmClient.parseJSON(
      decompositionResponse.content,
      z.array(DimensionDecompositionSchema)
    );

    // Post-process: map dimension names to DataSource dimensions when similar
    if (availableDataSources.length > 0) {
      const allDsNames = availableDataSources.flatMap(ds => ds.dimensions);
      for (const dim of dimensions) {
        if (!allDsNames.includes(dim.name)) {
          // Try to find a similar DataSource dimension
          const match = findBestDimensionMatch(dim.name, allDsNames);
          if (match) {
            dim.name = match;
          }
        }
      }
    }

    log.step2_decomposition = {
      dimensions,
      method: "llm",
    };

    // Step 3: Baseline Observation
    const baselineObservations: Array<{
      dimension: string;
      value: number | string | boolean | null;
      confidence: number;
      method: string;
    }> = [];

    for (const dim of dimensions) {
      // For new goals, we don't have observation setup yet
      // Record null baseline with 0 confidence
      baselineObservations.push({
        dimension: dim.name,
        value: null,
        confidence: 0,
        method: "initial_baseline",
      });
    }

    log.step3_baseline = { observations: baselineObservations };

    // Step 4: Feasibility Evaluation (Hybrid)
    const feasibilityResults: FeasibilityResult[] = [];
    let overallPath: "quantitative" | "qualitative" | "hybrid" = "qualitative";

    for (const dim of dimensions) {
      const baseline = baselineObservations.find((o) => o.dimension === dim.name);
      const baselineValue = baseline?.value ?? null;

      // Determine feasibility path
      if (
        typeof baselineValue === "number" &&
        typeof dim.threshold_value === "number"
      ) {
        // Quantitative path
        overallPath = overallPath === "qualitative" ? "hybrid" : overallPath;

        // No observed_change_rate available for new goals, fallback to qualitative
        const result = await this.evaluateQualitatively(
          dim.name,
          rawGoalDescription,
          baselineValue,
          dim.threshold_value,
          timeHorizonDays
        );
        feasibilityResults.push(result);
      } else {
        // Qualitative path (LLM assessment)
        const result = await this.evaluateQualitatively(
          dim.name,
          rawGoalDescription,
          baselineValue,
          dim.threshold_value,
          timeHorizonDays
        );
        feasibilityResults.push(result);
      }
    }

    log.step4_evaluation = {
      path: overallPath,
      dimensions: feasibilityResults,
    };

    // Step 4b: Capability Check
    if (this.adapterCapabilities && this.adapterCapabilities.length > 0) {
      try {
        const capCheckPrompt = buildCapabilityCheckPrompt(
          rawGoalDescription,
          dimensions,
          this.adapterCapabilities
        );
        const capCheckResponse = await this.llmClient.sendMessage(
          [{ role: "user", content: capCheckPrompt }],
          { temperature: 0 }
        );
        const capCheckResult = this.llmClient.parseJSON(
          capCheckResponse.content,
          CapabilityCheckResultSchema
        );

        const allCapabilities = this.adapterCapabilities.flatMap((ac) => ac.capabilities);
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
        // Non-critical: capability check failure should not block negotiation
        console.warn("[GoalNegotiator] Step 4b capability check failed, continuing without it");
      }
    }

    // Step 5: Response Generation
    const { responseType, counterProposal, initialConfidence } =
      this.determineResponseType(feasibilityResults, baselineObservations, timeHorizonDays);

    // Generate user-facing message via LLM
    const responsePrompt = buildResponsePrompt(
      rawGoalDescription,
      responseType,
      feasibilityResults,
      counterProposal
    );
    const responseMessage = await this.llmClient.sendMessage(
      [{ role: "user", content: responsePrompt }],
      { temperature: 0 }
    );

    const negotiationResponse: NegotiationResponse = {
      type: responseType,
      message: responseMessage.content.trim(),
      accepted: responseType === "accept" || responseType === "flag_as_ambitious",
      initial_confidence: initialConfidence,
      ...(counterProposal ? { counter_proposal: counterProposal } : {}),
      ...(ethicsFlags ? { flags: ethicsFlags } : {}),
    };

    log.step5_response = {
      type: responseType,
      accepted: negotiationResponse.accepted,
      initial_confidence: initialConfidence,
      user_acknowledged: false,
      counter_proposal: counterProposal
        ? {
            realistic_target: counterProposal.realistic_target,
            reasoning: counterProposal.reasoning,
            alternatives: counterProposal.alternatives,
          }
        : null,
    };

    // Build Goal object
    const goalDimensions = dimensions.map(decompositionToDimension);
    const goal = GoalSchema.parse({
      id: goalId,
      parent_id: null,
      node_type: "goal",
      title: rawGoalDescription,
      description: rawGoalDescription,
      status: "active",
      dimensions: goalDimensions,
      gap_aggregation: "max",
      dimension_mapping: null,
      constraints,
      children_ids: [],
      target_date: null,
      origin: "negotiation",
      pace_snapshot: null,
      deadline,
      confidence_flag: initialConfidence === "low" ? "low" : initialConfidence === "medium" ? "medium" : "high",
      user_override: false,
      feasibility_note:
        responseType === "counter_propose"
          ? `Counter-proposal: target=${counterProposal?.realistic_target}`
          : null,
      uncertainty_weight: 1.0,
      created_at: now,
      updated_at: now,
    });

    // Persist
    this.stateManager.saveGoal(goal);
    this.saveNegotiationLog(goalId, log);

    return { goal, response: negotiationResponse, log };
  }

  // ─── decompose() ───

  async decompose(
    goalId: string,
    parentGoal: Goal
  ): Promise<{
    subgoals: Goal[];
    rejectedSubgoals: Array<{ description: string; reason: string }>;
  }> {
    // Step 1: LLM generates subgoals
    const prompt = buildSubgoalDecompositionPrompt(parentGoal);
    const response = await this.llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      { temperature: 0 }
    );

    const subgoalSpecs = this.llmClient.parseJSON(response.content, SubgoalListSchema);

    const subgoals: Goal[] = [];
    const rejectedSubgoals: Array<{ description: string; reason: string }> = [];
    let hasCriticalRejection = false;

    // Step 2: Ethics check each subgoal
    for (const spec of subgoalSpecs) {
      const subgoalId = randomUUID();
      const verdict = await this.ethicsGate.check(
        "subgoal",
        subgoalId,
        spec.description,
        `Parent goal: ${parentGoal.title}`
      );

      if (verdict.verdict === "reject") {
        rejectedSubgoals.push({
          description: spec.title,
          reason: verdict.reasoning,
        });
        hasCriticalRejection = true;
        continue;
      }

      const now = new Date().toISOString();
      const dimensions = spec.dimensions.map(decompositionToDimension);

      const subgoal = GoalSchema.parse({
        id: subgoalId,
        parent_id: goalId,
        node_type: "subgoal",
        title: spec.title,
        description: spec.description,
        status: "active",
        dimensions,
        gap_aggregation: "max",
        dimension_mapping: null,
        constraints: [],
        children_ids: [],
        target_date: null,
        origin: "decomposition",
        pace_snapshot: null,
        deadline: null,
        confidence_flag: verdict.verdict === "flag" ? "medium" : "high",
        user_override: false,
        feasibility_note: null,
        uncertainty_weight: 1.0,
        created_at: now,
        updated_at: now,
      });

      subgoals.push(subgoal);
      this.stateManager.saveGoal(subgoal);
    }

    // Phase 2: Auto-propose dimension mappings
    if (this.satisficingJudge) {
      for (const subgoal of subgoals) {
        try {
          const proposals = await this.satisficingJudge.proposeDimensionMapping(
            subgoal.dimensions.map(d => ({ name: d.name })),
            parentGoal.dimensions.map(d => ({ name: d.name }))
          );
          // Apply proposals to subgoal dimensions that don't already have mappings
          for (const proposal of proposals) {
            const dim = subgoal.dimensions.find(d => d.name === proposal.subgoal_dimension);
            if (dim && !dim.dimension_mapping) {
              dim.dimension_mapping = {
                parent_dimension: proposal.parent_dimension,
                aggregation: proposal.suggested_aggregation,
              };
            }
          }
          if (proposals.length > 0) {
            await this.stateManager.saveGoal(subgoal);
          }
        } catch {
          // Non-critical: auto-mapping failure should not block decomposition
        }
      }
    }

    // Step 4: If critical subgoal rejected, warn (but still return what we can)
    if (hasCriticalRejection && subgoals.length === 0) {
      // All subgoals rejected — caller should consider rejecting parent goal
    }

    return { subgoals, rejectedSubgoals };
  }

  // ─── renegotiate() ───

  async renegotiate(
    goalId: string,
    trigger: "stall" | "new_info" | "user_request",
    context?: string
  ): Promise<{
    goal: Goal;
    response: NegotiationResponse;
    log: NegotiationLog;
  }> {
    const existingGoal = this.stateManager.loadGoal(goalId);
    if (existingGoal === null) {
      throw new Error(`renegotiate: goal "${goalId}" not found`);
    }

    const now = new Date().toISOString();

    // Initialize renegotiation log
    const log: NegotiationLog = NegotiationLogSchema.parse({
      goal_id: goalId,
      timestamp: now,
      is_renegotiation: true,
      renegotiation_trigger: trigger,
    });

    // Step 0: Ethics re-check
    const ethicsVerdict = await this.ethicsGate.check(
      "goal",
      goalId,
      existingGoal.description,
      context
    );

    if (ethicsVerdict.verdict === "reject") {
      throw new EthicsRejectedError(ethicsVerdict);
    }

    const ethicsFlags =
      ethicsVerdict.verdict === "flag" ? ethicsVerdict.risks : undefined;

    // Step 2: Re-decompose dimensions (LLM) using existing goal + context
    const availableDataSources = this.observationEngine.getAvailableDimensionInfo();
    const redecompPrompt = buildDecompositionPrompt(
      `${existingGoal.description}${context ? ` (Renegotiation context: ${context})` : ""}`,
      existingGoal.constraints,
      availableDataSources
    );
    const decompositionResponse = await this.llmClient.sendMessage(
      [{ role: "user", content: redecompPrompt }],
      { temperature: 0 }
    );

    const dimensions = this.llmClient.parseJSON(
      decompositionResponse.content,
      z.array(DimensionDecompositionSchema)
    );

    // Post-process: map dimension names to DataSource dimensions when similar
    if (availableDataSources.length > 0) {
      const allDsNames = availableDataSources.flatMap(ds => ds.dimensions);
      for (const dim of dimensions) {
        if (!allDsNames.includes(dim.name)) {
          // Try to find a similar DataSource dimension
          const match = findBestDimensionMatch(dim.name, allDsNames);
          if (match) {
            dim.name = match;
          }
        }
      }
    }

    log.step2_decomposition = { dimensions, method: "llm" };

    // Step 3: Baseline from existing goal state
    const baselineObservations = dimensions.map((dim) => {
      const existingDim = existingGoal.dimensions.find((d) => d.name === dim.name);
      return {
        dimension: dim.name,
        value: existingDim?.current_value ?? null,
        confidence: existingDim?.confidence ?? 0,
        method: "existing_observation",
      };
    });

    log.step3_baseline = { observations: baselineObservations };

    // Step 4: Feasibility re-evaluation
    const feasibilityResults: FeasibilityResult[] = [];
    const timeHorizonDays = DEFAULT_TIME_HORIZON_DAYS;

    for (const dim of dimensions) {
      const baseline = baselineObservations.find((o) => o.dimension === dim.name);
      const baselineValue = baseline?.value ?? null;

      // Check for quantitative path with change rate from history
      const existingDim = existingGoal.dimensions.find((d) => d.name === dim.name);
      const changeRate = existingDim ? this.estimateChangeRate(existingDim) : null;

      if (
        typeof baselineValue === "number" &&
        typeof dim.threshold_value === "number" &&
        changeRate !== null &&
        changeRate > 0
      ) {
        // Quantitative path
        const necessaryChangeRate =
          Math.abs(dim.threshold_value - baselineValue) / timeHorizonDays;
        const feasibilityRatio = necessaryChangeRate / changeRate;

        let assessment: "realistic" | "ambitious" | "infeasible";
        if (feasibilityRatio <= FEASIBILITY_RATIO_THRESHOLD_REALISTIC) {
          assessment = "realistic";
        } else if (feasibilityRatio <= this.getFeasibilityThreshold()) {
          assessment = "ambitious";
        } else {
          assessment = "infeasible";
        }

        feasibilityResults.push(
          FeasibilityResultSchema.parse({
            dimension: dim.name,
            path: "quantitative",
            feasibility_ratio: feasibilityRatio,
            assessment,
            confidence: assessment === "realistic" ? "high" : assessment === "ambitious" ? "medium" : "low",
            reasoning: `Feasibility ratio: ${feasibilityRatio.toFixed(2)}`,
            key_assumptions: [`Change rate: ${changeRate.toFixed(4)}/day`],
            main_risks: assessment === "infeasible" ? ["Target may be unreachable in time horizon"] : [],
          })
        );
      } else {
        // Qualitative fallback
        const result = await this.evaluateQualitatively(
          dim.name,
          existingGoal.description,
          baselineValue,
          dim.threshold_value,
          timeHorizonDays
        );
        feasibilityResults.push(result);
      }
    }

    log.step4_evaluation = {
      path: feasibilityResults.some((r) => r.path === "quantitative") ? "hybrid" : "qualitative",
      dimensions: feasibilityResults,
    };

    // Step 4b: Capability Check
    if (this.adapterCapabilities && this.adapterCapabilities.length > 0) {
      try {
        const capCheckPrompt = buildCapabilityCheckPrompt(
          existingGoal.description,
          dimensions,
          this.adapterCapabilities
        );
        const capCheckResponse = await this.llmClient.sendMessage(
          [{ role: "user", content: capCheckPrompt }],
          { temperature: 0 }
        );
        const capCheckResult = this.llmClient.parseJSON(
          capCheckResponse.content,
          CapabilityCheckResultSchema
        );

        const allCapabilities = this.adapterCapabilities.flatMap((ac) => ac.capabilities);
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
        // Non-critical: capability check failure should not block renegotiation
        console.warn("[GoalNegotiator] Step 4b capability check failed, continuing without it");
      }
    }

    // Step 5: Response generation
    const { responseType, counterProposal, initialConfidence } =
      this.determineResponseType(feasibilityResults, baselineObservations, timeHorizonDays);

    const responsePrompt = buildResponsePrompt(
      existingGoal.description,
      responseType,
      feasibilityResults,
      counterProposal
    );
    const responseMessage = await this.llmClient.sendMessage(
      [{ role: "user", content: responsePrompt }],
      { temperature: 0 }
    );

    const negotiationResponse: NegotiationResponse = {
      type: responseType,
      message: responseMessage.content.trim(),
      accepted: responseType === "accept" || responseType === "flag_as_ambitious",
      initial_confidence: initialConfidence,
      ...(counterProposal ? { counter_proposal: counterProposal } : {}),
      ...(ethicsFlags ? { flags: ethicsFlags } : {}),
    };

    log.step5_response = {
      type: responseType,
      accepted: negotiationResponse.accepted,
      initial_confidence: initialConfidence,
      user_acknowledged: false,
      counter_proposal: counterProposal
        ? {
            realistic_target: counterProposal.realistic_target,
            reasoning: counterProposal.reasoning,
            alternatives: counterProposal.alternatives,
          }
        : null,
    };

    // Update goal
    const goalDimensions = dimensions.map(decompositionToDimension);
    const updatedGoal = GoalSchema.parse({
      ...existingGoal,
      dimensions: goalDimensions,
      confidence_flag: initialConfidence === "low" ? "low" : initialConfidence === "medium" ? "medium" : "high",
      feasibility_note:
        responseType === "counter_propose"
          ? `Renegotiation counter-proposal: target=${counterProposal?.realistic_target}`
          : null,
      updated_at: now,
    });

    this.stateManager.saveGoal(updatedGoal);
    this.saveNegotiationLog(goalId, log);

    return { goal: updatedGoal, response: negotiationResponse, log };
  }

  // ─── decomposeIntoSubgoals() ───

  /**
   * Decompose a negotiated goal into subgoals using GoalTreeManager.
   * For depth >= 2, skip negotiation and auto-accept.
   * Returns null if goalTreeManager is not injected.
   */
  async decomposeIntoSubgoals(
    goalId: string,
    config?: GoalDecompositionConfig
  ): Promise<DecompositionResult | null> {
    if (this.goalTreeManager === undefined) {
      return null;
    }

    const goal = this.stateManager.loadGoal(goalId);
    if (!goal) {
      return null;
    }

    const resolvedConfig: GoalDecompositionConfig = config ?? {
      max_depth: 5,
      min_specificity: 0.7,
      auto_prune_threshold: 0.3,
      parallel_loop_limit: 3,
    };

    return this.goalTreeManager.decomposeGoal(goalId, resolvedConfig);
  }

  // ─── getNegotiationLog() ───

  getNegotiationLog(goalId: string): NegotiationLog | null {
    const raw = this.stateManager.readRaw(`goals/${goalId}/negotiation-log.json`);
    if (raw === null) return null;
    return NegotiationLogSchema.parse(raw);
  }

  // ─── Private helpers ───

  private saveNegotiationLog(goalId: string, log: NegotiationLog): void {
    const parsed = NegotiationLogSchema.parse(log);
    this.stateManager.writeRaw(`goals/${goalId}/negotiation-log.json`, parsed);
  }

  private async evaluateQualitatively(
    dimensionName: string,
    goalDescription: string,
    baselineValue: number | string | boolean | null,
    thresholdValue: number | string | boolean | (number | string)[] | null,
    timeHorizonDays: number
  ): Promise<FeasibilityResult> {
    const prompt = buildFeasibilityPrompt(
      dimensionName,
      goalDescription,
      baselineValue,
      thresholdValue,
      timeHorizonDays
    );

    const response = await this.llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      { temperature: 0 }
    );

    try {
      const parsed = this.llmClient.parseJSON(
        response.content,
        QualitativeFeasibilitySchema
      );

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
      // Conservative fallback on parse failure
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

  private determineResponseType(
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
      // Find the first infeasible dimension to build counter-proposal
      const infeasible = feasibilityResults.find((r) => r.assessment === "infeasible")!;
      const baseline = baselineObservations.find((o) => o.dimension === infeasible.dimension);
      const baselineValue = typeof baseline?.value === "number" ? baseline.value : 0;

      // Calculate realistic target
      // If we have a feasibility_ratio, we can compute a change rate
      // realistic_target = baseline + (observed_change_rate * timeHorizonDays * 1.3)
      // Since observed_change_rate = necessary_change_rate / feasibility_ratio
      // and necessary_change_rate = |target - baseline| / timeHorizonDays
      // realistic_target = baseline + (|target - baseline| / feasibility_ratio) * 1.3
      let realisticTarget: number;
      if (infeasible.feasibility_ratio !== null && infeasible.feasibility_ratio > 0) {
        const gap = infeasible.feasibility_ratio > 0
          ? (timeHorizonDays * REALISTIC_TARGET_ACCELERATION_FACTOR) / infeasible.feasibility_ratio
          : 0;
        // Actually: observed_change_rate = necessary_rate / ratio
        // necessary_rate = |target - baseline| / timeHorizon
        // observed * timeHorizon * 1.3 = (necessary_rate / ratio) * timeHorizon * 1.3
        //   = (|target - baseline| / ratio) * 1.3
        // Not exactly right without knowing the target. Let's use a simpler formula.
        // From the spec: realistic_target = baseline + (observed_change_rate * timeHorizonDays * 1.3)
        // observed_change_rate is not available for new goals. Use qualitative fallback.
        realisticTarget = baselineValue;
      } else {
        realisticTarget = baselineValue;
      }

      return {
        responseType: "counter_propose",
        counterProposal: {
          realistic_target: realisticTarget,
          reasoning: infeasible.reasoning,
          alternatives: infeasible.main_risks.length > 0
            ? [`Address risks: ${infeasible.main_risks.join(", ")}`]
            : ["Consider reducing scope or extending timeline"],
        },
        initialConfidence: "low",
      };
    }

    if (hasLowConfidence && allRealisticOrAmbitious) {
      return {
        responseType: "flag_as_ambitious",
        initialConfidence: "low",
      };
    }

    if (allRealisticOrAmbitious) {
      return {
        responseType: "accept",
        initialConfidence,
      };
    }

    return {
      responseType: "accept",
      initialConfidence,
    };
  }

  /**
   * Estimate daily change rate from dimension history.
   * Returns null if insufficient data.
   */
  private estimateChangeRate(dimension: Dimension): number | null {
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

  /**
   * Calculate counter-proposal target given baseline, change rate, and time horizon.
   * Uses acceleration factor from character.md.
   */
  static calculateRealisticTarget(
    baseline: number,
    changeRate: number,
    timeHorizonDays: number
  ): number {
    return baseline + changeRate * timeHorizonDays * REALISTIC_TARGET_ACCELERATION_FACTOR;
  }
}

/**
 * Find the best matching DataSource dimension name for a given dimension name.
 * Uses simple keyword overlap matching.
 */
function findBestDimensionMatch(name: string, candidates: string[]): string | null {
  const nameTokens = name.toLowerCase().split(/[_\s-]+/);
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const candidateTokens = candidate.toLowerCase().split(/[_\s-]+/);
    // Count overlapping tokens
    const overlap = nameTokens.filter(t => candidateTokens.includes(t)).length;
    const score = overlap / Math.max(nameTokens.length, candidateTokens.length);
    if (score > bestScore && score >= 0.3) {  // At least 30% token overlap
      bestScore = score;
      bestMatch = candidate;
    }
  }

  return bestMatch;
}
