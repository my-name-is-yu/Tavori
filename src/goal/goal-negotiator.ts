import { randomUUID } from "node:crypto";
import type { StateManager } from "../state/state-manager.js";
import type { ILLMClient } from "../llm/llm-client.js";
import { EthicsGate } from "../traits/ethics-gate.js";
import { ObservationEngine } from "../observation/observation-engine.js";
import { GoalSchema } from "../types/goal.js";
import type { Goal } from "../types/goal.js";
import {
  NegotiationLogSchema,
  FeasibilityResultSchema,
} from "../types/negotiation.js";
import type {
  FeasibilityResult,
  NegotiationLog,
  NegotiationResponse,
} from "../types/negotiation.js";
import type { CharacterConfig } from "../types/character.js";
import { DEFAULT_CHARACTER_CONFIG } from "../types/character.js";
import type { SatisficingJudge } from "../drive/satisficing-judge.js";
import type { GoalTreeManager } from "./goal-tree-manager.js";
import type {
  GoalDecompositionConfig,
  DecompositionResult,
} from "../types/goal-tree.js";
import type { CapabilityDetector } from "../observation/capability-detector.js";
import { decompositionToDimension } from "./goal-validation.js";
import {
  decompose as decomposeImpl,
  decomposeIntoSubgoals as decomposeIntoSubgoalsImpl,
} from "./goal-decomposer.js";
import { suggestGoals as suggestGoalsImpl } from "./goal-suggest.js";
import { EthicsRejectedError } from "./negotiator-context.js";
export { gatherNegotiationContext, EthicsRejectedError } from "./negotiator-context.js";
export type { GoalSuggestion } from "./goal-suggest.js";
import {
  DEFAULT_TIME_HORIZON_DAYS,
  REALISTIC_TARGET_ACCELERATION_FACTOR,
  FEASIBILITY_RATIO_THRESHOLD_REALISTIC,
  getFeasibilityThreshold,
  runDecompositionStep,
  buildInitialBaseline,
  buildRenegotiationBaseline,
  evaluateQualitatively,
  runCapabilityCheckStep,
  determineResponseType,
  buildNegotiationResponse,
  estimateChangeRate,
} from "./negotiator-steps.js";

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
    satisficingJudge?: SatisficingJudge,
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

  // ─── negotiate() ───

  /**
   * @deprecated For new goals, use {@link GoalRefiner.refine} instead.
   * This method remains available for renegotiation of existing goals with prior observations.
   */
  async negotiate(
    rawGoalDescription: string,
    options?: {
      deadline?: string;
      constraints?: string[];
      timeHorizonDays?: number;
      workspaceContext?: string;
      timeoutMs?: number;
    }
  ): Promise<{ goal: Goal; response: NegotiationResponse; log: NegotiationLog }> {
    const timeoutMs = options?.timeoutMs ?? 120_000;
    let handle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      handle = setTimeout(
        () => reject(new Error(`Goal negotiation timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    try {
      return await Promise.race([this._negotiate(rawGoalDescription, options), timeoutPromise]);
    } finally {
      clearTimeout(handle!);
    }
  }

  private async _negotiate(
    rawGoalDescription: string,
    options?: {
      deadline?: string;
      constraints?: string[];
      timeHorizonDays?: number;
      workspaceContext?: string;
    }
  ): Promise<{ goal: Goal; response: NegotiationResponse; log: NegotiationLog }> {
    const goalId = randomUUID();
    const deadline = options?.deadline ?? null;
    const constraints = options?.constraints ?? [];
    const timeHorizonDays = options?.timeHorizonDays ?? DEFAULT_TIME_HORIZON_DAYS;
    const now = new Date().toISOString();

    const log: NegotiationLog = NegotiationLogSchema.parse({
      goal_id: goalId,
      timestamp: now,
      is_renegotiation: false,
      renegotiation_trigger: null,
    });

    // Step 0: Ethics Gate
    const ethicsVerdict = await this.ethicsGate.check("goal", goalId, rawGoalDescription);
    if (ethicsVerdict.verdict === "reject") throw new EthicsRejectedError(ethicsVerdict);
    const ethicsFlags = ethicsVerdict.verdict === "flag" ? ethicsVerdict.risks : undefined;

    // Step 2: Dimension Decomposition
    const { dimensions } = await runDecompositionStep(
      rawGoalDescription,
      constraints,
      this.observationEngine,
      this.llmClient,
      options?.workspaceContext
    );
    log.step2_decomposition = { dimensions, method: "llm" };

    // Step 3: Initial Baseline
    const baselineObservations = buildInitialBaseline(dimensions);
    log.step3_baseline = { observations: baselineObservations };

    // Step 4: Feasibility Evaluation (parallelized — dimensions are independent)
    const feasibilityResults: FeasibilityResult[] = (
      await Promise.allSettled(
        dimensions.map((dim) => {
          const baseline = baselineObservations.find((o) => o.dimension === dim.name);
          return evaluateQualitatively(
            this.llmClient,
            dim.name,
            rawGoalDescription,
            baseline?.value ?? null,
            dim.threshold_value,
            timeHorizonDays
          );
        })
      )
    ).map((result, i) => {
      if (result.status === "fulfilled") return result.value;
      return {
        dimension: dimensions[i]!.name,
        path: "qualitative" as const,
        feasibility_ratio: null,
        assessment: "ambitious" as const,
        confidence: "low" as const,
        reasoning: `Evaluation failed: ${result.reason?.message ?? "unknown error"}`,
        key_assumptions: [],
        main_risks: [],
      };
    });
    log.step4_evaluation = { path: "qualitative", dimensions: feasibilityResults };

    // Step 4b: Capability Check
    if (this.adapterCapabilities && this.adapterCapabilities.length > 0) {
      await runCapabilityCheckStep(
        this.llmClient,
        rawGoalDescription,
        dimensions,
        this.adapterCapabilities,
        feasibilityResults,
        log
      );
    }

    // Step 5: Response
    const { responseType, counterProposal, initialConfidence } = determineResponseType(
      feasibilityResults,
      baselineObservations,
      timeHorizonDays
    );
    const negotiationResponse = await buildNegotiationResponse(
      this.llmClient,
      rawGoalDescription,
      responseType,
      feasibilityResults,
      counterProposal,
      ethicsFlags,
      initialConfidence
    );

    log.step5_response = {
      type: responseType,
      accepted: negotiationResponse.accepted,
      initial_confidence: initialConfidence,
      user_acknowledged: false,
      counter_proposal: counterProposal
        ? { realistic_target: counterProposal.realistic_target, reasoning: counterProposal.reasoning, alternatives: counterProposal.alternatives }
        : null,
    };

    // Build & persist Goal
    const goal = GoalSchema.parse({
      id: goalId,
      parent_id: null,
      node_type: "goal",
      title: rawGoalDescription,
      description: rawGoalDescription,
      status: "active",
      dimensions: dimensions.map(decompositionToDimension),
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

    await this.stateManager.saveGoal(goal);
    await this.saveNegotiationLog(goalId, log);

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
    return decomposeImpl(goalId, parentGoal, {
      stateManager: this.stateManager,
      llmClient: this.llmClient,
      ethicsGate: this.ethicsGate,
      satisficingJudge: this.satisficingJudge,
      goalTreeManager: this.goalTreeManager,
    });
  }

  // ─── renegotiate() ───

  async renegotiate(
    goalId: string,
    trigger: "stall" | "new_info" | "user_request",
    context?: string
  ): Promise<{ goal: Goal; response: NegotiationResponse; log: NegotiationLog }> {
    const existingGoal = await this.stateManager.loadGoal(goalId);
    if (existingGoal === null) throw new Error(`renegotiate: goal "${goalId}" not found`);

    const now = new Date().toISOString();
    const timeHorizonDays = DEFAULT_TIME_HORIZON_DAYS;

    const log: NegotiationLog = NegotiationLogSchema.parse({
      goal_id: goalId,
      timestamp: now,
      is_renegotiation: true,
      renegotiation_trigger: trigger,
    });

    // Step 0: Ethics re-check
    const ethicsVerdict = await this.ethicsGate.check("goal", goalId, existingGoal.description, context);
    if (ethicsVerdict.verdict === "reject") throw new EthicsRejectedError(ethicsVerdict);
    const ethicsFlags = ethicsVerdict.verdict === "flag" ? ethicsVerdict.risks : undefined;

    // Step 2: Re-decompose
    const goalDesc = `${existingGoal.description}${context ? ` (Renegotiation context: ${context})` : ""}`;
    const { dimensions } = await runDecompositionStep(
      goalDesc,
      existingGoal.constraints,
      this.observationEngine,
      this.llmClient
    );
    log.step2_decomposition = { dimensions, method: "llm" };

    // Step 3: Baseline from existing state
    const baselineObservations = buildRenegotiationBaseline(dimensions, existingGoal.dimensions);
    log.step3_baseline = { observations: baselineObservations };

    // Step 4: Feasibility re-evaluation (parallelized — dimensions are independent)
    const feasibilityResults: FeasibilityResult[] = (
      await Promise.allSettled(
        dimensions.map(async (dim) => {
          const baseline = baselineObservations.find((o) => o.dimension === dim.name);
          const baselineValue = baseline?.value ?? null;
          const existingDim = existingGoal.dimensions.find((d) => d.name === dim.name);
          const changeRate = existingDim ? estimateChangeRate(existingDim) : null;

          if (
            typeof baselineValue === "number" &&
            typeof dim.threshold_value === "number" &&
            changeRate !== null &&
            changeRate > 0
          ) {
            const necessaryChangeRate = Math.abs(dim.threshold_value - baselineValue) / timeHorizonDays;
            const feasibilityRatio = necessaryChangeRate / changeRate;

            let assessment: "realistic" | "ambitious" | "infeasible";
            if (feasibilityRatio <= FEASIBILITY_RATIO_THRESHOLD_REALISTIC) {
              assessment = "realistic";
            } else if (feasibilityRatio <= getFeasibilityThreshold(this.characterConfig)) {
              assessment = "ambitious";
            } else {
              assessment = "infeasible";
            }

            return FeasibilityResultSchema.parse({
              dimension: dim.name,
              path: "quantitative",
              feasibility_ratio: feasibilityRatio,
              assessment,
              confidence: assessment === "realistic" ? "high" : assessment === "ambitious" ? "medium" : "low",
              reasoning: `Feasibility ratio: ${feasibilityRatio.toFixed(2)}`,
              key_assumptions: [`Change rate: ${changeRate.toFixed(4)}/day`],
              main_risks: assessment === "infeasible" ? ["Target may be unreachable in time horizon"] : [],
            });
          } else {
            return evaluateQualitatively(
              this.llmClient,
              dim.name,
              existingGoal.description,
              baselineValue,
              dim.threshold_value,
              timeHorizonDays
            );
          }
        })
      )
    ).map((result, i) => {
      if (result.status === "fulfilled") return result.value;
      return {
        dimension: dimensions[i]!.name,
        path: "qualitative" as const,
        feasibility_ratio: null,
        assessment: "ambitious" as const,
        confidence: "low" as const,
        reasoning: `Evaluation failed: ${result.reason?.message ?? "unknown error"}`,
        key_assumptions: [],
        main_risks: [],
      };
    });

    log.step4_evaluation = {
      path: feasibilityResults.some((r) => r.path === "quantitative") ? "hybrid" : "qualitative",
      dimensions: feasibilityResults,
    };

    // Step 4b: Capability Check
    if (this.adapterCapabilities && this.adapterCapabilities.length > 0) {
      await runCapabilityCheckStep(
        this.llmClient,
        existingGoal.description,
        dimensions,
        this.adapterCapabilities,
        feasibilityResults,
        log
      );
    }

    // Step 5: Response
    const { responseType, counterProposal, initialConfidence } = determineResponseType(
      feasibilityResults,
      baselineObservations,
      timeHorizonDays
    );
    const negotiationResponse = await buildNegotiationResponse(
      this.llmClient,
      existingGoal.description,
      responseType,
      feasibilityResults,
      counterProposal,
      ethicsFlags,
      initialConfidence
    );

    log.step5_response = {
      type: responseType,
      accepted: negotiationResponse.accepted,
      initial_confidence: initialConfidence,
      user_acknowledged: false,
      counter_proposal: counterProposal
        ? { realistic_target: counterProposal.realistic_target, reasoning: counterProposal.reasoning, alternatives: counterProposal.alternatives }
        : null,
    };

    // Update & persist Goal
    const updatedGoal = GoalSchema.parse({
      ...existingGoal,
      dimensions: dimensions.map(decompositionToDimension),
      confidence_flag: initialConfidence === "low" ? "low" : initialConfidence === "medium" ? "medium" : "high",
      feasibility_note:
        responseType === "counter_propose"
          ? `Renegotiation counter-proposal: target=${counterProposal?.realistic_target}`
          : null,
      updated_at: now,
    });

    await this.stateManager.saveGoal(updatedGoal);
    await this.saveNegotiationLog(goalId, log);

    return { goal: updatedGoal, response: negotiationResponse, log };
  }

  // ─── decomposeIntoSubgoals() ───

  async decomposeIntoSubgoals(
    goalId: string,
    config?: GoalDecompositionConfig
  ): Promise<DecompositionResult | null> {
    return decomposeIntoSubgoalsImpl(
      goalId,
      {
        stateManager: this.stateManager,
        llmClient: this.llmClient,
        ethicsGate: this.ethicsGate,
        satisficingJudge: this.satisficingJudge,
        goalTreeManager: this.goalTreeManager,
      },
      config
    );
  }

  // ─── suggestGoals() ───

  async suggestGoals(
    context: string,
    options?: {
      maxSuggestions?: number;
      existingGoals?: string[];
      repoPath?: string;
      capabilityDetector?: CapabilityDetector;
    }
  ): Promise<import("./goal-suggest.js").GoalSuggestion[]> {
    return suggestGoalsImpl(
      context,
      this.llmClient,
      this.ethicsGate,
      this.adapterCapabilities,
      options
    );
  }

  // ─── getNegotiationLog() ───

  async getNegotiationLog(goalId: string): Promise<NegotiationLog | null> {
    const raw = await this.stateManager.readRaw(`goals/${goalId}/negotiation-log.json`);
    if (raw === null) return null;
    return NegotiationLogSchema.parse(raw);
  }

  // ─── Private helpers ───

  // kept for tests that access these via `as unknown as` casting

  private determineResponseType(
    feasibilityResults: FeasibilityResult[],
    baselineObservations: Array<{ dimension: string; value: number | string | boolean | null; confidence: number; method: string }>,
    timeHorizonDays: number
  ) {
    return determineResponseType(feasibilityResults, baselineObservations, timeHorizonDays);
  }

  private estimateChangeRate(dimension: import("../types/goal.js").Dimension): number | null {
    return estimateChangeRate(dimension);
  }

  private async evaluateQualitatively(
    dimensionName: string,
    goalDescription: string,
    baselineValue: number | string | boolean | null,
    thresholdValue: number | string | boolean | (number | string)[] | null,
    timeHorizonDays: number
  ): Promise<FeasibilityResult> {
    return evaluateQualitatively(
      this.llmClient,
      dimensionName,
      goalDescription,
      baselineValue,
      thresholdValue,
      timeHorizonDays
    );
  }

  private async saveNegotiationLog(goalId: string, log: NegotiationLog): Promise<void> {
    const parsed = NegotiationLogSchema.parse(log);
    await this.stateManager.writeRaw(`goals/${goalId}/negotiation-log.json`, parsed);
  }

  /**
   * Calculate counter-proposal target given baseline, change rate, and time horizon.
   */
  static calculateRealisticTarget(
    baseline: number,
    changeRate: number,
    timeHorizonDays: number
  ): number {
    return baseline + changeRate * timeHorizonDays * REALISTIC_TARGET_ACCELERATION_FACTOR;
  }
}
