import { randomUUID } from "node:crypto";
import { cwd as processCwd } from "node:process";
import type { Task } from "../../../base/types/task.js";
import type { ToolCallContext } from "../../../tools/types.js";
import type { AgentLoopBudget } from "./agent-loop-budget.js";
import type { AgentLoopModelInfo, AgentLoopModelRef } from "./agent-loop-model.js";
import type { AgentLoopCompletionValidationResult } from "./agent-loop-result.js";
import type { AgentLoopSession } from "./agent-loop-session.js";
import type { AgentLoopSessionState } from "./agent-loop-session-state.js";
import type { AgentLoopToolPolicy, AgentLoopTurnContext } from "./agent-loop-turn-context.js";
import { withDefaultBudget } from "./agent-loop-turn-context.js";
import { TaskAgentLoopOutputSchema, type TaskAgentLoopOutput } from "./task-agent-loop-result.js";
import { buildAgentLoopBaseInstructions } from "./agent-loop-prompts.js";
import { isTaskRelevantVerificationCommand } from "./task-agent-loop-verification.js";
import type { SubagentRole } from "./execution-policy.js";

export interface TaskAgentLoopContextInput {
  task: Task;
  model: AgentLoopModelRef;
  modelInfo: AgentLoopModelInfo;
  session: AgentLoopSession;
  workspaceContext?: string;
  knowledgeContext?: string;
  systemPrompt?: string;
  userPrompt?: string;
  cwd?: string;
  budget?: Partial<AgentLoopBudget>;
  toolPolicy?: AgentLoopToolPolicy;
  toolCallContext?: Partial<ToolCallContext>;
  resumeState?: AgentLoopSessionState;
  abortSignal?: AbortSignal;
  role?: SubagentRole;
}

export function buildTaskAgentLoopTurnContext(
  input: TaskAgentLoopContextInput,
): AgentLoopTurnContext<TaskAgentLoopOutput> {
  const cwd = input.cwd ?? processCwd();
  const userPrompt = input.userPrompt ?? [
    `Task: ${input.task.work_description}`,
    `Approach: ${input.task.approach}`,
    `Success criteria:\n${input.task.success_criteria.map((c) => `- ${c.description} (verify: ${c.verification_method})`).join("\n")}`,
    input.workspaceContext ? `Workspace context:\n${input.workspaceContext}` : "",
    input.knowledgeContext ? `Knowledge context:\n${input.knowledgeContext}` : "",
    "Return final output as JSON matching the required schema.",
  ].filter(Boolean).join("\n\n");

  return {
    session: input.session,
    turnId: randomUUID(),
    goalId: input.task.goal_id,
    taskId: input.task.id,
    cwd,
    model: input.model,
    modelInfo: input.modelInfo,
    messages: [
      {
        role: "system",
        content: input.systemPrompt ?? buildAgentLoopBaseInstructions({
          mode: "task",
          extraRules: [
            "When you return status=done, include concrete completionEvidence.",
            "If files changed or you claim files changed, run at least one focused verification command through tools before the final answer.",
            "Do not return status=done while blockers remain.",
          ],
          role: input.role,
        }),
      },
      { role: "user", content: userPrompt },
    ],
    outputSchema: TaskAgentLoopOutputSchema,
    budget: withDefaultBudget(input.budget),
    toolPolicy: input.toolPolicy ?? {},
    completionValidator: ({ output, changedFiles, commandResults }): AgentLoopCompletionValidationResult => {
      if (output.status !== "done") return { ok: true, reasons: [] };

      const reasons: string[] = [];
      const runtimeVerifiedCommands = commandResults.filter((result) =>
        result.success && isTaskRelevantVerificationCommand(input.task, result)
      );
      const claimedChangedFiles = [...new Set([...(output.filesChanged ?? []), ...changedFiles])];
      const completionEvidenceCount =
        (output.completionEvidence ?? []).filter((item) => item.trim().length > 0).length
        + runtimeVerifiedCommands.length;

      if (!output.finalAnswer.trim()) {
        reasons.push("finalAnswer is empty.");
      }
      if ((output.blockers ?? []).length > 0) {
        reasons.push("status=done cannot include blockers.");
      }
      if (completionEvidenceCount < 1) {
        reasons.push("Provide at least one concrete completionEvidence item or one successful runtime verification command.");
      }
      if (claimedChangedFiles.length > 0 && runtimeVerifiedCommands.length < 1) {
        reasons.push(`You claimed changed files (${claimedChangedFiles.slice(0, 5).join(", ")}) but no successful runtime verification command was observed.`);
      }

      return {
        ok: reasons.length === 0,
        reasons,
      };
    },
    toolCallContext: {
      cwd,
      goalId: input.task.goal_id,
      trustBalance: 0,
      preApproved: true,
      approvalFn: async () => false,
      agentRole: input.role,
      ...input.toolCallContext,
    },
    ...(input.resumeState ? { resumeState: input.resumeState } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  };
}
