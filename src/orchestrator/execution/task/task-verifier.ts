/**
 * task-verifier.ts
 *
 * Verification logic extracted from TaskLifecycle:
 *   - verifyTask
 *   - handleVerdict
 *   - handleFailure
 *
 * All functions are standalone and receive explicit dependencies instead of
 * relying on `this`. TaskLifecycle keeps thin wrapper methods for backward
 * compatibility.
 *
 * Implementation is split across:
 *   - task-verifier-types.ts  — interfaces, Zod schemas
 *   - task-verifier-rules.ts  — mechanical verification, dimension guards, history
 *   - task-verifier-llm.ts    — LLM review, timeout, retry
 */

import { StateManager } from "../../../base/state/state-manager.js";
import { VerificationResultSchema } from "../../../base/types/task.js";
import type { Task, VerificationResult } from "../../../base/types/task.js";
import type { AgentResult } from "../adapter-layer.js";
import { wrapXmlTag, formatKnowledge } from "../../../prompt/formatters.js";
import { analyzeImpact } from "../impact-analyzer.js";
import type { ImpactAnalysis } from "../../../base/types/pipeline.js";

// Re-export types so external consumers keep working
export type {
  ExecutorReport,
  VerdictResult,
  FailureResult,
  CompletionJudgerConfig,
  VerifierDeps,
} from "./task-verifier-types.js";
export { CompletionJudgerResponseSchema } from "./task-verifier-types.js";

// Re-export rule helpers (used by task-lifecycle.ts and tests)
export {
  clampDimensionUpdate,
  checkDimensionDirection,
} from "./task-verifier-rules.js";

import type { VerifierDeps, VerdictResult, FailureResult } from "./task-verifier-types.js";
import {
  runMechanicalVerification,
  clampDimensionUpdate,
  checkDimensionDirection,
  parseExecutorReport,
  isDirectionCorrect,
  attemptRevert,
  setDimensionIntegrity,
  appendTaskHistory,
} from "./task-verifier-rules.js";
import { runLLMReview } from "./task-verifier-llm.js";
import { appendTaskOutcomeEvent } from "./task-outcome-ledger.js";

// ─── verifyTask ───

/**
 * Verify task execution results using 3-layer verification.
 *
 * Layer 1: Mechanical verification (via adapter in review session)
 * Layer 2: LLM task reviewer (independent, no self-report)
 * Layer 3: Executor self-report (reference only)
 *
 * Contradiction resolution:
 * - L1 PASS + L2 PASS → pass
 * - L1 PASS + L2 FAIL → re-review; if still FAIL → fail
 * - L1 FAIL + L2 PASS → fail (mechanical priority)
 * - L1 FAIL + L2 FAIL → fail
 * - L1 SKIP → use L2 only (lower confidence)
 */
