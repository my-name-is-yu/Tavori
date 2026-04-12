import { describe, expect, it } from "vitest";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../../../base/llm/llm-client.js";
import type { ProviderConfig } from "../../../../base/llm/provider-config.js";
import {
  AnthropicMessagesAgentLoopModelClient,
  OpenAIResponsesAgentLoopModelClient,
  StaticAgentLoopModelRegistry,
  createProviderNativeAgentLoopModelClient,
  defaultAgentLoopCapabilities,
} from "../index.js";

function makeLLMClient(): ILLMClient {
  return {
    async sendMessage(_messages: LLMMessage[], _options?: LLMRequestOptions): Promise<LLMResponse> {
      return {
        content: "",
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string): T {
      return JSON.parse(content) as T;
    },
    supportsToolCalling: () => true,
  };
}

const registry = new StaticAgentLoopModelRegistry([{
  ref: { providerId: "test", modelId: "model" },
  displayName: "test/model",
  capabilities: { ...defaultAgentLoopCapabilities },
}]);

describe("createProviderNativeAgentLoopModelClient", () => {
  it("selects OpenAI Responses client for openai provider", () => {
    const client = createProviderNativeAgentLoopModelClient({
      providerConfig: {
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "agent_loop",
        api_key: "test-key",
      } as ProviderConfig,
      llmClient: makeLLMClient(),
      modelRegistry: registry,
    });

    expect(client).toBeInstanceOf(OpenAIResponsesAgentLoopModelClient);
  });

  it("selects Anthropic native client for anthropic provider", () => {
    const client = createProviderNativeAgentLoopModelClient({
      providerConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        adapter: "agent_loop",
        api_key: "test-key",
      } as ProviderConfig,
      llmClient: makeLLMClient(),
      modelRegistry: registry,
    });

    expect(client).toBeInstanceOf(AnthropicMessagesAgentLoopModelClient);
  });
});
