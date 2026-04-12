import OpenAI from "openai";
import type {
  EasyInputMessage,
  FunctionTool,
  Response,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputItem,
  ResponseOutputMessage,
} from "openai/resources/responses/responses";
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

export interface OpenAIResponsesAgentLoopModelClientOptions {
  apiKey: string;
  baseURL?: string;
}

export class OpenAIResponsesAgentLoopModelClient implements AgentLoopModelClient {
  private readonly client: OpenAI;

  constructor(
    options: OpenAIResponsesAgentLoopModelClientOptions,
    private readonly registry: AgentLoopModelRegistry,
  ) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
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
    const response = await this.client.responses.create({
      model: input.model.modelId,
      input: this.toInputItems(input.messages),
      tools: input.tools.map((tool) => this.toFunctionTool(tool)),
      max_output_tokens: input.maxOutputTokens,
    }) as Response;

    const assistant: AgentLoopAssistantOutput[] = [];
    const toolCalls: AgentLoopToolCall[] = [];

    for (const item of response.output ?? []) {
      if (item.type === "message") {
        const message = item as ResponseOutputMessage;
        const text = (message.content ?? [])
          .map((part) => part.type === "output_text" ? part.text ?? "" : part.refusal ?? "")
          .filter((part) => part.length > 0)
          .join("\n");
        if (text.trim()) {
          assistant.push({
            content: text,
            phase: message.phase ?? "final_answer",
          });
        }
        continue;
      }

      if (item.type === "function_call" && item.name && item.call_id) {
        const toolCall = item as ResponseFunctionToolCall;
        toolCalls.push({
          id: toolCall.call_id,
          name: toolCall.name,
          input: this.parseJson(toolCall.arguments),
        });
      }
    }

    if (assistant.length === 0 && response.output_text?.trim()) {
      assistant.push({
        content: response.output_text,
        phase: toolCalls.length > 0 ? "commentary" : "final_answer",
      });
    }
    if (assistant.length === 0 && toolCalls.length > 0) {
      assistant.push({
        content: `Calling ${toolCalls.map((call) => call.name).join(", ")}`,
        phase: "commentary",
      });
    }

    return {
      assistant,
      toolCalls,
      stopReason: response.status ?? "unknown",
      responseCompleted: response.status === "completed",
      providerResponseId: response.id,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }

  private toInputItems(messages: AgentLoopMessage[]): ResponseInput {
    return messages.map((message) => {
      if (message.role === "tool") {
        if (!message.toolCallId) {
          throw new Error("Agent loop tool messages require toolCallId for Responses API replay.");
        }
        const item: ResponseInputItem.FunctionCallOutput = {
          type: "function_call_output",
          call_id: message.toolCallId,
          output: message.content,
        };
        return item;
      }

      const item: EasyInputMessage = {
        type: "message",
        role: message.role === "system" ? "developer" : message.role,
        content: message.content,
        phase: message.role === "assistant" ? message.phase ?? null : null,
      };
      return item;
    });
  }

  private toFunctionTool(tool: ToolDefinition): FunctionTool {
    return {
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      strict: true,
    };
  }

  private parseJson(value: string | undefined): unknown {
    if (!value) return {};
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
}
