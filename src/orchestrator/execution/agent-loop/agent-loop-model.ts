import type { ToolDefinition } from "../../../base/llm/llm-client.js";

export interface AgentLoopModelRef {
  providerId: string;
  modelId: string;
  variant?: string;
}

export interface AgentLoopModelCapabilities {
  toolCalling: boolean;
  parallelToolCalls: boolean;
  streaming: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  attachments: boolean;
  interleavedThinking: boolean;
  inputModalities: Array<"text" | "image" | "audio" | "video" | "pdf">;
  outputModalities: Array<"text" | "image" | "audio" | "video" | "pdf">;
  contextLimitTokens?: number;
  outputLimitTokens?: number;
}

export interface AgentLoopModelInfo {
  ref: AgentLoopModelRef;
  displayName: string;
  capabilities: AgentLoopModelCapabilities;
  providerOptions?: Record<string, unknown>;
  modelOptions?: Record<string, unknown>;
}

export type AgentLoopMessageRole = "system" | "user" | "assistant" | "tool";
export type AgentLoopMessagePhase = "commentary" | "final_answer";

export interface AgentLoopMessage {
  role: AgentLoopMessageRole;
  content: string;
  phase?: AgentLoopMessagePhase;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: AgentLoopToolCall[];
}

export interface AgentLoopToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface AgentLoopModelRequest {
  model: AgentLoopModelRef;
  messages: AgentLoopMessage[];
  tools: ToolDefinition[];
  system?: string;
  maxOutputTokens?: number;
}

export interface AgentLoopAssistantOutput {
  content: string;
  phase?: AgentLoopMessagePhase;
}

export interface AgentLoopModelResponse {
  content: string;
  toolCalls: AgentLoopToolCall[];
  stopReason: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface AgentLoopModelTurnProtocol {
  assistant: AgentLoopAssistantOutput[];
  toolCalls: AgentLoopToolCall[];
  stopReason: string;
  responseCompleted: boolean;
  providerResponseId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface AgentLoopModelRegistry {
  list(): Promise<AgentLoopModelInfo[]>;
  get(ref: AgentLoopModelRef): Promise<AgentLoopModelInfo>;
  defaultModel(): Promise<AgentLoopModelRef>;
  smallModel?(providerId: string): Promise<AgentLoopModelRef | null>;
}

export interface AgentLoopModelClient {
  createTurn(input: AgentLoopModelRequest): Promise<AgentLoopModelResponse>;
  createTurnProtocol?(input: AgentLoopModelRequest): Promise<AgentLoopModelTurnProtocol>;
  getModelInfo(ref: AgentLoopModelRef): Promise<AgentLoopModelInfo>;
}

export const defaultAgentLoopCapabilities: AgentLoopModelCapabilities = {
  toolCalling: true,
  parallelToolCalls: false,
  streaming: false,
  structuredOutput: false,
  reasoning: false,
  attachments: false,
  interleavedThinking: false,
  inputModalities: ["text"],
  outputModalities: ["text"],
};

export function parseAgentLoopModelRef(value: string): AgentLoopModelRef {
  const [providerId, ...modelParts] = value.split("/");
  if (!providerId || modelParts.length === 0 || modelParts.join("/").trim() === "") {
    throw new Error(`Invalid model ref "${value}". Expected "provider/model".`);
  }
  return { providerId, modelId: modelParts.join("/") };
}

export function formatAgentLoopModelRef(ref: AgentLoopModelRef): string {
  return `${ref.providerId}/${ref.modelId}${ref.variant ? `#${ref.variant}` : ""}`;
}