export async function verifyTask(
  deps: VerifierDeps,
  task: Task,
  executionResult: AgentResult
): Promise<VerificationResult> {
  // ─── Short-circuit: GitHub issue URL evidence ───
  // When execution succeeded and output contains a GitHub issue URL,
  // treat as mechanical pass without running full L1/L2 verification.
  // Dimension updates are left to ObservationEngine (next loop iteration).
  const githubIssueUrlPattern = /github\.com\/.+\/issues\/\d+/;
  if (
    executionResult.success === true &&
    executionResult.output &&
    githubIssueUrlPattern.test(executionResult.output)
  ) {
    const scResult = VerificationResultSchema.parse({
      task_id: task.id,
      verdict: "pass",
      confidence: 0.95,
      evidence: [
        {
          layer: "mechanical" as const,
          description:
            "GitHub issue URL found in execution output — mechanical evidence of successful issue creation",
          confidence: 0.95,
        },
      ],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
    });
    return scResult;
  }

  // ─── Layer 1: Mechanical verification ───
  const l1Result = await runMechanicalVerification(deps, task);

  // ─── Build optional enrichment blocks for LLM review ───
  let knowledgeBlock = "";
  if (deps.knowledgeManager?.getRelevantKnowledge) {
    try {
      const entries = await deps.knowledgeManager.getRelevantKnowledge(task.goal_id);
      if (entries.length > 0) {
        knowledgeBlock = wrapXmlTag(
          "relevant_knowledge",
          formatKnowledge(
            entries.map((e) => ({ question: e.question, answer: e.answer, confidence: e.confidence }))
          )
        );
      }
    } catch { /* knowledge enrichment is optional */ }
  }

  let stateBlock = "";
  try {
    const goalDataForState = await deps.stateManager.readRaw(`goals/${task.goal_id}/goal.json`);
    if (goalDataForState && typeof goalDataForState === "object") {
      const dims = (goalDataForState as Record<string, unknown>).dimensions as Array<Record<string, unknown>> | undefined;
      const primaryDim = dims?.find((d) => d.name === task.primary_dimension);
      if (primaryDim) {
        const currentValue = typeof primaryDim.current_value === "number" ? primaryDim.current_value : undefined;
        const threshold = primaryDim.threshold;
        if (currentValue !== undefined) {
          stateBlock = wrapXmlTag(
            "current_state",
            `Dimension: ${task.primary_dimension}, current value: ${currentValue}${threshold !== undefined ? `, target: ${JSON.stringify(threshold)}` : ""}`
          );
        }
      }
    }
  } catch { /* state enrichment is optional */ }

  // ─── Layer 2: LLM task reviewer (independent) ───
  const l2Result = await runLLMReview(deps, task, executionResult, knowledgeBlock, stateBlock);

  // ─── Layer 3: Executor self-report (reference only) ───
  const executorReport = parseExecutorReport(executionResult);

  // ─── Contradiction resolution ───
  let verdict: "pass" | "partial" | "fail";
  let confidence: number;
  let l2Retry: Awaited<ReturnType<typeof runLLMReview>> | undefined;

  if (l1Result.applicable) {
    if (l1Result.passed && l2Result.passed) {
      verdict = "pass";
      confidence = 0.9;
    } else if (l1Result.passed && l2Result.partial) {
      // L1 pass + L2 partial → partial
      verdict = "partial";
      confidence = 0.7;
    } else if (l1Result.passed && !l2Result.passed && !l2Result.partial) {
      // L1 pass + L2 fail → re-review
      l2Retry = await runLLMReview(deps, task, executionResult, knowledgeBlock, stateBlock, 'main');
      if (l2Retry.passed) {
        verdict = "pass";
        confidence = 0.75;
      } else if (l2Retry.partial) {
        verdict = "partial";
        confidence = 0.65;
      } else {
        verdict = "fail";
        confidence = 0.8;
      }
    } else if (!l1Result.passed && l2Result.passed) {
      // Mechanical verification takes priority
      verdict = "fail";
      confidence = 0.85;
    } else {
      // Both fail (or L1 fail + L2 partial → fail, mechanical priority)
      verdict = "fail";
      confidence = 0.9;
    }
  } else {
    // L1 skipped — use L2 only with lower confidence
    if (l2Result.passed) {
      verdict = "pass";
      confidence = 0.6;
    } else if (l2Result.partial) {
      verdict = "partial";
      confidence = 0.5;
    } else {
      verdict = "fail";
      confidence = 0.6;
    }
  }

  // Handle partial from L2 when L1 is applicable but didn't fail
  if (l1Result.applicable && l2Result.partial && verdict !== "fail") {
    verdict = "partial";
  }

  // Use retry result for evidence when a retry occurred, to keep audit trail accurate
  const effectiveL2 = l2Retry ?? l2Result;

  const now = new Date().toISOString();
  const evidence = [
    ...(l1Result.applicable
      ? [
          {
            layer: "mechanical" as const,
            description: l1Result.description,
            confidence: 0.9,
          },
        ]
      : []),
    {
      layer: "independent_review" as const,
      description: effectiveL2.description,
      confidence: effectiveL2.confidence,
    },
    {
      layer: "self_report" as const,
      description: executorReport.summary,
      confidence: 0.3, // self-report has lowest confidence
    },
  ];

  // Build dimension_updates from task's target dimensions based on verdict.
  // pass: significant progress (+0.2), partial: moderate progress (+0.15), fail: no update.
  const progressByVerdict: Record<string, number> = {
    pass: 0.2,
    partial: 0.15,
    fail: 0,
  };
  const progressDelta = progressByVerdict[verdict] ?? 0;

  // Read goal state to get actual current dimension values for previous_value / new_value.
  const goalDataForUpdate = await deps.stateManager.readRaw(`goals/${task.goal_id}/goal.json`);
  const goalDimsForUpdate =
    goalDataForUpdate && typeof goalDataForUpdate === "object"
      ? ((goalDataForUpdate as Record<string, unknown>).dimensions as
          | Array<Record<string, unknown>>
          | undefined)
      : undefined;

  const dimension_updates =
    verdict === "fail"
      ? []
      : task.target_dimensions.map((dimName) => {
          const dim = goalDimsForUpdate?.find((d) => d.name === dimName);
          const prevVal =
            dim !== undefined && typeof dim.current_value === "number"
              ? (dim.current_value as number)
              : null;
          // Scale the normalized delta to raw threshold-scale space.
          const threshold =
            dim !== undefined &&
            typeof dim.threshold === "object" &&
            dim.threshold !== null
              ? (dim.threshold as Record<string, unknown>)
              : null;
          let scaledDelta = progressDelta;
          if (threshold) {
            const thresholdType = threshold.type as string | undefined;
            if (
              (thresholdType === "min" || thresholdType === "max") &&
              typeof threshold.value === "number" &&
              threshold.value !== 0
            ) {
              scaledDelta = progressDelta * threshold.value;
            } else if (
              thresholdType === "range" &&
              typeof threshold.low === "number" &&
              typeof threshold.high === "number"
            ) {
              scaledDelta = progressDelta * (threshold.high - threshold.low);
            }
          }
          const newVal =
            prevVal !== null ? prevVal + scaledDelta : scaledDelta;
          return {
            dimension_name: dimName,
            previous_value: prevVal,
            new_value: newVal,
            confidence,
          };
        });

  const verificationResult = VerificationResultSchema.parse({
    task_id: task.id,
    verdict,
    confidence,
    evidence,
    dimension_updates,
    timestamp: now,
  });

  // Post-verification: analyze impact for unintended side effects (opt-in)
  let impactAnalysis: ImpactAnalysis | undefined;
  if (deps.enableImpactAnalysis) try {
    impactAnalysis = await analyzeImpact(
      { llmClient: deps.llmClient, logger: deps.logger! },
      {
        taskDescription: task.work_description,
        taskOutput: executionResult.output,
        verificationVerdict: verdict,
        targetScope: task.scope_boundary.in_scope,
      }
    );
    if (impactAnalysis.side_effects.length > 0) {
      deps.logger?.warn("[task-verifier] Impact analysis detected side effects", {
        verdict: impactAnalysis.verdict,
        side_effects: impactAnalysis.side_effects,
        confidence: impactAnalysis.confidence,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger?.warn("[task-verifier] Impact analysis failed (non-fatal)", { error: msg });
  }

  // Persist verification result — include criteria fields from LLM review for failure context
  await deps.stateManager.writeRaw(
    `verification/${task.id}/verification-result.json`,
    {
      ...verificationResult,
      criteria_met: effectiveL2.criteria_met,
      criteria_total: effectiveL2.criteria_total,
      impact_analysis: impactAnalysis,
    }
  );

  return verificationResult;
}

// ─── handleVerdict ───

/**
 * Handle a verification verdict (pass/partial/fail).
 */
export async function handleVerdict(
  deps: VerifierDeps,
  task: Task,
  verificationResult: VerificationResult
): Promise<VerdictResult> {
  // P0: Progress-verdict contradiction check (§4.1)
  if (verificationResult.verdict === "pass" && verificationResult.dimension_updates?.length > 0) {
    const goalRawForGuard = await deps.stateManager.readRaw(`goals/${task.goal_id}/goal.json`);
    const goalDimsForGuard = (
      goalRawForGuard &&
      typeof goalRawForGuard === "object" &&
      Array.isArray((goalRawForGuard as Record<string, unknown>).dimensions)
        ? (goalRawForGuard as Record<string, unknown>).dimensions as Array<Record<string, unknown>>
        : []
    );

    const anyWorsened = verificationResult.dimension_updates.some((u) => {
      const prev = typeof u.previous_value === "number" ? u.previous_value : null;
      const next = typeof u.new_value === "number" ? u.new_value : null;
      if (prev === null || next === null) return false;

      const dimMeta = goalDimsForGuard.find((d) => d.name === u.dimension_name);
      const thresholdType =
        dimMeta && typeof dimMeta.threshold === "object" && dimMeta.threshold !== null
          ? (dimMeta.threshold as Record<string, unknown>).type as string | undefined
          : undefined;

      if (thresholdType === "min") {
        return next < prev - 0.05;
      } else if (thresholdType === "max") {
        return next > prev + 0.05;
      }
      return false;
    });
    if (anyWorsened) {
      deps.logger?.warn(
        "progress-verdict contradiction: dimension value moved away from target but verdict was pass. Overriding to partial."
      );
      verificationResult = { ...verificationResult, verdict: "partial" };
    }
  }

  // Save failure context for fail/partial verdicts (§4.7)
  if (verificationResult.verdict === "fail" || verificationResult.verdict === "partial") {
    const firstEvidence = verificationResult.evidence?.[0];
    const reasoning = typeof firstEvidence?.description === "string" ? firstEvidence.description : "";
    let criteria_met: number | undefined;
    let criteria_total: number | undefined;
    try {
      const raw = await deps.stateManager.readRaw(`verification/${task.id}/verification-result.json`) as Record<string, unknown> | null;
      if (raw && typeof raw.criteria_met === "number") criteria_met = raw.criteria_met;
      if (raw && typeof raw.criteria_total === "number") criteria_total = raw.criteria_total;
    } catch {
      // Non-fatal: criteria fields are best-effort
    }
    const failureContext = {
      prev_task_description: task.work_description,
      verdict: verificationResult.verdict,
      reasoning,
      criteria_met,
      criteria_total,
      timestamp: new Date().toISOString(),
    };
    try {
      await deps.stateManager.writeRaw(
        `tasks/${task.goal_id}/last-failure-context.json`,
        failureContext
      );
    } catch {
      // Non-fatal: failure context saving is best-effort
    }
  }

  switch (verificationResult.verdict) {
    case "pass": {
      // Clear stale failure context
      try {
        await deps.stateManager.writeRaw(
          `tasks/${task.goal_id}/last-failure-context.json`,
          null
        );
      } catch {
        // Non-fatal
      }

      deps.trustManager.recordSuccess(task.task_category);

      const now = new Date().toISOString();

      const completedTask = {
        ...task,
        consecutive_failure_count: 0,
        status: "completed" as const,
        completed_at: now,
        verification_verdict: verificationResult.verdict,
        verification_evidence: verificationResult.evidence?.map((e) => e.description ?? String(e)) ?? [],
      };
      await deps.stateManager.writeRaw(
        `tasks/${task.goal_id}/${task.id}.json`,
        completedTask
      );

      // Apply dimension_updates
      const goalData = await deps.stateManager.readRaw(`goals/${task.goal_id}/goal.json`);
      if (goalData && typeof goalData === "object") {
        const goal = goalData as Record<string, unknown>;
        const dimensions = goal.dimensions as Array<Record<string, unknown>> | undefined;
        if (dimensions) {
          for (const dim of dimensions) {
            const update = verificationResult.dimension_updates.find(
              (u) => u.dimension_name === dim.name
            );
            if (update !== undefined && typeof update.new_value === "number") {
              const prev = typeof dim.current_value === "number" ? dim.current_value : 0;
              if (!checkDimensionDirection(task.intended_direction, prev, update.new_value, deps.logger, String(dim.name))) {
                continue;
              }
              dim.current_value = clampDimensionUpdate(prev, update.new_value, deps.logger, String(dim.name));
              dim.confidence = verificationResult.confidence ?? 0.70;
              dim.last_observed_layer = "mechanical";
            }
            if (dim.name === task.primary_dimension) {
              dim.last_updated = now;
            }
          }
          await deps.stateManager.writeRaw(`goals/${task.goal_id}/goal.json`, goal);
        }
      }

      await appendTaskHistory(deps, task.goal_id, completedTask);
      await appendTaskOutcomeEvent(deps.stateManager, {
        task: completedTask,
        type: "succeeded",
        attempt: task.consecutive_failure_count + 1,
        action: "completed",
        verificationResult,
      });

      if (deps.onTaskComplete && completedTask.strategy_id) {
        deps.onTaskComplete(completedTask.strategy_id);
      }

      return { action: "completed", task: completedTask };
    }
    case "partial": {
      const directionCorrect = isDirectionCorrect(verificationResult);
      if (directionCorrect) {
        const goalDataPartial = await deps.stateManager.readRaw(`goals/${task.goal_id}/goal.json`);
        if (goalDataPartial && typeof goalDataPartial === "object") {
          const goal = goalDataPartial as Record<string, unknown>;
          const dimensions = goal.dimensions as Array<Record<string, unknown>> | undefined;
          if (dimensions) {
            for (const dim of dimensions) {
              const update = verificationResult.dimension_updates.find(
                (u) => u.dimension_name === dim.name
              );
              if (update !== undefined && typeof update.new_value === "number") {
                const prev = typeof dim.current_value === "number" ? dim.current_value : 0;
                if (!checkDimensionDirection(task.intended_direction, prev, update.new_value, deps.logger, String(dim.name))) {
                  continue;
                }
                dim.current_value = clampDimensionUpdate(prev, update.new_value, deps.logger, String(dim.name));
                dim.confidence = verificationResult.confidence ?? 0.70;
                dim.last_observed_layer = "mechanical";
              }
            }
            await deps.stateManager.writeRaw(`goals/${task.goal_id}/goal.json`, goal);
          }
        }
        const partialTask = {
          ...task,
          verification_verdict: verificationResult.verdict,
          verification_evidence: verificationResult.evidence?.map((e) => e.description ?? String(e)) ?? [],
        };
        await appendTaskHistory(deps, task.goal_id, partialTask);
        return { action: "keep", task: partialTask };
      }
      return handleFailure(deps, task, verificationResult);
    }
    case "fail": {
      return handleFailure(deps, task, verificationResult);
    }
  }
}

// ─── handleFailure ───

/**
 * Handle a task failure: increment failure count, record failure,
 * decide keep/discard/escalate.
 */
export async function handleFailure(
  deps: VerifierDeps,
  task: Task,
  verificationResult: VerificationResult
): Promise<FailureResult> {
  const updatedTask = {
    ...task,
    consecutive_failure_count: task.consecutive_failure_count + 1,
    verification_verdict: verificationResult.verdict,
    verification_evidence: verificationResult.evidence?.map((e) => e.description ?? String(e)) ?? [],
  };

  deps.trustManager.recordFailure(task.task_category);

  await deps.stateManager.writeRaw(
    `tasks/${task.goal_id}/${task.id}.json`,
    updatedTask
  );
  await appendTaskOutcomeEvent(deps.stateManager, {
    task: updatedTask,
    type: "failed",
    attempt: updatedTask.consecutive_failure_count,
    verificationResult,
  });

  if (updatedTask.consecutive_failure_count >= 3) {
    deps.stallDetector.checkConsecutiveFailures(
      task.goal_id,
      task.primary_dimension,
      updatedTask.consecutive_failure_count
    );
    await appendTaskHistory(deps, task.goal_id, updatedTask);
    await appendTaskOutcomeEvent(deps.stateManager, {
      task: updatedTask,
      type: "abandoned",
      attempt: updatedTask.consecutive_failure_count,
      action: "escalate",
      verificationResult,
      reason: "consecutive failure threshold reached",
    });
    return { action: "escalate", task: updatedTask };
  }

  const directionCorrect = isDirectionCorrect(verificationResult);

  if (directionCorrect) {
    await appendTaskHistory(deps, task.goal_id, updatedTask);
    await appendTaskOutcomeEvent(deps.stateManager, {
      task: updatedTask,
      type: "retried",
      attempt: updatedTask.consecutive_failure_count,
      action: "keep",
      verificationResult,
      reason: "failure kept for retry because direction remained correct",
    });
    return { action: "keep", task: updatedTask };
  }

  if (updatedTask.reversibility === "reversible") {
    const revertSuccess = await attemptRevert(deps, updatedTask);
    deps.logger?.warn(`[task] revert attempted`, { taskId: task.id, success: revertSuccess });
    if (revertSuccess) {
      await appendTaskHistory(deps, task.goal_id, updatedTask);
      await appendTaskOutcomeEvent(deps.stateManager, {
        task: updatedTask,
        type: "abandoned",
        attempt: updatedTask.consecutive_failure_count,
        action: "discard",
        verificationResult,
        reason: "task discarded after successful revert",
      });
      return { action: "discard", task: updatedTask };
    }
    deps.logger?.error(`[task] revert FAILED`, { taskId: task.id });
    await setDimensionIntegrity(deps, task.goal_id, task.primary_dimension, "uncertain");
    await appendTaskHistory(deps, task.goal_id, updatedTask);
    await appendTaskOutcomeEvent(deps.stateManager, {
      task: updatedTask,
      type: "abandoned",
      attempt: updatedTask.consecutive_failure_count,
      action: "escalate",
      verificationResult,
      reason: "revert failed after wrong-direction result",
    });
    return { action: "escalate", task: updatedTask };
  }

  await appendTaskHistory(deps, task.goal_id, updatedTask);
  await appendTaskOutcomeEvent(deps.stateManager, {
    task: updatedTask,
    type: "abandoned",
    attempt: updatedTask.consecutive_failure_count,
    action: "escalate",
    verificationResult,
    reason: "task cannot be safely retried or reverted",
  });
  return { action: "escalate", task: updatedTask };
}
