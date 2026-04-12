import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { AgentLoopBudget } from "./agent-loop-budget.js";
import type { AgentLoopModelInfo, AgentLoopModelRef } from "./agent-loop-model.js";
import type { AgentLoopResult } from "./agent-loop-result.js";
import { createAgentLoopSession } from "./agent-loop-session.js";
import type { AgentLoopToolPolicy } from "./agent-loop-turn-context.js";
import { withDefaultBudget } from "./agent-loop-turn-context.js";
import type { BoundedAgentLoopRunner } from "./bounded-agent-loop-runner.js";

export type CorePhaseKind =
  | "observe_evidence"
  | "knowledge_refresh"
  | "stall_investigation"
  | "replanning_options"
  | "verification_evidence";

export interface CorePhaseSpec<TInput, TOutput> {
  phase: CorePhaseKind;
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  outputSchema: z.ZodType<TOutput, z.ZodTypeDef, unknown>;
  requiredTools: readonly string[];
  allowedTools: readonly string[];
  budget?: Partial<AgentLoopBudget>;
  failPolicy: "return_low_confidence" | "fail_cycle" | "fallback_deterministic";
}

export interface CorePhaseRunnerDeps {
  boundedRunner: BoundedAgentLoopRunner;
  model: AgentLoopModelRef;
  modelInfo: AgentLoopModelInfo;
  cwd: string;
}

export class CorePhaseRunner {
  constructor(private readonly deps: CorePhaseRunnerDeps) {}

  async run<TInput, TOutput>(
    spec: CorePhaseSpec<TInput, TOutput>,
    input: TInput,
    context: { goalId: string; taskId?: string; toolPolicy?: AgentLoopToolPolicy },
  ): Promise<AgentLoopResult<TOutput>> {
    const parsedInput = spec.inputSchema.parse(input);
    return this.deps.boundedRunner.run({
      session: createAgentLoopSession(),
      turnId: randomUUID(),
      goalId: context.goalId,
      ...(context.taskId ? { taskId: context.taskId } : {}),
      cwd: this.deps.cwd,
      model: this.deps.model,
      modelInfo: this.deps.modelInfo,
      messages: [
        { role: "system", content: `You are running CoreLoop phase ${spec.phase}. Return schema-valid evidence only.` },
        { role: "user", content: JSON.stringify(parsedInput) },
      ],
      outputSchema: spec.outputSchema,
      budget: withDefaultBudget(spec.budget),
      toolPolicy: {
        allowedTools: spec.allowedTools,
        requiredTools: spec.requiredTools,
        ...context.toolPolicy,
      },
      toolCallContext: {
        cwd: this.deps.cwd,
        goalId: context.goalId,
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });
  }
}
