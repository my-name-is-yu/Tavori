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
 */

import { z } from "zod";
import { StateManager } from "../../state/state-manager.js";
import type { ILLMClient } from "../../llm/llm-client.js";
import { SessionManager } from "../session-manager.js";
import { TrustManager } from "../../traits/trust-manager.js";
import { StallDetector } from "../../drive/stall-detector.js";
import { TaskSchema, VerificationResultSchema } from "../../types/task.js";
import type { Task, VerificationResult } from "../../types/task.js";
import type { Logger } from "../../runtime/logger.js";
import type { AgentTask, AgentResult, IAdapter } from "../adapter-layer.js";
import { AdapterRegistry } from "../adapter-layer.js";
import { wrapXmlTag, formatKnowledge } from "../../prompt/formatters.js";
import type { IPromptGateway } from "../../prompt/gateway.js";
import { analyzeImpact } from "../impact-analyzer.js";
import type { ImpactAnalysis } from "../../types/pipeline.js";

// ─── Re-exported types used by consumers ───

export interface ExecutorReport {
  completed: boolean;
  summary: string;
  partial_results: string[];
  blockers: string[];
}

export interface VerdictResult {
  action: "completed" | "keep" | "discard" | "escalate";
  task: Task;
}

export interface FailureResult {
  action: "keep" | "discard" | "escalate";
  task: Task;
}

// ─── CompletionJudgerResponseSchema: Zod schema for LLM completion judgment response ───

const CompletionJudgerResponseSchema = z.object({
  verdict: z.enum(["pass", "partial", "fail"]).default("fail"),
  reasoning: z.string().default(""),
  criteria_met: z.number().int().min(0).optional(),
  criteria_total: z.number().int().min(0).optional(),
});

// ─── CompletionJudgerConfig: timeout + retry for the LLM completion judgment step ───

export interface CompletionJudgerConfig {
  /** Timeout for each LLM call in ms (default: 30000) */
  timeoutMs?: number;
  /** Maximum number of retries after the first attempt (default: 2) */
  maxRetries?: number;
  /** Base backoff delay in ms — doubles each retry (default: 1000) */
  retryBackoffMs?: number;
}

// ─── VerifierDeps: all dependencies needed by the verification functions ───

