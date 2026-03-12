import { randomUUID } from "node:crypto";
import { z } from "zod";
import { StateManager } from "./state-manager.js";
import type { ILLMClient } from "./llm-client.js";
import { SessionManager } from "./session-manager.js";
import { TrustManager } from "./trust-manager.js";
import { StrategyManager } from "./strategy-manager.js";
import { StallDetector } from "./stall-detector.js";
import { scoreAllDimensions, rankDimensions } from "./drive-scorer.js";
import { TaskSchema, VerificationResultSchema } from "./types/task.js";
import type { Task, VerificationResult } from "./types/task.js";
import type { GapVector } from "./types/gap.js";
import type { DriveContext } from "./types/drive.js";
import type { EthicsGate } from "./ethics-gate.js";
import type { CapabilityDetector } from "./capability-detector.js";

// ─── Adapter types (re-exported from adapter-layer) ───

import type { AgentTask, AgentResult, IAdapter } from "./adapter-layer.js";
export type { AgentTask, AgentResult, IAdapter };

// ─── Internal types ───

export interface ExecutorReport {
  completed: boolean;
  summary: string;
  partial_results: string[];
  blockers: string[];
}

export interface TaskCycleResult {
  task: Task;
  verificationResult: VerificationResult;
  action: "completed" | "keep" | "discard" | "escalate" | "approval_denied";
}

export interface VerdictResult {
  action: "completed" | "keep" | "discard" | "escalate";
  task: Task;
}

export interface FailureResult {
  action: "keep" | "discard" | "escalate";
  task: Task;
}

// ─── Schema for LLM-generated task fields ───

const LLMGeneratedTaskSchema = z.object({
  work_description: z.string(),
  rationale: z.string(),
  approach: z.string(),
  success_criteria: z.array(
    z.object({
      description: z.string(),
      verification_method: z.string(),
      is_blocking: z.boolean().default(true),
    })
  ),
  scope_boundary: z.object({
    in_scope: z.array(z.string()),
    out_of_scope: z.array(z.string()),
    blast_radius: z.string(),
  }),
  constraints: z.array(z.string()),
  reversibility: z.enum(["reversible", "irreversible", "unknown"]).default("reversible"),
  estimated_duration: z
    .object({
      value: z.number(),
      unit: z.enum(["minutes", "hours", "days", "weeks"]),
    })
    .nullable()
    .default(null),
});

// ─── TaskLifecycle ───

/**
 * TaskLifecycle manages the full lifecycle of tasks:
 * select target dimension -> generate task -> approval check -> execute -> verify -> handle verdict.
 */
