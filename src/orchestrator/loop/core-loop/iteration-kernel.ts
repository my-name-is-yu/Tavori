import type { Logger } from "../../../runtime/logger.js";
import type { StateDiffCalculator } from "../state-diff.js";
import { generateLoopReport } from "../loop-report-helper.js";
import { makeEmptyIterationResult } from "../loop-result-types.js";
import type { LoopIterationResult, NextIterationDirective } from "../loop-result-types.js";
import type { CoreLoopDeps, ResolvedLoopConfig } from "./contracts.js";
import {
  loadGoalWithAggregation,
  observeAndReload,
  calculateGapOrComplete,
  scoreDrivesAndCheckKnowledge,
  phaseAutoDecompose,
  type PhaseCtx,
} from "./preparation.js";
import {
  checkCompletionAndMilestones,
  detectStallsAndRebalance,
  checkDependencyBlock,
  runTaskCycleWithContext,
  type LoopCallbacks,
} from "./task-cycle.js";
import {
  runStateDiffCheck,
  tryParallelExecution,
  type StateDiffState,
} from "./control.js";
import { handleCapabilityAcquisition } from "./capability.js";
import { loadDreamActivationState } from "../../../platform/dream/dream-activation.js";
import { CoreLoopEvidenceLedger } from "./evidence-ledger.js";
import { CorePhaseRuntime } from "./phase-runtime.js";
import {
  buildKnowledgeRefreshSpec,
  buildObserveEvidenceSpec,
  buildReplanningOptionsSpec,
  buildStallInvestigationSpec,
  buildVerificationEvidenceSpec,
} from "./phase-specs.js";
import type { CorePhasePolicyRegistry } from "./phase-policy.js";
import { CoreDecisionEngine } from "./decision-engine.js";
import type { ITimeHorizonEngine } from "../../../platform/time/time-horizon-engine.js";
import type { DriveScore } from "../../../base/types/drive.js";

export interface CoreIterationKernelDeps {
  deps: CoreLoopDeps;
  getConfig: () => ResolvedLoopConfig;
  setConfig: (config: ResolvedLoopConfig) => void;
  logger?: Logger;
  stateDiff?: StateDiffCalculator;
  stateDiffState: Map<string, StateDiffState>;
  decomposedGoals: Set<string>;
  timeHorizonEngine?: ITimeHorizonEngine;
  corePhasePolicyRegistry: CorePhasePolicyRegistry;
  coreDecisionEngine: CoreDecisionEngine;
  capabilityFailures: Map<string, number>;
  incrementTransferCounter: () => number;
  getPendingDirective: (goalId: string) => NextIterationDirective | undefined;
}

export interface RunCoreIterationInput {
  goalId: string;
  loopIndex: number;
  isFirstIteration?: boolean;
}

export class CoreIterationKernel {
  constructor(private readonly deps: CoreIterationKernelDeps) {}

