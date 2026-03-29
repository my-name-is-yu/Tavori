import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { MockLLMClient, LLMClient } from "../src/llm/llm-client.js";
import type { ILLMClient } from "../src/llm/llm-client.js";
import { extractJSON } from "../src/llm/base-llm-client.js";

// ─── MockLLMClient ───

describe("MockLLMClient", () => {
  describe("sendMessage — response ordering", () => {
    it("returns responses in order", async () => {
      const mock = new MockLLMClient(["first", "second", "third"]);

      const r1 = await mock.sendMessage([{ role: "user", content: "a" }]);
      const r2 = await mock.sendMessage([{ role: "user", content: "b" }]);
      const r3 = await mock.sendMessage([{ role: "user", content: "c" }]);

      expect(r1.content).toBe("first");
      expect(r2.content).toBe("second");
      expect(r3.content).toBe("third");
    });

    it("returns the correct LLMResponse shape", async () => {
      const mock = new MockLLMClient(["hello"]);
      const response = await mock.sendMessage([{ role: "user", content: "hi" }]);

      expect(response).toMatchObject({
        content: "hello",
        usage: {
          input_tokens: expect.any(Number),
          output_tokens: expect.any(Number),
        },
        stop_reason: expect.any(String),
      });
    });

    it("throws when responses are exhausted", async () => {
      const mock = new MockLLMClient(["only one"]);
      await mock.sendMessage([{ role: "user", content: "first" }]);

      await expect(
        mock.sendMessage([{ role: "user", content: "second" }])
      ).rejects.toThrow();
    });
  });

  describe("callCount tracking", () => {
    it("starts at 0", () => {
      const mock = new MockLLMClient(["a", "b"]);
      expect(mock.callCount).toBe(0);
    });

    it("increments after each sendMessage call", async () => {
      const mock = new MockLLMClient(["a", "b", "c"]);

      await mock.sendMessage([{ role: "user", content: "1" }]);
      expect(mock.callCount).toBe(1);

      await mock.sendMessage([{ role: "user", content: "2" }]);
      expect(mock.callCount).toBe(2);

      await mock.sendMessage([{ role: "user", content: "3" }]);
      expect(mock.callCount).toBe(3);
    });

    it("counts even if content is empty string", async () => {
      const mock = new MockLLMClient([""]);
      await mock.sendMessage([{ role: "user", content: "x" }]);
      expect(mock.callCount).toBe(1);
    });
  });

  // ─── parseJSON — success cases ───

  describe("parseJSON — success cases", () => {
    let mock: MockLLMClient;

    beforeEach(() => {
      mock = new MockLLMClient([]);
    });

    it("parses valid JSON matching the schema", () => {
      const schema = z.object({ name: z.string(), value: z.number() });
      const content = JSON.stringify({ name: "test", value: 42 });

      const result = mock.parseJSON(content, schema);

      expect(result.name).toBe("test");
      expect(result.value).toBe(42);
    });

    it("extracts JSON from ```json ... ``` markdown code blocks", () => {
      const schema = z.object({ verdict: z.string() });
      const content = "Here is the result:\n```json\n{\"verdict\": \"pass\"}\n```\nDone.";

      const result = mock.parseJSON(content, schema);

      expect(result.verdict).toBe("pass");
    });

    it("extracts JSON from generic ``` ... ``` code blocks", () => {
      const schema = z.object({ count: z.number() });
      const content = "Result:\n```\n{\"count\": 7}\n```";

      const result = mock.parseJSON(content, schema);

      expect(result.count).toBe(7);
    });

    it("handles nested objects in schema", () => {
      const schema = z.object({
        outer: z.object({
          inner: z.string(),
          num: z.number(),
        }),
      });
      const content = JSON.stringify({ outer: { inner: "hello", num: 3 } });

      const result = mock.parseJSON(content, schema);

      expect(result.outer.inner).toBe("hello");
      expect(result.outer.num).toBe(3);
    });

    it("handles arrays in schema", () => {
      const schema = z.object({ items: z.array(z.string()) });
      const content = JSON.stringify({ items: ["a", "b", "c"] });

      const result = mock.parseJSON(content, schema);

      expect(result.items).toEqual(["a", "b", "c"]);
    });
  });

  // ─── parseJSON — failure cases ───

  describe("parseJSON — failure cases", () => {
    let mock: MockLLMClient;

    beforeEach(() => {
      mock = new MockLLMClient([]);
    });

    it("throws on invalid JSON (syntax error)", () => {
      const schema = z.object({ name: z.string() });
      const content = "{ name: oops }";

      expect(() => mock.parseJSON(content, schema)).toThrow();
    });

    it("throws when JSON is valid but schema validation fails (wrong type)", () => {
      const schema = z.object({ count: z.number() });
      const content = JSON.stringify({ count: "not-a-number" });

      expect(() => mock.parseJSON(content, schema)).toThrow();
    });

    it("throws when JSON is valid but required field is missing", () => {
      const schema = z.object({ required_field: z.string() });
      const content = JSON.stringify({ other_field: "value" });

      expect(() => mock.parseJSON(content, schema)).toThrow();
    });

    it("throws on completely non-JSON text", () => {
      const schema = z.object({ x: z.number() });
      const content = "This is just plain text with no JSON at all.";

      expect(() => mock.parseJSON(content, schema)).toThrow();
    });
  });

  // ─── extractJSON — prose + brace matching ───

  describe("extractJSON — prose and brace matching", () => {
    it("returns raw JSON as-is (fast path)", () => {
      const input = '{"key": "value"}';
      expect(extractJSON(input)).toBe(input);
    });

    it("extracts JSON from leading prose", () => {
      const input = 'Here is the result: {"key": "value"}';
      expect(extractJSON(input)).toBe('{"key": "value"}');
    });

    it("extracts JSON with trailing text", () => {
      const input = '{"key": "value"} That is all.';
      expect(extractJSON(input)).toBe('{"key": "value"}');
    });

    it("extracts JSON with both leading and trailing text", () => {
      const input = 'Sure! {"key": "value"} Hope that helps!';
      expect(extractJSON(input)).toBe('{"key": "value"}');
    });

    it("extracts array JSON with leading prose", () => {
      const input = 'The result is [1, 2, 3] as expected.';
      expect(extractJSON(input)).toBe('[1, 2, 3]');
    });
  });

  // ─── parseJSON — logging on failure ───

  describe("parseJSON — logging on failure", () => {
    let mock: MockLLMClient;

    beforeEach(() => {
      mock = new MockLLMClient([]);
    });

    it("logs to console.warn and throws on completely invalid text", () => {
      const schema = z.object({ x: z.number() });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(() => mock.parseJSON("completely invalid text no braces", schema)).toThrow();
        expect(warnSpy).toHaveBeenCalledOnce();
        const warnArg: string = warnSpy.mock.calls[0][0] as string;
        expect(warnArg).toContain("[parseJSON]");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("logs to console.warn and throws when valid JSON fails Zod schema", () => {
      const schema = z.object({ count: z.number() });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(() => mock.parseJSON('{"count": "not-a-number"}', schema)).toThrow();
        expect(warnSpy).toHaveBeenCalledOnce();
        const warnArg: string = warnSpy.mock.calls[0][0] as string;
        expect(warnArg).toContain("[parseJSON]");
        expect(warnArg).toContain("validation failed");
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // ─── parseJSON — prose extraction integration ───

  describe("parseJSON — prose extraction integration", () => {
    let mock: MockLLMClient;

    beforeEach(() => {
      mock = new MockLLMClient([]);
    });

    it("parses JSON preceded by leading prose", () => {
      const schema = z.object({ key: z.string() });
      const result = mock.parseJSON('Here is the result: {"key": "value"}', schema);
      expect(result.key).toBe("value");
    });

    it("parses JSON with trailing text after closing brace", () => {
      const schema = z.object({ status: z.string() });
      const result = mock.parseJSON('{"status": "ok"} That is the answer.', schema);
      expect(result.status).toBe("ok");
    });

    it("parses JSON with both leading and trailing prose", () => {
      const schema = z.object({ value: z.number() });
      const result = mock.parseJSON('Sure thing! {"value": 42} Done.', schema);
      expect(result.value).toBe(42);
    });

    it("parses array JSON with leading prose", () => {
      const schema = z.array(z.string());
      const result = mock.parseJSON('The tags are ["foo", "bar", "baz"] as requested.', schema);
      expect(result).toEqual(["foo", "bar", "baz"]);
    });
  });

  // ─── parseJSON — sanitizer integration ───

  describe("parseJSON — sanitizer integration", () => {
    let mock: MockLLMClient;

    beforeEach(() => {
      mock = new MockLLMClient([]);
    });

    it("handles trailing commas via sanitizer", () => {
      const schema = z.object({ name: z.string(), value: z.number() });
      const result = mock.parseJSON('{"name": "test", "value": 42,}', schema);
      expect(result.name).toBe("test");
      expect(result.value).toBe(42);
    });

    it("handles NaN values via sanitizer (replaces with null)", () => {
      const schema = z.object({ score: z.number().nullable() });
      const result = mock.parseJSON('{"score": NaN}', schema);
      expect(result.score).toBeNull();
    });
  });

  // ─── ILLMClient interface conformance ───

  describe("ILLMClient interface conformance", () => {
    it("MockLLMClient satisfies ILLMClient", () => {
      const client: ILLMClient = new MockLLMClient(["response"]);
      expect(typeof client.sendMessage).toBe("function");
      expect(typeof client.parseJSON).toBe("function");
    });
  });

  // ─── parseJSON — retry behavior ───

  describe("parseJSON — retry behavior", () => {
    const schema = z.object({ value: z.number() });
    const validContent = JSON.stringify({ value: 42 });
    const invalidContent = "this is not json at all";
    const originalMessages = [{ role: "user", content: "Give me a number as JSON." }];

    it("fails immediately without retry when no options provided", async () => {
      const mock = new MockLLMClient([]);
      const callLLMRawSpy = vi.spyOn(mock as unknown as { callLLMRaw: () => Promise<string> }, "callLLMRaw");

      expect(() => mock.parseJSON(invalidContent, schema)).toThrow();
      expect(callLLMRawSpy).not.toHaveBeenCalled();
    });

    it("succeeds on retry when first content is invalid but retry returns valid JSON", async () => {
      const mock = new MockLLMClient([]);
      vi.spyOn(mock as unknown as { callLLMRaw: (msgs: unknown[], sys?: string) => Promise<string> }, "callLLMRaw")
        .mockResolvedValueOnce(validContent);

      const result = await mock.parseJSON(invalidContent, schema, {
        retry: { messages: originalMessages },
      });

      expect(result.value).toBe(42);
    });

    it("throws when retry is provided but both attempts return invalid JSON", async () => {
      const mock = new MockLLMClient([]);
      vi.spyOn(mock as unknown as { callLLMRaw: (msgs: unknown[], sys?: string) => Promise<string> }, "callLLMRaw")
        .mockResolvedValueOnce("still not json");

      await expect(
        mock.parseJSON(invalidContent, schema, {
          retry: { messages: originalMessages },
        })
      ).rejects.toThrow();
    });

    it("does not call callLLMRaw when first parse succeeds", async () => {
      const mock = new MockLLMClient([]);
      const callLLMRawSpy = vi.spyOn(mock as unknown as { callLLMRaw: () => Promise<string> }, "callLLMRaw");

      const result = await mock.parseJSON(validContent, schema, {
        retry: { messages: originalMessages },
      });

      expect(result.value).toBe(42);
      expect(callLLMRawSpy).not.toHaveBeenCalled();
    });

    it("passes systemPrompt to callLLMRaw on retry", async () => {
      const mock = new MockLLMClient([]);
      const callLLMRawSpy = vi.spyOn(
        mock as unknown as { callLLMRaw: (msgs: unknown[], sys?: string) => Promise<string> },
        "callLLMRaw"
      ).mockResolvedValueOnce(validContent);

      await mock.parseJSON(invalidContent, schema, {
        retry: { messages: originalMessages, systemPrompt: "Respond with JSON only." },
      });

      expect(callLLMRawSpy).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: expect.stringContaining("not valid JSON") }),
        ]),
        "Respond with JSON only."
      );
    });

    it("logs warn on first failure and retry failure", async () => {
      const mock = new MockLLMClient([]);
      vi.spyOn(mock as unknown as { callLLMRaw: (msgs: unknown[], sys?: string) => Promise<string> }, "callLLMRaw")
        .mockResolvedValueOnce("also invalid");

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await expect(
          mock.parseJSON(invalidContent, schema, { retry: { messages: originalMessages } })
        ).rejects.toThrow();

        const warnMessages = warnSpy.mock.calls.map((c) => c[0] as string);
        expect(warnMessages.some((m) => m.includes("first attempt failed, retrying"))).toBe(true);
        expect(warnMessages.some((m) => m.includes("retry also failed"))).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});

// ─── LLMClient ───

describe("LLMClient", () => {
  describe("constructor", () => {
    it("throws when no API key is provided and ANTHROPIC_API_KEY env var is not set", () => {
      const original = process.env["ANTHROPIC_API_KEY"];
      delete process.env["ANTHROPIC_API_KEY"];

      try {
        expect(() => new LLMClient()).toThrow();
      } finally {
        if (original !== undefined) {
          process.env["ANTHROPIC_API_KEY"] = original;
        }
      }
    });

    it("does not throw when an API key is provided directly", () => {
      expect(() => new LLMClient("test-api-key")).not.toThrow();
    });

    it("does not throw when API key is passed via config", () => {
      expect(() => new LLMClient("config-api-key")).not.toThrow();
    });
  });

  describe("parseJSON", () => {
    it("parses valid JSON from a constructed LLMClient", () => {
      // Use a real key-like value to construct without throwing
      const client = new LLMClient("sk-ant-test");
      const schema = z.object({ status: z.string() });
      const result = client.parseJSON('{"status": "ok"}', schema);
      expect(result.status).toBe("ok");
    });

    it("extracts JSON from markdown blocks in LLMClient", () => {
      const client = new LLMClient("sk-ant-test");
      const schema = z.object({ value: z.number() });
      const result = client.parseJSON("```json\n{\"value\": 99}\n```", schema);
      expect(result.value).toBe(99);
    });

    it("throws on invalid JSON in LLMClient", () => {
      const client = new LLMClient("sk-ant-test");
      const schema = z.object({ x: z.string() });
      expect(() => client.parseJSON("not json", schema)).toThrow();
    });
  });
});
