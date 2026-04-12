import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicMessagesAgentLoopModelClient,
  StaticAgentLoopModelRegistry,
  defaultAgentLoopCapabilities,
} from "../index.js";

const anthropicCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class AnthropicMock {
    messages = {
      create: anthropicCreate,
    };
  }

  return { default: AnthropicMock };
});

describe("AnthropicMessagesAgentLoopModelClient", () => {
  beforeEach(() => {
    anthropicCreate.mockReset();
  });

  it("preserves system prompt and tool replay structure", async () => {
    anthropicCreate.mockResolvedValue({
      id: "msg_123",
      content: [
        { type: "text", text: "Need one more tool call" },
        { type: "tool_use", id: "call-2", name: "echo_tool", input: { value: "fresh" } },
      ],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 17,
        output_tokens: 9,
      },
    });

    const registry = new StaticAgentLoopModelRegistry([{
      ref: { providerId: "anthropic", modelId: "claude-sonnet-4-6" },
      displayName: "anthropic/claude-sonnet-4-6",
      capabilities: { ...defaultAgentLoopCapabilities },
    }]);
    const client = new AnthropicMessagesAgentLoopModelClient({ apiKey: "test-key" }, registry);

    const protocol = await client.createTurnProtocol({
      model: { providerId: "anthropic", modelId: "claude-sonnet-4-6" },
      messages: [
        { role: "system", content: "Follow the agentloop contract." },
        { role: "user", content: "Start work." },
        {
          role: "assistant",
          content: "Calling echo_tool",
          phase: "commentary",
          toolCalls: [{ id: "call-1", name: "echo_tool", input: { value: "old" } }],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "echo_tool",
          content: "Echoed old",
        },
      ],
      tools: [{
        type: "function",
        function: {
          name: "echo_tool",
          description: "Echo a value",
          parameters: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
          },
        },
      }],
    });

    expect(anthropicCreate).toHaveBeenCalledOnce();
    const request = anthropicCreate.mock.calls[0][0] as {
      system?: string;
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
      tools: Array<{ name: string }>;
    };
    expect(request.system).toContain("Follow the agentloop contract.");
    expect(request.tools[0]?.name).toBe("echo_tool");
    expect(request.messages[1]?.role).toBe("assistant");
    expect(request.messages[1]?.content).toContainEqual(expect.objectContaining({
      type: "tool_use",
      id: "call-1",
      name: "echo_tool",
    }));
    expect(request.messages[2]?.role).toBe("user");
    expect(request.messages[2]?.content).toContainEqual(expect.objectContaining({
      type: "tool_result",
      tool_use_id: "call-1",
    }));

    expect(protocol.assistant).toEqual([{
      content: "Need one more tool call",
      phase: "commentary",
    }]);
    expect(protocol.toolCalls).toEqual([{
      id: "call-2",
      name: "echo_tool",
      input: { value: "fresh" },
    }]);
    expect(protocol.responseCompleted).toBe(true);
    expect(protocol.providerResponseId).toBe("msg_123");
  });
});