  async run(input: RunCoreIterationInput): Promise<LoopIterationResult> {
    const { goalId, loopIndex, isFirstIteration } = input;
    const startTime = Date.now();
    let config = this.deps.getConfig();
    const pendingDirective = this.deps.getPendingDirective(goalId);
    const ctx: PhaseCtx = {
      deps: this.deps.deps,
      config,
      logger: this.deps.logger,
      toolExecutor: this.deps.deps.toolExecutor,
      timeHorizonEngine: this.deps.timeHorizonEngine,
    };
    const runPhase = async <T>(phase: string, work: () => Promise<T>): Promise<T> => {
      const phaseStartedAt = Date.now();
      this.deps.logger?.info(`[CoreLoop] phase ${phase} starting`, { goalId, loopIndex });
      try {
        const value = await work();
        this.deps.logger?.info(`[CoreLoop] phase ${phase} completed`, {
          goalId,
          loopIndex,
          duration_ms: Date.now() - phaseStartedAt,
        });
        return value;
      } catch (err) {
        this.deps.logger?.warn(`[CoreLoop] phase ${phase} failed`, {
          goalId,
          loopIndex,
          duration_ms: Date.now() - phaseStartedAt,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };

    const result: LoopIterationResult = makeEmptyIterationResult(goalId, loopIndex);
    const evidenceLedger = new CoreLoopEvidenceLedger();
    const corePhaseRuntime = new CorePhaseRuntime({
      phaseRunner: this.deps.deps.corePhaseRunner,
      policyRegistry: this.deps.corePhasePolicyRegistry,
    });
    const rememberPhase = (execution: {
      phase: import("../../execution/agent-loop/core-phase-runner.js").CorePhaseKind;
      status: "skipped" | "completed" | "low_confidence" | "failed";
      summary?: string;
      traceId?: string;
      sessionId?: string;
      turnId?: string;
      stopReason?: string;
      lowConfidence?: boolean;
      error?: string;
    }) => {
      if (execution.status === "skipped") return;
      evidenceLedger.record(execution);
      result.corePhaseResults = evidenceLedger.toIterationPhaseResults();
    };

    this.deps.logger?.info(`[CoreLoop] iteration ${loopIndex + 1} starting`, { goalId, loopIndex });

    const loadedGoal = await runPhase("load-goal", () =>
      loadGoalWithAggregation(ctx, goalId, result, startTime)
    );
    if (!loadedGoal) return result;
    let goal = loadedGoal;

    await runPhase("auto-decompose", () =>
      phaseAutoDecompose(
        goalId,
        goal,
        this.deps.deps,
        config,
        this.deps.logger,
        this.deps.decomposedGoals,
        isFirstIteration
      )
    );

    if (!goal.children_ids.length) {
      const reloadedAfterDecompose = await this.deps.deps.stateManager.loadGoal(goalId);
      if (reloadedAfterDecompose && reloadedAfterDecompose.children_ids.length > 0) {
        goal = reloadedAfterDecompose;
        if (this.deps.deps.treeLoopOrchestrator) {
          config = { ...config, treeMode: true };
          this.deps.setConfig(config);
          ctx.config = config;
          this.deps.logger?.info("[CoreLoop] treeMode enabled after auto-decomposition", {
            goalId,
            childrenCount: goal.children_ids.length,
          });
        }
      }
    }

    const observeEvidence = await runPhase("observe-evidence", () =>
      corePhaseRuntime.run(
        {
          ...buildObserveEvidenceSpec(),
          requiredTools: [],
          allowedTools: [],
          budget: {},
        },
        {
          goalTitle: goal.title,
          goalDescription: goal.description,
          dimensions: goal.dimensions.map((dimension) => dimension.name),
        },
        { goalId, gapAggregate: result.gapAggregate },
      )
    );
    rememberPhase(observeEvidence);

    goal = await runPhase("observe", () => observeAndReload(ctx, goalId, goal, loopIndex));

    if (this.deps.stateDiff) {
      const { shouldSkip } = await runStateDiffCheck(
        this.deps.stateDiff,
        this.deps.stateDiffState,
        goalId,
        goal,
        loopIndex,
        config,
        this.deps.deps,
        result,
        startTime,
        this.deps.logger
      );
      if (shouldSkip) return result;
    }

    const gapResult = await runPhase("gap-analysis", () =>
      calculateGapOrComplete(ctx, goalId, goal, loopIndex, result, startTime)
    );
    if (!gapResult) return result;
    const { gapVector, gapAggregate, skipTaskGeneration } = gapResult;

    this.deps.logger?.info(
      `[iter ${loopIndex}] gap: ${gapAggregate.toFixed(2)} | ${(gapVector.gaps ?? [])
        .map((g: any) => `${g.dimension_name}=${g.normalized_weighted_gap.toFixed(2)}`)
        .join(", ")}`
    );

    let driveScores: DriveScore[] = [];
    let highDissatisfactionDimensions: string[] = [];
    if (!skipTaskGeneration) {
      const driveResult = await runPhase("drive-scoring", () =>
        scoreDrivesAndCheckKnowledge(
          ctx,
          goalId,
          goal,
          gapVector,
          loopIndex,
          result,
          startTime,
          (id, idx, r, g) => generateLoopReport(id, idx, r, g, this.deps.deps.reportingEngine, this.deps.logger)
        )
      );
      if (!driveResult) return result;
      driveScores = driveResult.driveScores;
      highDissatisfactionDimensions = driveResult.highDissatisfactionDimensions;
    }

    const knowledgeRefresh = !skipTaskGeneration
      ? await runPhase("knowledge-refresh", () =>
          corePhaseRuntime.run(
            {
              ...buildKnowledgeRefreshSpec(),
              requiredTools: [],
              allowedTools: [],
              budget: {},
            },
            {
              goalTitle: goal.title,
              topDimensions: highDissatisfactionDimensions.length > 0
                ? [
                    ...(pendingDirective?.focusDimension ? [pendingDirective.focusDimension] : []),
                    ...highDissatisfactionDimensions,
                  ].filter((value, index, values) => values.indexOf(value) === index)
                : [
                    ...(pendingDirective?.focusDimension ? [pendingDirective.focusDimension] : []),
                    ...driveScores.map((score) => score.dimension_name),
                  ].filter((value, index, values) => values.indexOf(value) === index),
              gapAggregate,
            },
            { goalId, gapAggregate },
          )
        )
      : null;
    if (knowledgeRefresh) rememberPhase(knowledgeRefresh);

    const replanningOptions = this.deps.coreDecisionEngine.shouldRunReplanningOptions({
      skipTaskGeneration: Boolean(skipTaskGeneration),
      taskCycleBlocked: false,
      gapAggregate,
    })
      ? await runPhase("replanning-options", () =>
          corePhaseRuntime.run(
            {
              ...buildReplanningOptionsSpec(),
              requiredTools: [],
              allowedTools: [],
              budget: {},
            },
            {
              goalTitle: goal.title,
              targetDimensions: driveScores.map((score) => score.dimension_name),
              gapAggregate,
            },
            { goalId, gapAggregate },
          )
        )
      : null;
    if (replanningOptions) rememberPhase(replanningOptions);

    await runPhase("completion-check", () =>
      checkCompletionAndMilestones(ctx, goalId, goal, result, startTime)
    );
    if (result.error) return result;

    const stallActionHints = this.deps.coreDecisionEngine.buildStallActionHints({
      phase: replanningOptions,
    });
    await runPhase("stall-detection", () =>
      detectStallsAndRebalance(
        ctx,
        goalId,
        goal,
        result,
        stallActionHints.recommendedAction
          ? stallActionHints
          : pendingDirective?.preferredAction
            ? { recommendedAction: pendingDirective.preferredAction }
            : undefined,
      )
    );
    const stallInvestigation = this.deps.coreDecisionEngine.shouldRunStallInvestigation(result)
      ? await runPhase("stall-investigation", () =>
          corePhaseRuntime.run(
            {
              ...buildStallInvestigationSpec(),
              requiredTools: [],
              allowedTools: [],
              budget: {},
            },
            {
              goalTitle: goal.title,
              stallType: result.stallReport?.stall_type ?? "unknown",
              ...(result.stallReport?.dimension_name ? { dimensionName: result.stallReport.dimension_name } : {}),
              ...(result.stallReport?.suggested_cause ? { suggestedCause: result.stallReport.suggested_cause } : {}),
            },
            { goalId, stallDetected: result.stallDetected, gapAggregate },
          )
        )
      : null;
    if (stallInvestigation) rememberPhase(stallInvestigation);

    if (result.stallDetected && result.stallReport) {
      this.deps.logger?.warn(`[iter ${loopIndex}] stall detected: ${result.stallReport.stall_type}`, {
        escalation: result.stallReport.escalation_level,
      });
      void this.deps.deps.hookManager?.emit("StallDetected", {
        goal_id: goalId,
        dimension: result.stallReport.dimension_name ?? undefined,
        data: {
          stall_type: result.stallReport.stall_type,
          escalation_level: result.stallReport.escalation_level,
          suggested_cause: result.stallReport.suggested_cause,
          task_id: result.stallReport.task_id ?? undefined,
        },
      });
    }

    const knowledgeAcquisitionDecision = this.deps.coreDecisionEngine.evaluateKnowledgeAcquisition({
      phase: knowledgeRefresh,
      hasKnowledgeManager: !!this.deps.deps.knowledgeManager,
      hasToolExecutor: !!this.deps.deps.toolExecutor,
    });
    if (
      knowledgeAcquisitionDecision.shouldAcquire &&
      knowledgeAcquisitionDecision.question &&
      this.deps.deps.knowledgeManager &&
      this.deps.deps.toolExecutor
    ) {
      try {
        const acquired = await this.deps.deps.knowledgeManager.acquireWithTools(
          knowledgeAcquisitionDecision.question,
          goalId,
          this.deps.deps.toolExecutor,
          {
            cwd: process.cwd(),
            goalId,
            trustBalance: 0,
            preApproved: true,
            approvalFn: async () => false,
          }
        );
        for (const entry of acquired) {
          await this.deps.deps.knowledgeManager.saveKnowledge(goalId, entry);
        }
        if (acquired.length > 0) {
          result.nextIterationDirective = this.deps.coreDecisionEngine.buildNextIterationDirective({
            knowledgeRefreshPhase: knowledgeRefresh,
            replanningPhase: replanningOptions,
            goalDimensions: goal.dimensions.map((dimension) => dimension.name),
            fallbackFocusDimension: driveScores[0]?.dimension_name ?? pendingDirective?.focusDimension,
          });
          this.deps.logger?.info("CoreLoop: knowledge_refresh auto-acquired knowledge and skipped execution", {
            goalId,
            acquiredCount: acquired.length,
          });
          await generateLoopReport(goalId, loopIndex, result, goal, this.deps.deps.reportingEngine, this.deps.logger);
          result.skipped = true;
          result.skipReason = "knowledge_refresh_auto_acquire";
          result.elapsedMs = Date.now() - startTime;
          return result;
        }
      } catch (err) {
        this.deps.logger?.warn("CoreLoop: knowledge_refresh auto acquisition failed (non-fatal)", {
          goalId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (result.stallDetected && this.deps.deps.knowledgeManager && this.deps.deps.toolExecutor) {
      try {
        const activation = await loadDreamActivationState(this.deps.deps.stateManager.getBaseDir());
        if (activation.flags.autoAcquireKnowledge) {
          const portfolio = await Promise.resolve(
            this.deps.deps.strategyManager.getPortfolio(goalId)
          ).catch(() => null);
          const observationContext = {
            observations: goal.dimensions.map((dimension) => ({
              name: dimension.name,
              current_value: dimension.current_value,
              confidence: dimension.confidence,
            })),
            strategies: portfolio?.strategies ?? null,
            confidence:
              gapVector.gaps.reduce((sum, gap) => sum + gap.confidence, 0) /
              Math.max(gapVector.gaps.length, 1),
          };
          const gapSignal = await this.deps.deps.knowledgeManager.detectKnowledgeGap(observationContext);
          if (gapSignal) {
            const acquired = await this.deps.deps.knowledgeManager.acquireWithTools(
              gapSignal.missing_knowledge,
              goalId,
              this.deps.deps.toolExecutor,
              {
                cwd: process.cwd(),
                goalId,
                trustBalance: 0,
                preApproved: true,
                approvalFn: async () => false,
              }
            );
            for (const entry of acquired) {
              await this.deps.deps.knowledgeManager.saveKnowledge(goalId, entry);
            }
            if (acquired.length > 0) {
              this.deps.logger?.info(
                "CoreLoop: dream auto-acquired knowledge and skipped execution for context refresh",
                { goalId, acquiredCount: acquired.length }
              );
              await generateLoopReport(goalId, loopIndex, result, goal, this.deps.deps.reportingEngine, this.deps.logger);
              result.skipped = true;
              result.skipReason = "dream_auto_acquire_knowledge";
              result.elapsedMs = Date.now() - startTime;
              return result;
            }
          }
        }
      } catch (err) {
        this.deps.logger?.warn("CoreLoop: autoAcquireKnowledge failed (non-fatal)", {
          goalId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (skipTaskGeneration) {
      result.nextIterationDirective = this.deps.coreDecisionEngine.buildNextIterationDirective({
        knowledgeRefreshPhase: knowledgeRefresh,
        replanningPhase: replanningOptions,
        goalDimensions: goal.dimensions.map((dimension) => dimension.name),
        fallbackFocusDimension: driveScores[0]?.dimension_name ?? pendingDirective?.focusDimension,
      });
      await generateLoopReport(goalId, loopIndex, result, goal, this.deps.deps.reportingEngine, this.deps.logger);
      result.elapsedMs = Date.now() - startTime;
      return result;
    }

    if (checkDependencyBlock(ctx, goalId, result)) return result;

    const tookParallelPath = await tryParallelExecution(
      goalId,
      goal,
      gapAggregate,
      result,
      startTime,
      this.deps.deps,
      loopIndex,
      this.deps.logger
    );
    if (tookParallelPath) return result;

    const shouldPreferReplanningContext = this.deps.coreDecisionEngine.shouldPreferReplanningContext({
      phase: replanningOptions,
    });
    const taskGenerationHints = this.deps.coreDecisionEngine.buildTaskGenerationHints({
      phase: replanningOptions,
      goalDimensions: goal.dimensions.map((dimension) => dimension.name),
    });
    const mergedTaskGenerationHints = {
      targetDimensionOverride: taskGenerationHints.targetDimensionOverride ?? pendingDirective?.focusDimension,
      knowledgeContextPrefix: taskGenerationHints.knowledgeContextPrefix,
    };
    if (!shouldPreferReplanningContext && replanningOptions?.status === "completed") {
      this.deps.logger?.debug("CoreLoop: replanning evidence collected but not adopted as preferred context", {
        goalId,
        loopIndex,
      });
    }

    const loopCallbacks: LoopCallbacks = {
      handleCapabilityAcquisition: (task, gId, adapter) => handleCapabilityAcquisition(
        task as Parameters<typeof handleCapabilityAcquisition>[0],
        gId,
        adapter as Parameters<typeof handleCapabilityAcquisition>[2],
        this.deps.deps.capabilityDetector,
        this.deps.capabilityFailures,
        this.deps.logger
      ),
      incrementTransferCounter: () => this.deps.incrementTransferCounter(),
      tryGenerateReport: (id, idx, r, g) =>
        generateLoopReport(id, idx, r, g, this.deps.deps.reportingEngine, this.deps.logger),
    };
    const taskCycleOk = await runTaskCycleWithContext(
      ctx,
      goalId,
      goal,
      gapVector,
      driveScores,
      highDissatisfactionDimensions,
      loopIndex,
      result,
      startTime,
      loopCallbacks,
      evidenceLedger,
      mergedTaskGenerationHints,
    );
    if (!taskCycleOk) return result;

    const completedTaskResult = result.taskResult;
    if (this.deps.coreDecisionEngine.shouldRunVerificationEvidence(result) && completedTaskResult) {
      const verificationPhase = await runPhase("verification-evidence", () =>
        corePhaseRuntime.run(
          {
            ...buildVerificationEvidenceSpec(),
            budget: {},
          },
          {
            taskId: completedTaskResult.task.id,
            taskDescription: completedTaskResult.task.work_description,
            successCriteria: completedTaskResult.task.success_criteria.map((criterion) => criterion.description),
            executionAction: completedTaskResult.action,
          },
          {
            goalId,
            taskId: completedTaskResult.task.id,
            hasTaskResult: true,
          },
        )
      );
      rememberPhase(verificationPhase);
    }

    result.nextIterationDirective = this.deps.coreDecisionEngine.buildNextIterationDirective({
      knowledgeRefreshPhase: knowledgeRefresh,
      replanningPhase: replanningOptions,
      goalDimensions: goal.dimensions.map((dimension) => dimension.name),
      fallbackFocusDimension: driveScores[0]?.dimension_name ?? pendingDirective?.focusDimension,
    });

    await generateLoopReport(goalId, loopIndex, result, goal, this.deps.deps.reportingEngine, this.deps.logger);

    result.elapsedMs = Date.now() - startTime;
    return result;
  }
}
