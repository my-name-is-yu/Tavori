import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentResult } from "../adapter-layer.js";
import type { AgentLoopBudget } from "./agent-loop-budget.js";
import type { AgentLoopModelClient, AgentLoopModelRef, AgentLoopModelRegistry } from "./agent-loop-model.js";
import { createAgentLoopSession, type AgentLoopSession } from "./agent-loop-session.js";
import type { AgentLoopEventSink } from "./agent-loop-events.js";
import type { AgentLoopToolPolicy } from "./agent-loop-turn-context.js";
import { withDefaultBudget } from "./agent-loop-turn-context.js";
import type { BoundedAgentLoopRunner } from "./bounded-agent-loop-runner.js";
import type { AgentLoopSessionState } from "./agent-loop-session-state.js";
import { buildAgentLoopBaseInstructions } from "./agent-loop-prompts.js";
import type { ApprovalRequest, ToolCallContext } from "../../../tools/types.js";
import type { SubagentRole } from "./execution-policy.js";

export const ChatAgentLoopOutputSchema = z.object({
  status: z.enum(["done", "blocked", "failed"]).default("done"),
  message: z.string(),
  evidence: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
});
export type ChatAgentLoopOutput = z.infer<typeof ChatAgentLoopOutputSchema>;

export interface ChatAgentLoopRunnerDeps {
  boundedRunner: BoundedAgentLoopRunner;
  modelClient: AgentLoopModelClient;
  modelRegistry: AgentLoopModelRegistry;
  defaultModel?: AgentLoopModelRef;
  cwd?: string;
  defaultBudget?: Partial<AgentLoopBudget>;
  defaultToolPolicy?: AgentLoopToolPolicy;
  defaultToolCallContext?: Partial<ToolCallContext>;
  createSession?: (input: {
    goalId?: string;
    eventSink?: AgentLoopEventSink;
    resumeStatePath?: string;
    sessionId?: string;
    traceId?: string;
  }) => AgentLoopSession;
}

export interface ChatAgentLoopInput {
  message: string;
  goalId?: string;
  cwd?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  systemPrompt?: string;
  eventSink?: AgentLoopEventSink;
  model?: AgentLoopModelRef;
  budget?: Partial<AgentLoopBudget>;
  toolPolicy?: AgentLoopToolPolicy;
  approvalFn?: (request: ApprovalRequest) => Promise<boolean>;
  toolCallContext?: Partial<ToolCallContext>;
  resumeState?: AgentLoopSessionState;
  resumeStatePath?: string;
  resumeOnly?: boolean;
  role?: SubagentRole;
}

export class ChatAgentLoopRunner {
  constructor(private readonly deps: ChatAgentLoopRunnerDeps) {}

  async execute(input: ChatAgentLoopInput): Promise<AgentResult> {
    const started = Date.now();
    const model = input.model ?? this.deps.defaultModel ?? await this.deps.modelRegistry.defaultModel();
    const modelInfo = await this.deps.modelClient.getModelInfo(model);
    const cwd = input.cwd ?? this.deps.cwd ?? process.cwd();
    const turnId = randomUUID();
    const session = this.deps.createSession?.({
      goalId: input.goalId,
      eventSink: input.eventSink,
      ...(input.resumeStatePath ? { resumeStatePath: input.resumeStatePath } : {}),
      ...(input.resumeState ? { sessionId: input.resumeState.sessionId, traceId: input.resumeState.traceId } : {}),
    }) ?? createAgentLoopSession({
      ...(input.eventSink ? { eventSink: input.eventSink } : {}),
      ...(input.resumeState ? { sessionId: input.resumeState.sessionId, traceId: input.resumeState.traceId } : {}),
    });
    const result = await this.deps.boundedRunner.run({
      session,
      turnId,
      goalId: input.goalId ?? "chat",
      cwd,
      model,
      modelInfo,
      messages: input.resumeOnly
        ? []
        : [
            {
              role: "system",
              content: [
                buildAgentLoopBaseInstructions({
                  mode: "chat",
                  extraRules: [
                    "Use tools to answer the user and operate CoreLoop only through tools.",
                    "Do not call CoreLoop internals directly.",
                  ],
                  role: input.role,
                }),
                input.systemPrompt?.trim() ? input.systemPrompt.trim() : "",
              ].join("\n"),
            },
            ...(input.history ?? []).map((m) => ({ role: m.role, content: m.content })),
            { role: "user" as const, content: input.message },
          ],
      outputSchema: ChatAgentLoopOutputSchema,
      budget: withDefaultBudget({ ...this.deps.defaultBudget, ...input.budget }),
      toolPolicy: { ...this.deps.defaultToolPolicy, ...input.toolPolicy },
      ...(input.resumeState ? { resumeState: input.resumeState } : {}),
      toolCallContext: {
        cwd,
        goalId: input.goalId ?? "chat",
        trustBalance: 0,
        preApproved: true,
        approvalFn: input.approvalFn ?? (async () => false),
        onApprovalRequested: async (request) => {
          await input.eventSink?.emit({
            type: "approval_request",
            eventId: randomUUID(),
            sessionId: session.sessionId,
            traceId: session.traceId,
            turnId,
            goalId: input.goalId ?? "chat",
            createdAt: new Date().toISOString(),
            callId: request.callId ?? `approval:${turnId}`,
            toolName: request.toolName,
            reason: request.reason,
            permissionLevel: request.permissionLevel,
            isDestructive: request.isDestructive,
          });
        },
        ...this.deps.defaultToolCallContext,
        ...input.toolCallContext,
        agentRole: input.role,
      },
    });

    const success = result.success && result.output?.status === "done";
    const fallbackOutput = result.output?.message
      ?? result.finalText
      ?? result.output?.blockers.join("; ")
      ?? result.stopReason;
    return {
      success,
      output: fallbackOutput,
      error: success ? null : result.output?.blockers.join("; ") || result.stopReason,
      exit_code: null,
      elapsed_ms: Date.now() - started,
      stopped_reason: success ? "completed" : result.stopReason === "timeout" ? "timeout" : "error",
      agentLoop: {
        traceId: result.traceId,
        sessionId: result.sessionId,
        turnId: result.turnId,
        stopReason: result.stopReason,
        modelTurns: result.modelTurns,
        toolCalls: result.toolCalls,
        compactions: result.compactions,
        completionEvidence: result.output?.evidence ?? [],
        verificationHints: result.output?.blockers ?? [],
        filesChangedPaths: result.changedFiles,
      },
    };
  }
}
