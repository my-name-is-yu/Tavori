import type {
  ILLMClient,
  LLMMessage,
  ToolCallResult,
} from "../../../base/llm/llm-client.js";
import type {
  AgentLoopAssistantOutput,
  AgentLoopMessage,
  AgentLoopModelClient,
  AgentLoopModelInfo,
  AgentLoopModelRef,
  AgentLoopModelRegistry,
  AgentLoopModelRequest,
  AgentLoopModelResponse,
  AgentLoopModelTurnProtocol,
  AgentLoopToolCall,
} from "./agent-loop-model.js";

export class ILLMClientAgentLoopModelClient implements AgentLoopModelClient {
  constructor(
    private readonly llmClient: ILLMClient,
    private readonly registry: AgentLoopModelRegistry,
  ) {}

  async getModelInfo(ref: AgentLoopModelRef): Promise<AgentLoopModelInfo> {
    return this.registry.get(ref);
  }

  async createTurn(input: AgentLoopModelRequest): Promise<AgentLoopModelResponse> {
    const protocol = await this.createTurnProtocol(input);
    const finalAssistant = [...protocol.assistant].reverse().find((item) => item.content.trim().length > 0);
    return {
      content: finalAssistant?.content ?? "",
      toolCalls: protocol.toolCalls,
      stopReason: protocol.stopReason,
      usage: protocol.usage,
    };
  }

  async createTurnProtocol(input: AgentLoopModelRequest): Promise<AgentLoopModelTurnProtocol> {
    const messages = this.toLLMMessages(input.messages);
    const response = await this.llmClient.sendMessage(messages, {
      model: input.model.modelId,
      system: input.system,
      max_tokens: input.maxOutputTokens,
      tools: input.tools,
    });

    const toolCalls = response.tool_calls ?? [];
    const assistant: AgentLoopAssistantOutput[] = response.content || toolCalls.length > 0
      ? [{
          content: response.content || `Calling ${toolCalls.map((call) => call.function.name).join(", ")}`,
          phase: toolCalls.length > 0 ? "commentary" : "final_answer",
        }]
      : [];
    return {
      assistant,
      toolCalls: toolCalls.map((call) => this.toAgentLoopToolCall(call)),
      stopReason: response.stop_reason,
      responseCompleted: true,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  private toLLMMessages(messages: AgentLoopMessage[]): LLMMessage[] {
    return messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.role === "tool"
          ? `Tool result${message.toolName ? ` for ${message.toolName}` : ""}:\n${message.content}`
          : message.content,
      }));
  }

  private toAgentLoopToolCall(call: ToolCallResult): AgentLoopToolCall {
    let input: unknown;
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch {
      input = call.function.arguments;
    }
    return {
      id: call.id,
      name: call.function.name,
      input,
    };
  }
}