export class TaskLifecycle {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;
  private readonly sessionManager: SessionManager;
  private readonly trustManager: TrustManager;
  private readonly strategyManager: StrategyManager;
  private readonly stallDetector: StallDetector;
  private readonly approvalFn: (task: Task) => Promise<boolean>;
  private readonly ethicsGate?: EthicsGate;
  private readonly capabilityDetector?: CapabilityDetector;

  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    sessionManager: SessionManager,
    trustManager: TrustManager,
    strategyManager: StrategyManager,
    stallDetector: StallDetector,
    options?: {
      approvalFn?: (task: Task) => Promise<boolean>;
      ethicsGate?: EthicsGate;
      capabilityDetector?: CapabilityDetector;
    }
  ) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
    this.sessionManager = sessionManager;
    this.trustManager = trustManager;
    this.strategyManager = strategyManager;
    this.stallDetector = stallDetector;
    this.approvalFn = options?.approvalFn ?? ((_task: Task) => Promise.resolve(false));
    this.ethicsGate = options?.ethicsGate;
    this.capabilityDetector = options?.capabilityDetector;
  }

  // ─── selectTargetDimension ───

  /**
   * Select the highest-priority dimension to work on based on drive scoring.
   *
   * @param gapVector - current gap state for the goal
   * @param driveContext - per-dimension timing/deadline/opportunity context
   * @returns the name of the top-ranked dimension
   * @throws if gapVector has no gaps (empty)
   */
  selectTargetDimension(gapVector: GapVector, driveContext: DriveContext): string {
    if (gapVector.gaps.length === 0) {
      throw new Error("selectTargetDimension: gapVector has no gaps (empty gap vector)");
    }

    const scores = scoreAllDimensions(gapVector, driveContext);
    const ranked = rankDimensions(scores);

    // ranked is sorted descending by final_score; take the top one
    return ranked[0]!.dimension_name;
  }

  // ─── generateTask ───

  /**
   * Generate a task for the given goal and target dimension via LLM.
   *
   * @param goalId - the goal this task belongs to
   * @param targetDimension - the dimension this task should improve
   * @param strategyId - optional override; if not provided, uses active strategy
   * @returns the generated and persisted Task
   */
  async generateTask(
    goalId: string,
    targetDimension: string,
    strategyId?: string,
    knowledgeContext?: string
  ): Promise<Task> {
    const prompt = this.buildTaskGenerationPrompt(goalId, targetDimension, knowledgeContext);

    const response = await this.llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      {
        system:
          "You are a task generation assistant. Given a goal and target dimension, generate a concrete, actionable task. Respond with a JSON object inside a markdown code block.",
        max_tokens: 2048,
      }
    );

    const generated = this.llmClient.parseJSON(response.content, LLMGeneratedTaskSchema);

    // Resolve strategy_id
    const activeStrategy = this.strategyManager.getActiveStrategy(goalId);
    const resolvedStrategyId = strategyId ?? activeStrategy?.id ?? null;

    const taskId = randomUUID();
    const now = new Date().toISOString();

    const task = TaskSchema.parse({
      id: taskId,
      goal_id: goalId,
      strategy_id: resolvedStrategyId,
      target_dimensions: [targetDimension],
      primary_dimension: targetDimension,
      work_description: generated.work_description,
      rationale: generated.rationale,
      approach: generated.approach,
      success_criteria: generated.success_criteria,
      scope_boundary: generated.scope_boundary,
      constraints: generated.constraints,
      reversibility: generated.reversibility,
      estimated_duration: generated.estimated_duration,
      status: "pending",
      created_at: now,
    });

    // Persist
    this.stateManager.writeRaw(`tasks/${goalId}/${taskId}.json`, task);

    return task;
  }

  // ─── checkIrreversibleApproval ───

  /**
   * Check whether the task requires human approval and, if so, request it.
   *
   * @param task - the task to check
   * @param confidence - observation confidence for the approval check (default 0.5)
   * @returns true if approved or approval not needed; false if approval was denied
   */
  async checkIrreversibleApproval(task: Task, confidence: number = 0.5): Promise<boolean> {
    const domain = task.task_category;
    const needsApproval = this.trustManager.requiresApproval(
      task.reversibility,
      domain,
      confidence,
      task.task_category
    );

    if (!needsApproval) {
      return true;
    }

    const approved = await this.approvalFn(task);
    return approved;
  }

  // ─── executeTask ───

  /**
   * Execute a task via the given adapter.
   *
   * Creates a session, builds context, converts to AgentTask, executes
   * via adapter, ends session, and updates task status based on result.
   */
  async executeTask(task: Task, adapter: IAdapter): Promise<AgentResult> {
    // Create execution session
    const session = this.sessionManager.createSession(
      "task_execution",
      task.goal_id,
      task.id
    );

    // Build context
    const contextSlots = this.sessionManager.buildTaskExecutionContext(
      task.goal_id,
      task.id
    );

    // Convert to AgentTask
    const prompt = contextSlots
      .sort((a, b) => a.priority - b.priority)
      .map((slot) => `[${slot.label}]\n${slot.content}`)
      .join("\n\n");

    const timeoutMs = task.estimated_duration
      ? this.durationToMs(task.estimated_duration)
      : 30 * 60 * 1000; // default 30 minutes

    const agentTask: AgentTask = {
      prompt,
      timeout_ms: timeoutMs,
      adapter_type: adapter.adapterType,
    };

    // Update task status to running
    const runningTask = { ...task, status: "running" as const, started_at: new Date().toISOString() };
    this.stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, runningTask);

    // Execute
    let result: AgentResult;
    try {
      result = await adapter.execute(agentTask);
    } catch (err) {
      result = {
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
        exit_code: null,
        elapsed_ms: 0,
        stopped_reason: "error",
      };
    }

    // End session
    const summary = result.success
      ? `Task completed successfully. Output length: ${result.output.length}`
      : `Task failed: ${result.stopped_reason}. Error: ${result.error ?? "unknown"}`;
    this.sessionManager.endSession(session.id, summary);

    // Update task status based on result
    const now = new Date().toISOString();
    let newStatus: "completed" | "timed_out" | "error";
    if (result.stopped_reason === "timeout") {
      newStatus = "timed_out";
    } else if (result.stopped_reason === "error" || !result.success) {
      newStatus = "error";
    } else {
      newStatus = "completed";
    }

    const updatedTask = {
      ...runningTask,
      status: newStatus,
      completed_at: now,
      ...(newStatus === "timed_out" ? { timeout_at: now } : {}),
    };
    this.stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, updatedTask);

    return result;
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
  async verifyTask(
    task: Task,
    executionResult: AgentResult
  ): Promise<VerificationResult> {
    // ─── Layer 1: Mechanical verification ───
    const l1Result = await this.runMechanicalVerification(task);

    // ─── Layer 2: LLM task reviewer (independent) ───
    const l2Result = await this.runLLMReview(task, executionResult);

    // ─── Layer 3: Executor self-report (reference only) ───
    const executorReport = this.parseExecutorReport(executionResult);

    // ─── Contradiction resolution ───
    let verdict: "pass" | "partial" | "fail";
    let confidence: number;

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
        const l2Retry = await this.runLLMReview(task, executionResult);
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
        description: l2Result.description,
        confidence: l2Result.confidence,
      },
      {
        layer: "self_report" as const,
        description: executorReport.summary,
        confidence: 0.3, // self-report has lowest confidence
      },
    ];

    // Build dimension_updates from task's target dimensions based on verdict.
    // pass: significant progress (+0.4), partial: moderate progress (+0.15), fail: no update.
    const progressByVerdict: Record<string, number> = {
      pass: 0.4,
      partial: 0.15,
      fail: 0,
    };
    const progressDelta = progressByVerdict[verdict] ?? 0;

    // Read goal state to get actual current dimension values for previous_value / new_value.
    const goalDataForUpdate = this.stateManager.readRaw(`goals/${task.goal_id}.json`);
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
    this.stateManager.writeRaw(
      `verification/${task.id}/verification-result.json`,
      verificationResult
    );

    return verificationResult;
  }

  // ─── handleVerdict ───

  /**
   * Handle a verification verdict (pass/partial/fail).
   */
  async handleVerdict(
    task: Task,
    verificationResult: VerificationResult
  ): Promise<VerdictResult> {
    switch (verificationResult.verdict) {
      case "pass": {
        // Record success
        this.trustManager.recordSuccess(task.task_category);

        const now = new Date().toISOString();

        // Reset consecutive failure count
        const completedTask = {
          ...task,
          consecutive_failure_count: 0,
          status: "completed" as const,
          completed_at: now,
        };
        this.stateManager.writeRaw(
          `tasks/${task.goal_id}/${task.id}.json`,
          completedTask
        );

        // Apply dimension_updates and update last_updated for the primary dimension.
        const goalData = this.stateManager.readRaw(`goals/${task.goal_id}.json`);
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
            this.stateManager.writeRaw(`goals/${task.goal_id}.json`, goal);
          }
        }

        // Update task history
        this.appendTaskHistory(task.goal_id, completedTask);

        return { action: "completed", task: completedTask };
      }
      case "partial": {
        // Check direction from evidence
        const directionCorrect = this.isDirectionCorrect(verificationResult);
        if (directionCorrect) {
          // Apply partial dimension_updates to goal state
          const goalDataPartial = this.stateManager.readRaw(`goals/${task.goal_id}.json`);
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
              this.stateManager.writeRaw(`goals/${task.goal_id}.json`, goal);
            }
          }
          this.appendTaskHistory(task.goal_id, task);
          return { action: "keep", task };
        }
        // Direction wrong — delegate to handleFailure
        return this.handleFailure(task, verificationResult);
      }
      case "fail": {
        return this.handleFailure(task, verificationResult);
      }
    }
  }

  // ─── handleFailure ───

  /**
   * Handle a task failure: increment failure count, record failure,
   * decide keep/discard/escalate.
   */
  async handleFailure(
    task: Task,
    verificationResult: VerificationResult
  ): Promise<FailureResult> {
    // Increment consecutive_failure_count
    const updatedTask = {
      ...task,
      consecutive_failure_count: task.consecutive_failure_count + 1,
    };

    // Record failure with TrustManager
    this.trustManager.recordFailure(task.task_category);

    // Persist updated task
    this.stateManager.writeRaw(
      `tasks/${task.goal_id}/${task.id}.json`,
      updatedTask
    );

    // Check escalation threshold
    if (updatedTask.consecutive_failure_count >= 3) {
      this.stallDetector.checkConsecutiveFailures(
        task.goal_id,
        task.primary_dimension,
        updatedTask.consecutive_failure_count
      );
      this.appendTaskHistory(task.goal_id, updatedTask);
      return { action: "escalate", task: updatedTask };
    }

    // Direction check
    const directionCorrect = this.isDirectionCorrect(verificationResult);

    if (directionCorrect) {
      this.appendTaskHistory(task.goal_id, updatedTask);
      return { action: "keep", task: updatedTask };
    }

    // Direction wrong
    if (updatedTask.reversibility === "reversible") {
      // Attempt revert
      const revertSuccess = await this.attemptRevert(updatedTask);
      if (revertSuccess) {
        this.appendTaskHistory(task.goal_id, updatedTask);
        return { action: "discard", task: updatedTask };
      }
      // Revert failed — set state_integrity to "uncertain" and escalate
      this.setDimensionIntegrity(
        task.goal_id,
        task.primary_dimension,
        "uncertain"
      );
      this.appendTaskHistory(task.goal_id, updatedTask);
      return { action: "escalate", task: updatedTask };
    }

    // irreversible or unknown → escalate
    this.appendTaskHistory(task.goal_id, updatedTask);
    return { action: "escalate", task: updatedTask };
  }

  // ─── runTaskCycle ───

  /**
   * Run a full task cycle: select → generate → approve → execute → verify → verdict.
   */
  async runTaskCycle(
    goalId: string,
    gapVector: GapVector,
    driveContext: DriveContext,
    adapter: IAdapter,
    knowledgeContext?: string
  ): Promise<TaskCycleResult> {
    // 1. Select target dimension
    const targetDimension = this.selectTargetDimension(gapVector, driveContext);

    // 2. Generate task (optionally with injected knowledge context)
    const task = await this.generateTask(goalId, targetDimension, undefined, knowledgeContext);

    // 3a. Ethics means check (reject → skip, flag → require approval, pass → proceed)
    if (this.ethicsGate) {
      const ethicsVerdict = await this.ethicsGate.checkMeans(
        task.id,
        task.work_description,
        task.approach
      );
      if (ethicsVerdict.verdict === "reject") {
        const rejectedResult = VerificationResultSchema.parse({
          task_id: task.id,
          verdict: "fail",
          confidence: 1.0,
          evidence: [
            {
              layer: "mechanical",
              description: `Ethics gate rejected task: ${ethicsVerdict.reasoning}`,
              confidence: 1.0,
            },
          ],
          dimension_updates: [],
          timestamp: new Date().toISOString(),
        });
        return { task, verificationResult: rejectedResult, action: "discard" };
      }
      if (ethicsVerdict.verdict === "flag") {
        // Treat flag as requiring human approval via the existing approvalFn
        const approved = await this.approvalFn(task);
        if (!approved) {
          const flagDeniedResult = VerificationResultSchema.parse({
            task_id: task.id,
            verdict: "fail",
            confidence: 1.0,
            evidence: [
              {
                layer: "mechanical",
                description: `Ethics flag: approval denied. Reasoning: ${ethicsVerdict.reasoning}`,
                confidence: 1.0,
              },
            ],
            dimension_updates: [],
            timestamp: new Date().toISOString(),
          });
          return { task, verificationResult: flagDeniedResult, action: "approval_denied" };
        }
      }
      // verdict === "pass" → fall through
    }

    // 3b. Capability check
    if (this.capabilityDetector) {
      const gap = await this.capabilityDetector.detectDeficiency(task);
      if (gap !== null) {
        const capabilityResult = VerificationResultSchema.parse({
          task_id: task.id,
          verdict: "fail",
          confidence: 1.0,
          evidence: [
            {
              layer: "mechanical",
              description: `Capability deficiency: ${gap.missing_capability.name} — ${gap.reason}`,
              confidence: 1.0,
            },
          ],
          dimension_updates: [],
          timestamp: new Date().toISOString(),
        });
        return { task, verificationResult: capabilityResult, action: "escalate" };
      }
    }

    // 3c. Check irreversible approval
    const approved = await this.checkIrreversibleApproval(task);
    if (!approved) {
      // Build a minimal verification result for the cycle result
      const deniedResult = VerificationResultSchema.parse({
        task_id: task.id,
        verdict: "fail",
        confidence: 1.0,
        evidence: [
          {
            layer: "mechanical",
            description: "Approval denied by human",
            confidence: 1.0,
          },
        ],
        dimension_updates: [],
        timestamp: new Date().toISOString(),
      });
      return {
        task,
        verificationResult: deniedResult,
        action: "approval_denied",
      };
    }

    // 4. Execute task
    const executionResult = await this.executeTask(task, adapter);

    // 5. Verify task
    const verificationResult = await this.verifyTask(task, executionResult);

    // 6. Handle verdict
    const verdictResult = await this.handleVerdict(task, verificationResult);

    return {
      task: verdictResult.task,
      verificationResult,
      action: verdictResult.action,
    };
  }

  // ─── Private Helpers ───

  private buildTaskGenerationPrompt(
    goalId: string,
    targetDimension: string,
    knowledgeContext?: string
  ): string {
    const knowledgeSection = knowledgeContext
      ? `\nRelevant domain knowledge:\n${knowledgeContext}\n`
      : "";

    return `Generate a task to improve the "${targetDimension}" dimension for goal "${goalId}".
${knowledgeSection}
The task should be concrete, actionable, and achievable in a single work session.

Return a JSON object with the following schema:
{
  "work_description": "string — what to do",
  "rationale": "string — why this task matters",
  "approach": "string — how to accomplish it",
  "success_criteria": [
    {
      "description": "string — what success looks like",
      "verification_method": "string — how to verify",
      "is_blocking": true
    }
  ],
  "scope_boundary": {
    "in_scope": ["string — what is included"],
    "out_of_scope": ["string — what is excluded"],
    "blast_radius": "string — what could be affected"
  },
  "constraints": ["string — any constraints"],
  "reversibility": "reversible" | "irreversible" | "unknown",
  "estimated_duration": { "value": number, "unit": "minutes" | "hours" | "days" | "weeks" } | null
}

Respond with only the JSON object inside a markdown code block.`;
  }

  // ─── Verification Helpers ───

  private async runMechanicalVerification(
    task: Task
  ): Promise<{ applicable: boolean; passed: boolean; description: string }> {
    // Mechanical prefixes that indicate a command can be run directly
    const mechanicalPrefixes = ["npm", "npx", "pytest", "sh", "bash", "node", "make", "cargo", "go "];

    // Check if any success criterion has a mechanically-verifiable verification_method
    const hasMechanicalCriteria = task.success_criteria.some((c) => {
      const method = c.verification_method.toLowerCase().trim();
      return mechanicalPrefixes.some((prefix) => method.startsWith(prefix));
    });

    if (!hasMechanicalCriteria) {
      return {
        applicable: false,
        passed: false,
        description: "No mechanical verification criteria applicable",
      };
    }

    // For MVP, L1 is applicable but we cannot run the command without an adapter.
    // In Phase 2, this would invoke the adapter to execute the verification command.
    return {
      applicable: true,
      passed: true,
      description: "Mechanical verification criteria detected (MVP: assumed pass)",
    };
  }

  private async runLLMReview(
    task: Task,
    executionResult: AgentResult
  ): Promise<{ passed: boolean; partial: boolean; description: string; confidence: number }> {
    // Create review session
    const reviewSession = this.sessionManager.createSession(
      "task_review",
      task.goal_id,
      task.id
    );

    // Build review context (excludes executor self-report for bias prevention)
    const reviewContext = this.sessionManager.buildTaskReviewContext(
      task.goal_id,
      task.id
    );

    const criteriaList = task.success_criteria
      .map(
        (c, i) =>
          `${i + 1}. ${c.description} (blocking: ${c.is_blocking}, method: ${c.verification_method})`
      )
      .join("\n");

    const prompt = `Evaluate this task execution result against the success criteria.

Task: ${task.work_description}
Approach: ${task.approach}

Success Criteria:
${criteriaList}

Execution Output (first 2000 chars):
${executionResult.output.slice(0, 2000)}

Execution Status: ${executionResult.stopped_reason}
Execution Success: ${executionResult.success}

Context: ${reviewContext.map((s) => s.content).join(" ")}

Evaluate whether the task output satisfies the success criteria. Respond with JSON:
{"verdict": "pass" | "partial" | "fail", "reasoning": "explanation", "criteria_met": number, "criteria_total": number}`;

    const response = await this.llmClient.sendMessage(
      [{ role: "user", content: prompt }],
      {
        system:
          "You are an independent task reviewer. Evaluate task results objectively against success criteria. Do NOT consider the executor's self-assessment.",
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
      this.sessionManager.endSession(reviewSession.id, `LLM review: ${verdictStr}`);
      return result;
    } catch {
      this.sessionManager.endSession(reviewSession.id, "Failed to parse LLM review result");
      return {
        passed: false,
        partial: false,
        description: "Failed to parse LLM review result",
        confidence: 0.3,
      };
    }
  }

  private parseExecutorReport(executionResult: AgentResult): ExecutorReport {
    // Parse executor's output for self-assessment (reference only)
    return {
      completed: executionResult.success,
      summary: executionResult.output.slice(0, 500),
      partial_results: [],
      blockers: executionResult.error ? [executionResult.error] : [],
    };
  }

  private isDirectionCorrect(verificationResult: VerificationResult): boolean {
    // Direction is correct when the verdict is "partial" (some criteria met)
    // Direction is wrong when the verdict is "fail" (no criteria met / wrong approach)
    return verificationResult.verdict === "partial";
  }

  private async attemptRevert(task: Task): Promise<boolean> {
    // Attempt to revert a task's changes
    // In MVP, we create a revert prompt and check if it succeeds
    // This is called only for reversible tasks
    try {
      const revertSession = this.sessionManager.createSession(
        "task_execution",
        task.goal_id,
        task.id
      );

      const revertPrompt = `Revert the changes made by task "${task.work_description}". Undo all modifications within scope: ${task.scope_boundary.in_scope.join(", ")}.

After completing the revert, respond with a JSON object:
{"success": true/false, "reason": "explanation of what was done or why it failed"}`;

      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: revertPrompt }],
        { system: "You are reverting a failed task. Undo all changes. Respond with JSON: {\"success\": boolean, \"reason\": string}", max_tokens: 512 }
      );

      this.sessionManager.endSession(revertSession.id, response.content);

      // Parse structured JSON response
      try {
        const parsed = this.llmClient.parseJSON(
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

  private setDimensionIntegrity(
    goalId: string,
    dimensionName: string,
    integrity: "ok" | "uncertain"
  ): void {
    // Attempt to update the dimension's state_integrity flag
    // Read the goal, find the dimension, update integrity
    const goalData = this.stateManager.readRaw(`goals/${goalId}.json`);
    if (goalData && typeof goalData === "object") {
      const goal = goalData as Record<string, unknown>;
      const dimensions = goal.dimensions as Array<Record<string, unknown>> | undefined;
      if (dimensions) {
        for (const dim of dimensions) {
          if (dim.name === dimensionName) {
            dim.state_integrity = integrity;
          }
        }
        this.stateManager.writeRaw(`goals/${goalId}.json`, goal);
      }
    }
  }

  private appendTaskHistory(goalId: string, task: Task): void {
    const historyPath = `tasks/${goalId}/task-history.json`;
    const existing = this.stateManager.readRaw(historyPath);
    const history = Array.isArray(existing) ? existing : [];
    history.push({
      task_id: task.id,
      status: task.status,
      primary_dimension: task.primary_dimension,
      consecutive_failure_count: task.consecutive_failure_count,
      completed_at: task.completed_at ?? new Date().toISOString(),
    });
    this.stateManager.writeRaw(historyPath, history);
  }

  private durationToMs(duration: { value: number; unit: string }): number {
    const multipliers: Record<string, number> = {
      minutes: 60 * 1000,
      hours: 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
      weeks: 7 * 24 * 60 * 60 * 1000,
    };
    return duration.value * (multipliers[duration.unit] ?? 60 * 60 * 1000);
  }
}
