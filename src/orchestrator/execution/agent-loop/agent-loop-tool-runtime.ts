import type { ToolExecutor } from "../../../tools/executor.js";
import type { AgentLoopToolCall } from "./agent-loop-model.js";
import type { AgentLoopToolOutput } from "./agent-loop-tool-output.js";
import type { AgentLoopToolRouter } from "./agent-loop-tool-router.js";
import type { AgentLoopTurnContext } from "./agent-loop-turn-context.js";

export interface AgentLoopToolRuntime {
  executeBatch(
    calls: AgentLoopToolCall[],
    turn: AgentLoopTurnContext<unknown>
  ): Promise<AgentLoopToolOutput[]>;
}

export class ToolExecutorAgentLoopToolRuntime implements AgentLoopToolRuntime {
  constructor(
    private readonly executor: ToolExecutor,
    private readonly router: AgentLoopToolRouter,
  ) {}

  async executeBatch(
    calls: AgentLoopToolCall[],
    turn: AgentLoopTurnContext<unknown>
  ): Promise<AgentLoopToolOutput[]> {
    const safe: Array<{ call: AgentLoopToolCall; index: number }> = [];
    const unsafe: Array<{ call: AgentLoopToolCall; index: number }> = [];

    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      if (!this.router.isToolAllowed(call.name, turn)) {
        unsafe.push({ call, index });
      } else if (this.router.supportsParallel(call.name, call.input)) {
        safe.push({ call, index });
      } else {
        unsafe.push({ call, index });
      }
    }

    const outputs = new Array<AgentLoopToolOutput>(calls.length);
    const safeOutputs = await Promise.all(safe.map(({ call }) => this.executeOne(call, turn)));
    for (let i = 0; i < safe.length; i++) outputs[safe[i].index] = safeOutputs[i];
    for (const { call, index } of unsafe) outputs[index] = await this.executeOne(call, turn);
    return outputs;
  }

  private async executeOne(
    call: AgentLoopToolCall,
    turn: AgentLoopTurnContext<unknown>,
  ): Promise<AgentLoopToolOutput> {
    if (!this.router.isToolAllowed(call.name, turn)) {
      return this.failure(call, `Tool "${call.name}" is not allowed in this turn.`, 0);
    }

    try {
      const start = Date.now();
      const result = await this.executor.execute(call.name, call.input, {
        ...turn.toolCallContext,
        callId: call.id,
        sessionId: turn.session.sessionId,
        abortSignal: turn.abortSignal,
      });
      const disposition = this.resolveDisposition(result.error, turn.abortSignal?.aborted === true);
      const command = this.extractCommand(call.input);
      const resolvedCwd = this.extractCwd(call.input) ?? turn.cwd;
      return {
        callId: call.id,
        toolName: call.name,
        success: result.success,
        content: result.success
          ? `${result.summary}\n${this.stringify(result.data)}${result.contextModifier ? `\n${result.contextModifier}` : ""}`
          : result.error ?? result.summary,
        durationMs: result.durationMs || Date.now() - start,
        disposition,
        ...(result.contextModifier ? { contextModifier: result.contextModifier } : {}),
        rawResult: result,
        ...(command ? { command, cwd: resolvedCwd } : {}),
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
        ...(result.truncated ? { truncated: result.truncated } : {}),
      };
    } catch (err) {
      return this.failure(
        call,
        err instanceof Error ? err.message : String(err),
        0,
        turn.abortSignal?.aborted ? "cancelled" : "fatal",
      );
    }
  }

  private failure(
    call: AgentLoopToolCall,
    message: string,
    durationMs: number,
    disposition: AgentLoopToolOutput["disposition"] = "respond_to_model",
  ): AgentLoopToolOutput {
    return {
      callId: call.id,
      toolName: call.name,
      success: false,
      content: message,
      durationMs,
      disposition,
    };
  }

  private stringify(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === undefined) return "";
    return JSON.stringify(value);
  }

  private resolveDisposition(
    error: string | undefined,
    aborted: boolean,
  ): AgentLoopToolOutput["disposition"] {
    if (aborted) return "cancelled";
    if (!error) return "respond_to_model";
    if (error.startsWith("User denied approval")) return "approval_denied";
    return "respond_to_model";
  }

  private extractCommand(input: unknown): string | undefined {
    return input && typeof input === "object" && typeof (input as Record<string, unknown>)["command"] === "string"
      ? (input as Record<string, string>)["command"]
      : undefined;
  }

  private extractCwd(input: unknown): string | undefined {
    return input && typeof input === "object" && typeof (input as Record<string, unknown>)["cwd"] === "string"
      ? (input as Record<string, string>)["cwd"]
      : undefined;
  }
}
