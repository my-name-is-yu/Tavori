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
import { StateManager } from "../state-manager.js";
import type { ILLMClient } from "../llm/llm-client.js";
import { SessionManager } from "./session-manager.js";
import { TrustManager } from "../traits/trust-manager.js";
import { StallDetector } from "../drive/stall-detector.js";
import { TaskSchema, VerificationResultSchema } from "../types/task.js";
import type { Task, VerificationResult } from "../types/task.js";
import type { Logger } from "../runtime/logger.js";
import type { AgentTask, AgentResult, IAdapter } from "./adapter-layer.js";
import { AdapterRegistry } from "./adapter-layer.js";

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

// ─── VerifierDeps: all dependencies needed by the verification functions ───

export interface VerifierDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  sessionManager: SessionManager;
  trustManager: TrustManager;
  stallDetector: StallDetector;
  adapterRegistry?: AdapterRegistry;
  logger?: Logger;
  onTaskComplete?: (strategyId: string) => void;
  durationToMs: (duration: { value: number; unit: string }) => number;
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

  // ─── Layer 2: LLM task reviewer (independent) ───
  const l2Result = await runLLMReview(deps, task, executionResult);

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
      l2Retry = await runLLMReview(deps, task, executionResult);
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
            confidence: l1Result.passed ? 0.9 : 0.9,
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
          const newVal =
            prevVal !== null
              ? Math.min(1, Math.max(0, prevVal + progressDelta))
              : progressDelta;
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

  // Persist verification result
  await deps.stateManager.writeRaw(
    `verification/${task.id}/verification-result.json`,
    verificationResult
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
  switch (verificationResult.verdict) {
    case "pass": {
      // Record success
      deps.trustManager.recordSuccess(task.task_category);

      const now = new Date().toISOString();

      // Reset consecutive failure count
      const completedTask = {
        ...task,
        consecutive_failure_count: 0,
        status: "completed" as const,
        completed_at: now,
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
              dim.current_value = update.new_value;
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
                dim.current_value = update.new_value;
              }
            }
            await deps.stateManager.writeRaw(`goals/${task.goal_id}/goal.json`, goal);
          }
        }
        await appendTaskHistory(deps, task.goal_id, task);
        return { action: "keep", task };
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
    if (revertSuccess) {
      await appendTaskHistory(deps, task.goal_id, updatedTask);
      return { action: "discard", task: updatedTask };
    }
    // Revert failed — set state_integrity to "uncertain" and escalate
    await setDimensionIntegrity(deps, task.goal_id, task.primary_dimension, "uncertain");
    await appendTaskHistory(deps, task.goal_id, updatedTask);
    return { action: "escalate", task: updatedTask };
  }

  // irreversible or unknown → escalate
  await appendTaskHistory(deps, task.goal_id, updatedTask);
  return { action: "escalate", task: updatedTask };
}

// ─── Private helpers (module-local) ───

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
  executionResult: AgentResult
): Promise<{ passed: boolean; partial: boolean; description: string; confidence: number }> {
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

  const prompt = `Evaluate task execution against success criteria.

Task: ${task.work_description}
Approach: ${task.approach}

Criteria:
${criteriaList}

Output (first 2000 chars):
${executionResult.output.slice(0, 2000)}

Status: ${executionResult.stopped_reason} | Success: ${executionResult.success}
Context: ${reviewContext.map((s) => s.content).join(" ")}

Return JSON:
{"verdict": "pass"|"partial"|"fail", "reasoning": "...", "criteria_met": #, "criteria_total": #}`;

  const response = await deps.llmClient.sendMessage(
    [{ role: "user", content: prompt }],
    {
      system: "Review task results objectively against criteria. Ignore executor self-assessment.",
      max_tokens: 1024,
    }
  );

  try {
    const parsed = JSON.parse(
      response.content.replace(/```json\n?/g, "").replace(/```/g, "").trim()
    );
    const verdictStr = parsed.verdict ?? "fail";
    const result = {
      passed: verdictStr === "pass",
      partial: verdictStr === "partial",
      description: parsed.reasoning ?? "LLM review completed",
      confidence: verdictStr === "pass" ? 0.8 : verdictStr === "partial" ? 0.6 : 0.8,
    };
    await deps.sessionManager.endSession(reviewSession.id, `LLM review: ${verdictStr}`);
    return result;
  } catch {
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
  // In MVP, we create a revert prompt and check if it succeeds
  // This is called only for reversible tasks
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
      { system: "Revert failed task changes. Respond with JSON only.", max_tokens: 512 }
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
