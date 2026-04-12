import { randomUUID } from "node:crypto";
import { execFileNoThrow } from "../../../base/utils/execFileNoThrow.js";
import type { z } from "zod";
import type { AgentLoopStopReason } from "./agent-loop-budget.js";
import type { AgentLoopMessage, AgentLoopModelClient, AgentLoopModelTurnProtocol } from "./agent-loop-model.js";
import type { AgentLoopCommandResult, AgentLoopResult } from "./agent-loop-result.js";
import type { AgentLoopToolRuntime } from "./agent-loop-tool-runtime.js";
import type { AgentLoopToolRouter } from "./agent-loop-tool-router.js";
import type { AgentLoopTurnContext } from "./agent-loop-turn-context.js";
import { createAgentLoopHistory } from "./agent-loop-history.js";
import { formatAgentLoopModelRef } from "./agent-loop-model.js";
import type { AgentLoopCompactionPhase, AgentLoopCompactionReason, AgentLoopCompactor } from "./agent-loop-compactor.js";
import { ExtractiveAgentLoopCompactor } from "./agent-loop-compactor.js";
import { classifyAgentLoopCommandResult } from "./agent-loop-command-classifier.js";
import type { AgentLoopSessionState } from "./agent-loop-session-state.js";

export interface BoundedAgentLoopRunnerDeps {
  modelClient: AgentLoopModelClient;
  toolRouter: AgentLoopToolRouter;
  toolRuntime: AgentLoopToolRuntime;
  compactor?: AgentLoopCompactor;
}

export class BoundedAgentLoopRunner {
  private readonly compactor: AgentLoopCompactor;

  constructor(private readonly deps: BoundedAgentLoopRunnerDeps) {
    this.compactor = deps.compactor ?? new ExtractiveAgentLoopCompactor();
  }

