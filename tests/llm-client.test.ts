import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { MockLLMClient, LLMClient } from "../src/llm/llm-client.js";
import type { ILLMClient } from "../src/llm/llm-client.js";

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

  // ─── ILLMClient interface conformance ───

  describe("ILLMClient interface conformance", () => {
    it("MockLLMClient satisfies ILLMClient", () => {
      const client: ILLMClient = new MockLLMClient(["response"]);
      expect(typeof client.sendMessage).toBe("function");
      expect(typeof client.parseJSON).toBe("function");
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
