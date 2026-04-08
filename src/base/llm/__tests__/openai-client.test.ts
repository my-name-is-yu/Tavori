import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

// ─── Mock the openai SDK ───
//
// We mock the entire "openai" module so no real HTTP calls are made.
// Each test controls what `chat.completions.create` returns via
// `mockCreate`.

const mockCreate = vi.fn();
const mockStream = vi.fn();
const mockResponsesCreate = vi.fn();

vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(function() { return {
      chat: {
        completions: {
          create: mockCreate,
          stream: mockStream,
        },
      },
      responses: {
        create: mockResponsesCreate,
      },
    }; }),
  };
});

import { OpenAILLMClient } from "../openai-client.js";

// ─── Helpers ───

function makeCompletionResponse(
  content: string,
  finishReason = "stop",
  promptTokens = 10,
  completionTokens = 5,
  toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>
) {
  return {
    choices: [
      {
        message: { content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    },
  };
}

// ─── Tests ───

describe("OpenAILLMClient", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
    mockResponsesCreate.mockReset();
    // Ensure OPENAI_API_KEY is not set by default so constructor tests are
    // isolated. Individual tests that need a valid key set it explicitly.
    delete process.env["OPENAI_API_KEY"];
  });

  afterEach(() => {
    delete process.env["OPENAI_API_KEY"];
  });

  // ─── Constructor ───

  describe("constructor", () => {
    it("throws if no API key and OPENAI_API_KEY env var is not set", () => {
      expect(() => new OpenAILLMClient()).toThrow(
        /no API key provided/
      );
    });

    it("does not throw when apiKey is provided directly", () => {
      expect(() => new OpenAILLMClient({ apiKey: "sk-test" })).not.toThrow();
    });

    it("does not throw when apiKey is provided in config", () => {
      expect(() => new OpenAILLMClient({ apiKey: "sk-from-config" })).not.toThrow();
    });

    it("default model is 'gpt-4o'", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("hello"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.model).toBe("gpt-4o");
    });

    it("uses custom model when specified in config", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "gpt-4-turbo" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.model).toBe("gpt-4-turbo");
    });
  });

  // ─── sendMessage ───

  describe("sendMessage", () => {
    it("maps LLMMessage array to OpenAI messages format", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("response"));

      await client.sendMessage([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "bye" },
      ]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "bye" },
      ]);
    });

    it("prepends system as developer role message when options.system is provided", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }], {
        system: "You are a helpful assistant.",
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[0]).toEqual({
        role: "developer",
        content: "You are a helpful assistant.",
      });
      expect(callArgs.messages[1]).toEqual({ role: "user", content: "hi" });
    });

    it("does not prepend developer message when no system option is given", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages).toHaveLength(1);
      expect(callArgs.messages[0]).toEqual({ role: "user", content: "hi" });
    });

    it("maps response content, usage, and stop_reason correctly", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(
        makeCompletionResponse("the answer", "stop", 20, 8)
      );

      const result = await client.sendMessage([
        { role: "user", content: "question" },
      ]);

      expect(result.content).toBe("the answer");
      expect(result.stop_reason).toBe("stop");
      expect(result.usage.input_tokens).toBe(20);
      expect(result.usage.output_tokens).toBe(8);
    });

    it("omits temperature for reasoning models starting with 'o1'", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "o1-mini" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("temperature");
    });

    it("omits temperature for reasoning models starting with 'o3'", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "o3" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("temperature");
    });

    it("omits temperature for reasoning models starting with 'o4'", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "o4-mini" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("temperature");
    });

    it("includes temperature for non-reasoning models", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "gpt-4o" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs).toHaveProperty("temperature");
    });

    it("respects temperature override from options for non-reasoning model", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }], {
        temperature: 0.8,
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.temperature).toBe(0.8);
    });

    it("overrides model via options.model", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "gpt-4o" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }], {
        model: "gpt-4-turbo",
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.model).toBe("gpt-4-turbo");
    });

    it("respects max_tokens override from options", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse("ok"));

      await client.sendMessage([{ role: "user", content: "hi" }], {
        max_tokens: 128,
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.max_completion_tokens).toBe(128);
    });

    it("passes tools through and maps returned tool calls", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      mockCreate.mockResolvedValueOnce(makeCompletionResponse(
        "",
        "tool_calls",
        10,
        5,
        [{ id: "call-1", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }]
      ));

      const result = await client.sendMessage([{ role: "user", content: "inspect the repo" }], {
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a file",
              parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
          },
        ],
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.tools).toHaveLength(1);
      expect(result.tool_calls?.[0]).toMatchObject({
        id: "call-1",
        function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
      });
    });
  });

  // ─── Retry logic ───

  describe("retry logic", () => {
    it("retries on failure and succeeds on second attempt", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });

      mockCreate
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce(makeCompletionResponse("success"));

      vi.useFakeTimers();
      const promise = client.sendMessage([{ role: "user", content: "hi" }]);
      await vi.runAllTimersAsync();
      const result = await promise;
      vi.useRealTimers();

      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(result.content).toBe("success");
    });

    it("retries up to 3 times and throws after all attempts fail", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });

      mockCreate.mockRejectedValue(new Error("persistent error"));

      vi.useFakeTimers();
      const promise = client
        .sendMessage([{ role: "user", content: "hi" }])
        .catch((e) => e);
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      const result = await promise;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe("persistent error");
      expect(mockCreate).toHaveBeenCalledTimes(3);
    });
  });

  describe("sendMessageStream", () => {
    it("falls back to the Responses API for non-chat models", async () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test", model: "codex-mini-latest" });
      mockStream.mockImplementationOnce(() => {
        throw new Error("This is not a chat model and not supported in the v1/chat/completions endpoint");
      });
      mockResponsesCreate.mockResolvedValueOnce({
        output_text: "fallback output",
        status: "completed",
        usage: {
          input_tokens: 12,
          output_tokens: 7,
        },
      });

      const result = await client.sendMessageStream(
        [{ role: "user", content: "hello" }],
        undefined,
        { onTextDelta: vi.fn() }
      );

      expect(result.content).toBe("fallback output");
      expect(mockResponsesCreate).toHaveBeenCalledOnce();
    });
  });

  // ─── parseJSON ───

  describe("parseJSON", () => {
    const schema = z.object({ name: z.string(), count: z.number() });

    it("parses valid bare JSON", () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      const result = client.parseJSON('{"name":"test","count":42}', schema);
      expect(result).toEqual({ name: "test", count: 42 });
    });

    it("extracts JSON from ```json code fence", () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      const content = "```json\n{\"name\":\"hello\",\"count\":1}\n```";
      const result = client.parseJSON(content, schema);
      expect(result).toEqual({ name: "hello", count: 1 });
    });

    it("extracts JSON from generic ``` code fence", () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      const content = "```\n{\"name\":\"world\",\"count\":99}\n```";
      const result = client.parseJSON(content, schema);
      expect(result).toEqual({ name: "world", count: 99 });
    });

    it("throws on invalid JSON", () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      expect(() => client.parseJSON("not json at all", schema)).toThrow(
        "LLM response JSON parse failed"
      );
    });

    it("throws on schema validation failure", () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      expect(() =>
        client.parseJSON('{"name":123,"count":"wrong"}', schema)
      ).toThrow();
    });

    it("includes original content in error message on parse failure", () => {
      const client = new OpenAILLMClient({ apiKey: "sk-test" });
      const badContent = "this is not json";
      expect(() => client.parseJSON(badContent, schema)).toThrow(badContent);
    });
  });
});