  async run<TOutput>(turn: AgentLoopTurnContext<TOutput>): Promise<AgentLoopResult<TOutput>> {
    const startedAt = Date.now();
    const resumed = turn.resumeState ?? await turn.session.stateStore.load();
    let modelTurns = resumed?.modelTurns ?? 0;
    let toolCalls = resumed?.toolCalls ?? 0;
    let consecutiveToolErrors = 0;
    let schemaRepairAttempts = 0;
    let completionValidationAttempts = resumed?.completionValidationAttempts ?? 0;
    let finalText = resumed?.finalText ?? "";
    let compactions = resumed?.compactions ?? 0;
    const calledTools = new Set<string>(resumed?.calledTools ?? []);
    let lastToolLoopSignature: string | null = resumed?.lastToolLoopSignature ?? null;
    let repeatedToolLoopCount = resumed?.repeatedToolLoopCount ?? 0;
    const commandResults: AgentLoopCommandResult[] = [];
    const initialWorkspaceSnapshot = await this.captureWorkspaceSnapshot(turn.cwd);

    await this.record(turn, {
      type: "started",
      ...this.baseEvent(turn),
    });

    if (resumed) {
      await this.record(turn, {
        type: "resumed",
        ...this.baseEvent(turn),
        fromUpdatedAt: resumed.updatedAt,
        restoredMessages: resumed.messages.length,
      });
    }

    if (!turn.modelInfo.capabilities.toolCalling) {
      return this.stop(turn, "model_without_tool_calling", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, [], commandResults);
    }

    let messages: AgentLoopMessage[] = resumed?.messages ? [...resumed.messages] : [...turn.messages];
    const preTurnCompaction = await this.compactIfNeeded(turn, messages, "pre_turn", "context_limit", undefined, compactions);
    if (preTurnCompaction.error) {
      return this.stop(turn, "fatal_error", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, [], commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
    }
    messages = preTurnCompaction.messages;
    compactions += preTurnCompaction.compacted ? 1 : 0;
    await this.saveState(turn, messages, modelTurns, toolCalls, compactions, completionValidationAttempts, calledTools, lastToolLoopSignature, repeatedToolLoopCount, finalText, "running");

    while (true) {
      if (Date.now() - startedAt > turn.budget.maxWallClockMs) {
        return this.stop(turn, "timeout", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
      }
      if (modelTurns >= turn.budget.maxModelTurns) {
        return this.stop(turn, "max_model_turns", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
      }
      if (toolCalls >= turn.budget.maxToolCalls) {
        return this.stop(turn, "max_tool_calls", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
      }
      if (turn.abortSignal?.aborted) {
        return this.stop(turn, "cancelled", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
      }

      const tools = this.deps.toolRouter.modelVisibleTools(turn as AgentLoopTurnContext<unknown>);
      if (modelTurns === 0) {
        await this.record(turn, {
          type: "turn_context",
          ...this.baseEvent(turn),
          cwd: turn.cwd,
          model: formatAgentLoopModelRef(turn.model),
          visibleTools: tools.map((tool) => tool.function.name),
        });
      }
      await this.record(turn, {
        type: "model_request",
        ...this.baseEvent(turn),
        model: formatAgentLoopModelRef(turn.model),
        toolCount: tools.length,
      });

      const protocol = await this.createTurnProtocol(turn, messages, tools);
      if (!protocol.responseCompleted) {
        return this.stop(turn, "protocol_incomplete", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
      }

      const response = this.protocolToResponse(protocol);
      modelTurns++;
      finalText = response.content;

      for (const assistant of protocol.assistant) {
        await this.record(turn, {
          type: "assistant_message",
          ...this.baseEvent(turn),
          phase: assistant.phase === "final_answer" ? "final_candidate" : "commentary",
          contentPreview: this.preview(assistant.content),
          toolCallCount: response.toolCalls.length,
        });
      }

      if (response.toolCalls.length === 0) {
        const parsed = this.parseFinal(response.content, turn.outputSchema);
        if (parsed.success) {
          const missingRequiredTools = this.missingRequiredTools(turn, calledTools);
          if (missingRequiredTools.length > 0) {
            messages.push({ role: "assistant", content: response.content, phase: "final_answer" });
            messages.push({
              role: "user",
              content: `Before the final answer, call these required tool(s) at least once: ${missingRequiredTools.join(", ")}.`,
            });
            const compacted = await this.compactIfNeeded(turn, messages, "mid_turn", "context_limit", this.responseUsageTokens(protocol), compactions);
            if (compacted.error) {
              return this.stop(turn, "fatal_error", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
            }
            messages = compacted.messages;
            compactions += compacted.compacted ? 1 : 0;
            await this.saveState(turn, messages, modelTurns, toolCalls, compactions, completionValidationAttempts, calledTools, lastToolLoopSignature, repeatedToolLoopCount, finalText, "running");
            continue;
          }

          const changedFiles = await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot);
          const completionValidation = turn.completionValidator?.({
            output: parsed.output,
            changedFiles,
            commandResults,
            calledTools: [...calledTools],
            modelTurns,
            toolCalls,
          });
          if (completionValidation && !completionValidation.ok) {
            completionValidationAttempts++;
            if (completionValidationAttempts > turn.budget.maxCompletionValidationAttempts) {
              return this.stop(turn, "completion_gate_failed", startedAt, modelTurns, toolCalls, response.content, null, false, compactions, changedFiles, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount, completionValidationAttempts);
            }

            messages.push({ role: "assistant", content: response.content, phase: "final_answer" });
            messages.push({
              role: "user",
              content: this.buildCompletionRepairPrompt(completionValidation.reasons),
            });
            const compacted = await this.compactIfNeeded(turn, messages, "mid_turn", "context_limit", this.responseUsageTokens(protocol), compactions);
            if (compacted.error) {
              return this.stop(turn, "fatal_error", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, changedFiles, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount, completionValidationAttempts);
            }
            messages = compacted.messages;
            compactions += compacted.compacted ? 1 : 0;
            await this.saveState(turn, messages, modelTurns, toolCalls, compactions, completionValidationAttempts, calledTools, lastToolLoopSignature, repeatedToolLoopCount, finalText, "running");
            continue;
          }

          await this.record(turn, {
            type: "final",
            ...this.baseEvent(turn),
            success: true,
            outputPreview: this.preview(response.content),
          });
          return this.stop(turn, "completed", startedAt, modelTurns, toolCalls, response.content, parsed.output, true, compactions, changedFiles, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount, completionValidationAttempts);
        }

        schemaRepairAttempts++;
        if (schemaRepairAttempts > turn.budget.maxSchemaRepairAttempts) {
          return this.stop(turn, "schema_error", startedAt, modelTurns, toolCalls, response.content, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
        }

        messages.push({ role: "assistant", content: response.content, phase: "final_answer" });
        messages.push({
          role: "user",
          content: `Your final answer did not match the required JSON schema. Return only valid JSON. Parse error: ${parsed.error}`,
        });
        const compacted = await this.compactIfNeeded(turn, messages, "mid_turn", "context_limit", this.responseUsageTokens(protocol), compactions);
        if (compacted.error) {
          return this.stop(turn, "fatal_error", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
        }
        messages = compacted.messages;
        compactions += compacted.compacted ? 1 : 0;
        await this.saveState(turn, messages, modelTurns, toolCalls, compactions, completionValidationAttempts, calledTools, lastToolLoopSignature, repeatedToolLoopCount, finalText, "running");
        continue;
      }

      messages.push({
        role: "assistant",
        content: response.content || `Calling ${response.toolCalls.map((call) => call.name).join(", ")}`,
        phase: "commentary",
        ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
      });

      const toolLoopSignature = JSON.stringify(
        response.toolCalls.map((call) => ({ name: call.name, input: call.input })),
      );
      if (toolLoopSignature === lastToolLoopSignature) repeatedToolLoopCount++;
      else {
        lastToolLoopSignature = toolLoopSignature;
        repeatedToolLoopCount = 1;
      }

      if (repeatedToolLoopCount > turn.budget.maxRepeatedToolCalls) {
        return this.stop(turn, "stalled_tool_loop", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
      }

      for (const call of response.toolCalls) {
        await this.record(turn, {
          type: "tool_call_started",
          ...this.baseEvent(turn),
          callId: call.id,
          toolName: call.name,
          inputPreview: this.preview(this.stringify(call.input)),
        });
      }

      const toolResults = await this.deps.toolRuntime.executeBatch(response.toolCalls, turn as AgentLoopTurnContext<unknown>);
      for (const result of toolResults) {
        calledTools.add(result.toolName);
        toolCalls++;
        if (result.success) consecutiveToolErrors = 0;
        else consecutiveToolErrors++;

        messages.push({
          role: "tool",
          toolCallId: result.callId,
          toolName: result.toolName,
          content: result.content,
        });

        await this.record(turn, {
          type: "tool_call_finished",
          ...this.baseEvent(turn),
          callId: result.callId,
          toolName: result.toolName,
          success: result.success,
          disposition: result.disposition,
          outputPreview: this.preview(result.content),
          durationMs: result.durationMs,
          ...(result.artifacts ? { artifacts: result.artifacts } : {}),
          ...(result.truncated ? { truncated: result.truncated } : {}),
        });

        if (result.disposition === "approval_denied") {
          await this.record(turn, {
            type: "approval",
            ...this.baseEvent(turn),
            toolName: result.toolName,
            status: "denied",
            reason: result.content,
          });
        }

        if (result.toolName === "update_plan" && result.contextModifier) {
          await this.record(turn, {
            type: "plan_update",
            ...this.baseEvent(turn),
            summary: this.preview(result.contextModifier),
          });
        }

        if (result.command && result.cwd) {
          const commandClassification = classifyAgentLoopCommandResult({
            toolName: result.toolName,
            command: result.command,
          });
          commandResults.push({
            toolName: result.toolName,
            command: result.command,
            cwd: result.cwd,
            success: result.success,
            category: commandClassification.category,
            evidenceEligible: commandClassification.evidenceEligible,
            outputSummary: this.preview(result.content),
            durationMs: result.durationMs,
          });
        }

        if (result.disposition === "fatal" || result.fatal) {
          return this.stop(turn, "fatal_error", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
        }
        if (result.disposition === "cancelled") {
          return this.stop(turn, "cancelled", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
        }
        if (consecutiveToolErrors >= turn.budget.maxConsecutiveToolErrors) {
          return this.stop(turn, "consecutive_tool_errors", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
        }
      }

      const compacted = await this.compactIfNeeded(turn, messages, "mid_turn", "context_limit", this.responseUsageTokens(protocol), compactions);
      if (compacted.error) {
        return this.stop(turn, "fatal_error", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
      }
      messages = compacted.messages;
      compactions += compacted.compacted ? 1 : 0;
      await this.saveState(turn, messages, modelTurns, toolCalls, compactions, completionValidationAttempts, calledTools, lastToolLoopSignature, repeatedToolLoopCount, finalText, "running");
    }
  }

  private parseFinal<TOutput>(
    content: string,
    schema: z.ZodType<TOutput, z.ZodTypeDef, unknown>,
  ): { success: true; output: TOutput } | { success: false; error: string } {
    try {
      const json = this.extractJson(content);
      return { success: true, output: schema.parse(JSON.parse(json)) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private extractJson(content: string): string {
    const fence = content.match(/```json\s*([\s\S]*?)\s*```/);
    return fence?.[1] ?? content;
  }

  private async stop<TOutput>(
    turn: AgentLoopTurnContext<TOutput>,
    reason: AgentLoopStopReason,
    startedAt: number,
    modelTurns: number,
    toolCalls: number,
    finalText: string,
    output: TOutput | null,
    success = false,
    compactions = 0,
    changedFiles: string[] = [],
    commandResults: AgentLoopCommandResult[] = [],
    messages?: AgentLoopMessage[],
    calledTools?: Set<string>,
    lastToolLoopSignature?: string | null,
    repeatedToolLoopCount?: number,
    completionValidationAttempts?: number,
  ): Promise<AgentLoopResult<TOutput>> {
    await this.saveState(
      turn,
      messages ?? turn.messages,
      modelTurns,
      toolCalls,
      compactions,
      completionValidationAttempts ?? 0,
      calledTools ?? new Set<string>(),
      lastToolLoopSignature ?? null,
      repeatedToolLoopCount ?? 0,
      finalText,
      success ? "completed" : "failed",
      reason,
    );

    await this.record(turn, {
      type: "stopped",
      ...this.baseEvent(turn),
      reason,
    });

    return {
      success,
      output,
      finalText,
      stopReason: reason,
      elapsedMs: Date.now() - startedAt,
      modelTurns,
      toolCalls,
      compactions,
      filesChanged: changedFiles.length > 0,
      changedFiles,
      commandResults,
      traceId: turn.session.traceId,
      sessionId: turn.session.sessionId,
      turnId: turn.turnId,
    };
  }

  private buildCompletionRepairPrompt(reasons: string[]): string {
    const bullets = reasons.map((reason) => `- ${reason}`).join("\n");
    return [
      "Your final answer is premature. Do not finish yet.",
      "Before returning the final JSON again, continue the task and gather stronger completion evidence.",
      bullets,
      "Use tools to verify the claimed result, then return fresh final JSON only when these gaps are resolved.",
    ].join("\n");
  }

  private baseEvent<TOutput>(turn: AgentLoopTurnContext<TOutput>) {
    return {
      eventId: randomUUID(),
      sessionId: turn.session.sessionId,
      traceId: turn.session.traceId,
      turnId: turn.turnId,
      goalId: turn.goalId,
      ...(turn.taskId ? { taskId: turn.taskId } : {}),
      createdAt: new Date().toISOString(),
    };
  }

  private async record<TOutput>(turn: AgentLoopTurnContext<TOutput>, event: Parameters<typeof turn.session.traceStore.append>[0]): Promise<void> {
    await turn.session.traceStore.append(event);
    await turn.session.eventSink.emit(event);
  }

  private preview(value: string): string {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }

  private stringify(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === undefined) return "";
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private async compactIfNeeded<TOutput>(
    turn: AgentLoopTurnContext<TOutput>,
    messages: AgentLoopMessage[],
    phase: AgentLoopCompactionPhase,
    reason: AgentLoopCompactionReason,
    usageTokens: number | undefined,
    compactions: number,
  ): Promise<{ messages: AgentLoopMessage[]; compacted: boolean; error?: string }> {
    const limit = this.autoCompactLimit(turn);
    if (!limit || compactions >= turn.budget.maxCompactions) {
      return { messages, compacted: false };
    }

    const tokens = usageTokens && usageTokens > 0 ? usageTokens : this.estimateTokens(messages);
    if (tokens < limit) {
      return { messages, compacted: false };
    }

    try {
      const result = await this.compactor.compact({
        history: createAgentLoopHistory(messages),
        maxMessages: turn.budget.compactionMaxMessages,
        phase,
        reason,
      });
      if (!result.compacted) {
        return { messages: result.history.messages, compacted: false };
      }
      await this.record(turn, {
        type: "context_compaction",
        ...this.baseEvent(turn),
        phase,
        reason,
        inputMessages: messages.length,
        outputMessages: result.history.messages.length,
        summaryPreview: this.preview(result.summary ?? ""),
      });
      return { messages: result.history.messages, compacted: true };
    } catch (err) {
      return { messages, compacted: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private autoCompactLimit<TOutput>(turn: AgentLoopTurnContext<TOutput>): number | undefined {
    if (turn.budget.autoCompactTokenLimit && turn.budget.autoCompactTokenLimit > 0) {
      return turn.budget.autoCompactTokenLimit;
    }
    const contextLimit = turn.modelInfo.capabilities.contextLimitTokens;
    return contextLimit && contextLimit > 0 ? Math.floor(contextLimit * 0.9) : undefined;
  }

  private responseUsageTokens(response: { usage?: { inputTokens: number; outputTokens: number } }): number | undefined {
    if (!response.usage) return undefined;
    return response.usage.inputTokens + response.usage.outputTokens;
  }

  private estimateTokens(messages: AgentLoopMessage[]): number {
    const chars = messages.reduce((total, message) => total + message.content.length, 0);
    return Math.ceil(chars / 4);
  }

  private missingRequiredTools<TOutput>(
    turn: AgentLoopTurnContext<TOutput>,
    calledTools: Set<string>,
  ): string[] {
    return [...(turn.toolPolicy.requiredTools ?? [])].filter((toolName) => !calledTools.has(toolName));
  }

  private async createTurnProtocol<TOutput>(
    turn: AgentLoopTurnContext<TOutput>,
    messages: AgentLoopMessage[],
    tools: ReturnType<AgentLoopToolRouter["modelVisibleTools"]>,
  ): Promise<AgentLoopModelTurnProtocol> {
    if (this.deps.modelClient.createTurnProtocol) {
      return this.deps.modelClient.createTurnProtocol({
        model: turn.model,
        messages,
        tools,
      });
    }

    const response = await this.deps.modelClient.createTurn({
      model: turn.model,
      messages,
      tools,
    });
    return {
      assistant: response.content || response.toolCalls.length > 0 ? [{
        content: response.content || `Calling ${response.toolCalls.map((call) => call.name).join(", ")}`,
        phase: response.toolCalls.length > 0 ? "commentary" : "final_answer",
      }] : [],
      toolCalls: response.toolCalls,
      stopReason: response.stopReason,
      responseCompleted: true,
      usage: response.usage,
    };
  }

  private protocolToResponse(protocol: AgentLoopModelTurnProtocol): { content: string; toolCalls: AgentLoopModelTurnProtocol["toolCalls"] } {
    return {
      content: protocol.assistant.map((item) => item.content).filter(Boolean).join("\n"),
      toolCalls: protocol.toolCalls,
    };
  }

  private async saveState<TOutput>(
    turn: AgentLoopTurnContext<TOutput>,
    messages: AgentLoopMessage[],
    modelTurns: number,
    toolCalls: number,
    compactions: number,
    completionValidationAttempts: number,
    calledTools: Set<string>,
    lastToolLoopSignature: string | null,
    repeatedToolLoopCount: number,
    finalText: string,
    status: AgentLoopSessionState["status"],
    stopReason?: AgentLoopStopReason,
  ): Promise<void> {
    const state: AgentLoopSessionState = {
      sessionId: turn.session.sessionId,
      traceId: turn.session.traceId,
      turnId: turn.turnId,
      goalId: turn.goalId,
      ...(turn.taskId ? { taskId: turn.taskId } : {}),
      cwd: turn.cwd,
      modelRef: formatAgentLoopModelRef(turn.model),
      messages,
      modelTurns,
      toolCalls,
      compactions,
      completionValidationAttempts,
      calledTools: [...calledTools],
      lastToolLoopSignature,
      repeatedToolLoopCount,
      finalText,
      status,
      ...(stopReason ? { stopReason } : {}),
      updatedAt: new Date().toISOString(),
    };
    await turn.session.stateStore.save(state);
  }

  private async captureWorkspaceSnapshot(cwd: string): Promise<Set<string> | null> {
    const result = await execFileNoThrow("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, timeoutMs: 10_000 });
    if ((result.exitCode ?? 1) !== 0) return null;
    return new Set(this.parseGitStatusPaths(result.stdout));
  }

  private async collectChangedFiles(cwd: string, before: Set<string> | null): Promise<string[]> {
    const afterResult = await execFileNoThrow("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, timeoutMs: 10_000 });
    if ((afterResult.exitCode ?? 1) !== 0) return [];
    const after = new Set(this.parseGitStatusPaths(afterResult.stdout));
    if (!before) return [...after];
    return [...after].filter((file) => !before.has(file));
  }

  private parseGitStatusPaths(stdout: string): string[] {
    return stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length >= 4)
      .map((line) => line.slice(3).trim())
      .map((filePath) => filePath.includes(" -> ") ? filePath.split(" -> ").at(-1) ?? filePath : filePath);
  }
}
