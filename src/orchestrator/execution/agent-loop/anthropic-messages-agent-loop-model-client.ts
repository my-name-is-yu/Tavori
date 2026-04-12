import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageParam,
  Tool,
  ContentBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { ToolDefinition } from "../../../base/llm/llm-client.js";
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

export interface AnthropicMessagesAgentLoopModelClientOptions {
  apiKey: string;
  baseURL?: string;
  defaultMaxTokens?: number;
}

export class AnthropicMessagesAgentLoopModelClient implements AgentLoopModelClient {
  private readonly client: Anthropic;
  private readonly defaultMaxTokens: number;

  constructor(
    options: AnthropicMessagesAgentLoopModelClientOptions,
    private readonly registry: AgentLoopModelRegistry,
  ) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
    this.defaultMaxTokens = options.defaultMaxTokens ?? 4096;
  }

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
    const response = await this.client.messages.create({
      model: input.model.modelId,
      max_tokens: input.maxOutputTokens ?? this.defaultMaxTokens,
      ...(this.buildSystemPrompt(input) ? { system: this.buildSystemPrompt(input)! } : {}),
      messages: this.toAnthropicMessages(input.messages),
      ...(input.tools.length > 0 ? { tools: input.tools.map((tool) => this.toAnthropicTool(tool)) } : {}),
    });

    const assistant = this.extractAssistantOutputs(response);
    const toolCalls = this.extractToolCalls(response);
    if (assistant.length === 0 && toolCalls.length > 0) {
      assistant.push({
        content: `Calling ${toolCalls.map((call) => call.name).join(", ")}`,
        phase: "commentary",
      });
    }

    return {
      assistant,
      toolCalls,
      stopReason: response.stop_reason ?? "unknown",
      responseCompleted: response.stop_reason !== null,
      providerResponseId: response.id,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  private buildSystemPrompt(input: AgentLoopModelRequest): string | undefined {
    const parts = [
      input.system,
      ...input.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content),
    ].map((value) => value?.trim() ?? "").filter((value) => value.length > 0);

    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  private toAnthropicMessages(messages: AgentLoopMessage[]): MessageParam[] {
    const converted: MessageParam[] = [];

    for (const message of messages) {
      if (message.role === "system") {
        continue;
      }

      if (message.role === "tool") {
        if (!message.toolCallId) {
          this.appendText(converted, "user", `Tool result${message.toolName ? ` for ${message.toolName}` : ""}:\n${message.content}`);
          continue;
        }
        this.appendBlocks(converted, "user", [{
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
          is_error: false,
        }]);
        continue;
      }

      if (message.role === "assistant") {
        const blocks: ContentBlockParam[] = [];
        if (message.content.trim().length > 0) {
          blocks.push({ type: "text", text: message.content });
        }
        for (const toolCall of message.toolCalls ?? []) {
          blocks.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input,
          });
        }
        if (blocks.length > 0) {
          this.appendBlocks(converted, "assistant", blocks);
        }
        continue;
      }

      this.appendText(converted, "user", message.content);
    }

    return converted;
  }

  private appendText(messages: MessageParam[], role: "user" | "assistant", text: string): void {
    this.appendBlocks(messages, role, [{ type: "text", text }]);
  }

  private appendBlocks(
    messages: MessageParam[],
    role: "user" | "assistant",
    blocks: ContentBlockParam[],
  ): void {
    const nonEmptyBlocks = blocks.filter((block) => {
      if (block.type !== "text") return true;
      return block.text.trim().length > 0;
    });
    if (nonEmptyBlocks.length === 0) return;

    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      last.content.push(...nonEmptyBlocks);
      return;
    }
    messages.push({ role, content: [...nonEmptyBlocks] });
  }

  private toAnthropicTool(tool: ToolDefinition): Tool {
    return {
      name: tool.function.name,
      description: tool.function.description,
      input_schema: {
        type: "object",
        ...tool.function.parameters,
      },
    };
  }

  private extractAssistantOutputs(response: Message): AgentLoopAssistantOutput[] {
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!text) return [];
    return [{
      content: text,
      phase: response.stop_reason === "tool_use" ? "commentary" : "final_answer",
    }];
  }

  private extractToolCalls(response: Message): AgentLoopToolCall[] {
    return response.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: block.id,
        name: block.name,
        input: block.input,
      }));
  }
}
