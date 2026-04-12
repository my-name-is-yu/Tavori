import type { ILLMClient } from "../../../base/llm/llm-client.js";
import type { ProviderConfig } from "../../../base/llm/provider-config.js";
import type { AgentLoopModelClient, AgentLoopModelRegistry } from "./agent-loop-model.js";
import { ILLMClientAgentLoopModelClient } from "./agent-loop-model-client.js";
import { AnthropicMessagesAgentLoopModelClient } from "./anthropic-messages-agent-loop-model-client.js";
import { OpenAIResponsesAgentLoopModelClient } from "./openai-responses-agent-loop-model-client.js";

export function createProviderNativeAgentLoopModelClient(input: {
  providerConfig: ProviderConfig;
  llmClient: ILLMClient;
  modelRegistry: AgentLoopModelRegistry;
}): AgentLoopModelClient {
  if (input.providerConfig.provider === "openai" && input.providerConfig.api_key) {
    return new OpenAIResponsesAgentLoopModelClient(
      {
        apiKey: input.providerConfig.api_key,
        baseURL: input.providerConfig.base_url,
      },
      input.modelRegistry,
    );
  }

  if (input.providerConfig.provider === "anthropic" && input.providerConfig.api_key) {
    return new AnthropicMessagesAgentLoopModelClient({
      apiKey: input.providerConfig.api_key,
      baseURL: input.providerConfig.base_url,
    }, input.modelRegistry);
  }

  return new ILLMClientAgentLoopModelClient(input.llmClient, input.modelRegistry);
}