export interface VerifierDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  /** Optional separate LLM client for review (忖度防止 — sycophancy mitigation) */
  reviewerLlmClient?: ILLMClient;
  sessionManager: SessionManager;
  trustManager: TrustManager;
  stallDetector: StallDetector;
  adapterRegistry?: AdapterRegistry;
  logger?: Logger;
  onTaskComplete?: (strategyId: string) => void;
  durationToMs: (duration: { value: number; unit: string }) => number;
  completionJudgerConfig?: CompletionJudgerConfig;
  /** Optional knowledge manager for enriching LLM review prompts */
  knowledgeManager?: {
    getRelevantKnowledge?(goalId: string): Promise<Array<{ question: string; answer: string; confidence: number }>>;
  };
  /** Optional PromptGateway — when provided, LLM review calls are routed through it */
  gateway?: IPromptGateway;
  /** Enable post-verification impact analysis (default: false). Disabled by default to avoid
   *  consuming extra LLM calls in contexts that only care about verification. */
  enableImpactAnalysis?: boolean;
}

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
          // gap-calculator operates in raw values, so +0.2 normalized must be
          // multiplied by the threshold scale to produce a meaningful update.
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
  // If dimension values worsened but verdict is "pass", override to "partial"
  // "Worsened" is threshold-type-aware: min-type expects increase, max-type expects decrease.
  if (verificationResult.verdict === "pass" && verificationResult.dimension_updates?.length > 0) {
    // Load goal dimensions to determine threshold type per dimension
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

      // Determine threshold type for this dimension
      const dimMeta = goalDimsForGuard.find((d) => d.name === u.dimension_name);
      const thresholdType =
        dimMeta && typeof dimMeta.threshold === "object" && dimMeta.threshold !== null
          ? (dimMeta.threshold as Record<string, unknown>).type as string | undefined
          : undefined;

      // For min-type: lower value is worse (decrease = worsened)
      // For max-type: higher value is worse (increase = worsened)
      // For range/present/match or unknown: skip (can't determine direction safely)
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
    // Read criteria_met/criteria_total from the persisted verification result (written by verifyTask)
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
      // Clear stale failure context (pass means previous failures are no longer relevant)
      try {
        await deps.stateManager.writeRaw(
          `tasks/${task.goal_id}/last-failure-context.json`,
          null
        );
      } catch {
        // Non-fatal: clearing failure context is best-effort
      }

      // Record success
      deps.trustManager.recordSuccess(task.task_category);

      const now = new Date().toISOString();

      // Reset consecutive failure count
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

      // Apply dimension_updates and update last_updated for the primary dimension.
      const goalData = await deps.stateManager.readRaw(`goals/${task.goal_id}/goal.json`);
      if (goalData && typeof goalData === "object") {
        const goal = goalData as Record<string, unknown>;
        const dimensions = goal.dimensions as Array<Record<string, unknown>> | undefined;
        if (dimensions) {
          for (const dim of dimensions) {
            // Apply current_value updates from verification result
            const update = verificationResult.dimension_updates.find(
              (u) => u.dimension_name === dim.name
            );
            if (update !== undefined && typeof update.new_value === "number") {
              const prev = typeof dim.current_value === "number" ? dim.current_value : 0;
              if (!checkDimensionDirection(task.intended_direction, prev, update.new_value, deps.logger, String(dim.name))) {
                continue;
              }
              dim.current_value = clampDimensionUpdate(prev, update.new_value, deps.logger, String(dim.name));
              // RC-3: Update confidence and last_observed_layer so gap-calculator
              // uses the verifier's confidence rather than stale observation confidence.
              dim.confidence = verificationResult.confidence ?? 0.70;
              dim.last_observed_layer = "mechanical";
            }
            // Update last_updated for the primary dimension
            if (dim.name === task.primary_dimension) {
              dim.last_updated = now;
            }
          }
          await deps.stateManager.writeRaw(`goals/${task.goal_id}/goal.json`, goal);
        }
      }

      // Update task history
      await appendTaskHistory(deps, task.goal_id, completedTask);

      // Notify portfolio manager of task completion
      if (deps.onTaskComplete && completedTask.strategy_id) {
        deps.onTaskComplete(completedTask.strategy_id);
      }

      return { action: "completed", task: completedTask };
    }
    case "partial": {
      // Check direction from evidence
      const directionCorrect = isDirectionCorrect(verificationResult);
      if (directionCorrect) {
        // Apply partial dimension_updates to goal state
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
                // RC-3: Update confidence and last_observed_layer for partial verdicts too.
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
      // Direction wrong — delegate to handleFailure
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
  // Increment consecutive_failure_count
  const updatedTask = {
    ...task,
    consecutive_failure_count: task.consecutive_failure_count + 1,
    verification_verdict: verificationResult.verdict,
    verification_evidence: verificationResult.evidence?.map((e) => e.description ?? String(e)) ?? [],
  };

  // Record failure with TrustManager
  deps.trustManager.recordFailure(task.task_category);

  // Persist updated task
  await deps.stateManager.writeRaw(
    `tasks/${task.goal_id}/${task.id}.json`,
    updatedTask
  );

  // Check escalation threshold
  if (updatedTask.consecutive_failure_count >= 3) {
    deps.stallDetector.checkConsecutiveFailures(
      task.goal_id,
      task.primary_dimension,
      updatedTask.consecutive_failure_count
    );
    await appendTaskHistory(deps, task.goal_id, updatedTask);
    return { action: "escalate", task: updatedTask };
  }

  // Direction check
  const directionCorrect = isDirectionCorrect(verificationResult);

  if (directionCorrect) {
    await appendTaskHistory(deps, task.goal_id, updatedTask);
    return { action: "keep", task: updatedTask };
  }

  // Direction wrong
  if (updatedTask.reversibility === "reversible") {
    // Attempt revert
    const revertSuccess = await attemptRevert(deps, updatedTask);
    deps.logger?.warn(`[task] revert attempted`, { taskId: task.id, success: revertSuccess });
    if (revertSuccess) {
      await appendTaskHistory(deps, task.goal_id, updatedTask);
      return { action: "discard", task: updatedTask };
    }
    // Revert failed — set state_integrity to "uncertain" and escalate
    deps.logger?.error(`[task] revert FAILED`, { taskId: task.id });
    await setDimensionIntegrity(deps, task.goal_id, task.primary_dimension, "uncertain");
    await appendTaskHistory(deps, task.goal_id, updatedTask);
    return { action: "escalate", task: updatedTask };
  }

  // irreversible or unknown → escalate
  await appendTaskHistory(deps, task.goal_id, updatedTask);
  return { action: "escalate", task: updatedTask };
}

// ─── Private helpers (module-local) ───

/**
 * Wrap a promise with a timeout. Rejects with a TimeoutError if the promise
 * does not resolve within `ms` milliseconds.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`completion_judger timeout after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * Call an async function with retry + exponential backoff.
 * On each failure (including timeout), wait `backoffMs * 2^attempt` before retrying.
 * After `maxRetries` retries, the last error is re-thrown.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  backoffMs: number,
  logger?: Logger,
  label?: string
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = backoffMs * Math.pow(2, attempt);
        const msg = err instanceof Error ? err.message : String(err);
        logger?.warn(`[completion_judger] ${label ?? "LLM call"} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${msg} — retrying in ${delay}ms`);
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }
  throw lastErr;
}

async function runMechanicalVerification(
  deps: VerifierDeps,
  task: Task
): Promise<{ applicable: boolean; passed: boolean; description: string }> {
  // Mechanical prefixes that indicate a command can be run directly
  const mechanicalPrefixes = ["npm", "npx", "pytest", "sh", "bash", "node", "make", "cargo", "go ", "gh "];

  // Find the first success criterion with a mechanically-verifiable verification_method
  const mechanicalCriterion = task.success_criteria.find((c) => {
    const method = c.verification_method.toLowerCase().trim();
    return mechanicalPrefixes.some((prefix) => method.startsWith(prefix));
  });

  if (!mechanicalCriterion) {
    return {
      applicable: false,
      passed: false,
      description: "No mechanical verification criteria applicable",
    };
  }

  // If no adapter registry is available, fall back to assumed pass (backward compat)
  if (!deps.adapterRegistry) {
    return {
      applicable: true,
      passed: true,
      description: "Mechanical verification criteria detected (no adapter: assumed pass)",
    };
  }

  // Select the first available adapter from the registry for command execution
  const availableAdapters = deps.adapterRegistry.listAdapters();
  if (availableAdapters.length === 0) {
    return {
      applicable: true,
      passed: true,
      description: "Mechanical verification criteria detected (no adapters registered: assumed pass)",
    };
  }

  const adapterType = availableAdapters[0]!;
  let adapter: IAdapter;
  try {
    adapter = deps.adapterRegistry.getAdapter(adapterType);
  } catch {
    return {
      applicable: true,
      passed: true,
      description: "Mechanical verification criteria detected (adapter lookup failed: assumed pass)",
    };
  }

  // Execute the verification command via the adapter
  const verificationCommand = mechanicalCriterion.verification_method.trim();
  const verificationTimeoutMs = 30_000; // 30 seconds default for L1 mechanical checks

  const agentTask: AgentTask = {
    prompt: verificationCommand,
    timeout_ms: verificationTimeoutMs,
    adapter_type: adapterType,
  };

  let result: AgentResult;
  try {
    result = await adapter.execute(agentTask);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    deps.logger?.error("runMechanicalVerification: adapter.execute() threw", { error: errMsg });
    return {
      applicable: true,
      passed: false,
      description: `Mechanical verification command threw: ${errMsg}`,
    };
  }

  if (result.stopped_reason === "timeout") {
    return {
      applicable: true,
      passed: false,
      description: `Mechanical verification timed out after ${verificationTimeoutMs}ms (command: ${verificationCommand})`,
    };
  }

  const passed = result.exit_code === 0 && result.success;
  const description = passed
    ? `Mechanical verification passed (exit 0): ${verificationCommand}`
    : `Mechanical verification failed (exit ${result.exit_code ?? "null"}): ${verificationCommand}${result.error ? ` — ${result.error}` : ""}`;

  return { applicable: true, passed, description };
}

async function runLLMReview(
  deps: VerifierDeps,
  task: Task,
  executionResult: AgentResult,
  knowledgeBlock = "",
  stateBlock = "",
  modelTier: 'main' | 'light' = 'light'
): Promise<{ passed: boolean; partial: boolean; description: string; confidence: number; criteria_met?: number; criteria_total?: number }> {
  const timeoutMs = deps.completionJudgerConfig?.timeoutMs ?? 30_000;
  const maxRetries = deps.completionJudgerConfig?.maxRetries ?? 2;
  const retryBackoffMs = deps.completionJudgerConfig?.retryBackoffMs ?? 1_000;

  // Create review session
  const reviewSession = await deps.sessionManager.createSession(
    "task_review",
    task.goal_id,
    task.id
  );

  // Build review context (excludes executor self-report for bias prevention)
  const reviewContext = deps.sessionManager.buildTaskReviewContext(
    task.goal_id,
    task.id
  );

  const criteriaList = task.success_criteria
    .map(
      (c, i) =>
        `${i + 1}. ${c.description} (blocking: ${c.is_blocking}, method: ${c.verification_method})`
    )
    .join("\n");

  const enrichmentBlocks = [knowledgeBlock, stateBlock].filter(Boolean).join("\n");

  const prompt = `Evaluate task execution against success criteria.

Task: ${task.work_description}
Approach: ${task.approach}

Criteria:
${criteriaList}
${enrichmentBlocks ? `\n${enrichmentBlocks}\n` : ""}
Output (first 2000 chars):
${executionResult.output.slice(0, 2000)}

Status: ${executionResult.stopped_reason} | Success: ${executionResult.success}
Context: ${reviewContext.map((s) => s.content).join(" ")}

Return JSON:
{"verdict": "pass"|"partial"|"fail", "reasoning": "...", "criteria_met": #, "criteria_total": #}`;

  // Gateway path: route through PromptGateway when available
  if (deps.gateway) {
    let parsed: z.infer<typeof CompletionJudgerResponseSchema>;
    try {
      parsed = await withRetry(
        () => withTimeout(
          deps.gateway!.execute({
            purpose: "verification",
            goalId: task.goal_id,
            additionalContext: { review_prompt: prompt },
            responseSchema: CompletionJudgerResponseSchema as z.ZodSchema<z.infer<typeof CompletionJudgerResponseSchema>>,
            maxTokens: 1024,
          }),
          timeoutMs
        ),
        maxRetries,
        retryBackoffMs,
        deps.logger,
        `completion_judger for task ${task.id}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.logger?.error(`[completion_judger] All retries exhausted for task ${task.id}: ${msg}`);
      await deps.sessionManager.endSession(reviewSession.id, `completion_judger failed: ${msg}`);
      return {
        passed: false,
        partial: false,
        description: `completion_judger failed after ${maxRetries + 1} attempt(s): ${msg}`,
        confidence: 0.0,
      };
    }
    const verdictStr = parsed.verdict;
    const result = {
      passed: verdictStr === "pass",
      partial: verdictStr === "partial",
      description: parsed.reasoning || "LLM review completed",
      confidence: verdictStr === "pass" ? 0.8 : verdictStr === "partial" ? 0.6 : 0.8,
      criteria_met: parsed.criteria_met,
      criteria_total: parsed.criteria_total,
    };
    await deps.sessionManager.endSession(reviewSession.id, `LLM review: ${verdictStr}`);
    return result;
  }

  // Direct LLM path (fallback when no gateway)
  let response: import("../../llm/llm-client.js").LLMResponse;
  try {
    response = await withRetry(
      () => withTimeout(
        (deps.reviewerLlmClient ?? deps.llmClient).sendMessage(
          [{ role: "user", content: prompt }],
          {
            system: "Review task results objectively against criteria. Ignore executor self-assessment.",
            max_tokens: 1024,
            model_tier: modelTier,
          }
        ),
        timeoutMs
      ),
      maxRetries,
      retryBackoffMs,
      deps.logger,
      `completion_judger for task ${task.id}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger?.error(`[completion_judger] All retries exhausted for task ${task.id}: ${msg}`);
    await deps.sessionManager.endSession(reviewSession.id, `completion_judger failed: ${msg}`);
    return {
      passed: false,
      partial: false,
      description: `completion_judger failed after ${maxRetries + 1} attempt(s): ${msg}`,
      confidence: 0.0,
    };
  }

  try {
    const rawJson = response.content.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    const parseResult = CompletionJudgerResponseSchema.safeParse(JSON.parse(rawJson));
    if (!parseResult.success) {
      deps.logger?.warn(`[completion_judger] Zod parse failed for task ${task.id}: ${parseResult.error.message}`);
      await deps.sessionManager.endSession(reviewSession.id, "Failed to parse LLM review result");
      return {
        passed: false,
        partial: false,
        description: "Failed to parse LLM review result",
        confidence: 0.3,
      };
    }
    const parsed = parseResult.data;
    const verdictStr = parsed.verdict;
    const result = {
      passed: verdictStr === "pass",
      partial: verdictStr === "partial",
      description: parsed.reasoning || "LLM review completed",
      confidence: verdictStr === "pass" ? 0.8 : verdictStr === "partial" ? 0.6 : 0.8,
      criteria_met: parsed.criteria_met,
      criteria_total: parsed.criteria_total,
    };
    await deps.sessionManager.endSession(reviewSession.id, `LLM review: ${verdictStr}`);
    return result;
  } catch {
    deps.logger?.warn(`[completion_judger] JSON.parse failed for task ${task.id}`);
    await deps.sessionManager.endSession(reviewSession.id, "Failed to parse LLM review result");
    return {
      passed: false,
      partial: false,
      description: "Failed to parse LLM review result",
      confidence: 0.3,
    };
  }
}

function parseExecutorReport(executionResult: AgentResult): ExecutorReport {
  // Parse executor's output for self-assessment (reference only)
  return {
    completed: executionResult.success,
    summary: executionResult.output.slice(0, 500),
    partial_results: [],
    blockers: executionResult.error ? [executionResult.error] : [],
  };
}

function isDirectionCorrect(verificationResult: VerificationResult): boolean {
  // Direction is correct when the verdict is "partial" (some criteria met)
  // Direction is wrong when the verdict is "fail" (no criteria met / wrong approach)
  return verificationResult.verdict === "partial";
}

async function attemptRevert(deps: VerifierDeps, task: Task): Promise<boolean> {
  // Attempt to revert a task's changes
  // First try git-based revert (faster, more reliable, no LLM cost)
  // Falls back to LLM-based revert if git is not available or fails
  try {
    const filesToRestore = task.scope_boundary.in_scope;
    if (filesToRestore.length > 0) {
      const { execFileSync } = await import("child_process");
      execFileSync("git", ["restore", ...filesToRestore], { cwd: process.cwd(), encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      deps.logger?.info?.(`[attemptRevert] git restore succeeded for ${filesToRestore.length} files`);
      return true;
    }
  } catch {
    // git not available or failed — fall back to LLM-based revert
  }

  try {
    const revertSession = await deps.sessionManager.createSession(
      "task_execution",
      task.goal_id,
      task.id
    );

    const revertPrompt = `Revert task "${task.work_description}". Undo all changes in: ${task.scope_boundary.in_scope.join(", ")}.

Return JSON: {"success": true|false, "reason": "..."}`;

    const response = await deps.llmClient.sendMessage(
      [{ role: "user", content: revertPrompt }],
      { system: "Revert failed task changes. Respond with JSON only.", max_tokens: 512, model_tier: "main" }
    );

    await deps.sessionManager.endSession(revertSession.id, response.content);

    // Parse structured JSON response
    try {
      const parsed = deps.llmClient.parseJSON(
        response.content,
        z.object({ success: z.boolean(), reason: z.string() })
      );
      return parsed.success;
    } catch {
      // If parse fails, assume revert failed
      return false;
    }
  } catch {
    return false;
  }
}

async function setDimensionIntegrity(
  deps: VerifierDeps,
  goalId: string,
  dimensionName: string,
  integrity: "ok" | "uncertain"
): Promise<void> {
  // Attempt to update the dimension's state_integrity flag
  // Read the goal, find the dimension, update integrity
  const goalData = await deps.stateManager.readRaw(`goals/${goalId}/goal.json`);
  if (goalData && typeof goalData === "object") {
    const goal = goalData as Record<string, unknown>;
    const dimensions = goal.dimensions as Array<Record<string, unknown>> | undefined;
    if (dimensions) {
      for (const dim of dimensions) {
        if (dim.name === dimensionName) {
          dim.state_integrity = integrity;
        }
      }
      await deps.stateManager.writeRaw(`goals/${goalId}/goal.json`, goal);
    }
  }
}

async function appendTaskHistory(deps: VerifierDeps, goalId: string, task: Task): Promise<void> {
  const historyPath = `tasks/${goalId}/task-history.json`;
  const existing = await deps.stateManager.readRaw(historyPath);
  const history = Array.isArray(existing) ? existing : [];

  const actual_elapsed_ms =
    task.started_at && task.completed_at
      ? new Date(task.completed_at).getTime() - new Date(task.started_at).getTime()
      : null;

  const estimated_duration_ms = task.estimated_duration
    ? deps.durationToMs(task.estimated_duration)
    : null;

  history.push({
    task_id: task.id,
    status: task.status,
    primary_dimension: task.primary_dimension,
    consecutive_failure_count: task.consecutive_failure_count,
    completed_at: task.completed_at ?? new Date().toISOString(),
    actual_elapsed_ms,
    estimated_duration_ms,
  });
  await deps.stateManager.writeRaw(historyPath, history);
}

// ─── P0 Guard 1: dimension_updates change magnitude limit (§3.2) ───

/**
 * Clamp a proposed dimension update to within ±30% absolute or ±30% relative
 * of the current value (whichever is larger). Logs a warning when clamping occurs.
 *
 * Exported for unit testing.
 */
export function clampDimensionUpdate(
  current: number,
  proposed: number,
  logger?: Logger,
  dimName?: string
): number {
  const absLimit = 0.3;
  const relLimit = Math.abs(current) * 0.3;
  const maxDelta = Math.max(absLimit, relLimit);
  const clamped = Math.max(current - maxDelta, Math.min(current + maxDelta, proposed));
  if (clamped !== proposed) {
    logger?.warn(
      `dimension_update clamped: dim=${dimName}, proposed=${proposed}, applied=${clamped}, current=${current}`
    );
  }
  return clamped;
}

// ─── §4.5 Guard: dimension_updates direction check ───

/**
 * Check whether a proposed dimension update moves in the intended direction.
 * Returns true if the update should be applied, false if it should be skipped.
 *
 * Exported for unit testing.
 */
export function checkDimensionDirection(
  intendedDirection: "increase" | "decrease" | "neutral" | undefined,
  currentValue: number,
  proposedValue: number,
  logger?: { warn: (msg: string) => void },
  dimName?: string,
): boolean {
  if (!intendedDirection || intendedDirection === "neutral") return true;

  const actualDirection =
    proposedValue > currentValue
      ? "increase"
      : proposedValue < currentValue
        ? "decrease"
        : "neutral";

  if (intendedDirection === "increase" && actualDirection === "decrease") {
    logger?.warn(
      `dimension_update direction mismatch: task intended ${intendedDirection}, but update suggests ${actualDirection} for dim ${dimName ?? "unknown"}`
    );
    return false;
  }
  if (intendedDirection === "decrease" && actualDirection === "increase") {
    logger?.warn(
      `dimension_update direction mismatch: task intended ${intendedDirection}, but update suggests ${actualDirection} for dim ${dimName ?? "unknown"}`
    );
    return false;
  }
  return true;
}
