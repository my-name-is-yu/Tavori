/**
 * E2E smoke tests for the OpenAI API integration.
 *
 * These tests hit the real OpenAI API and are skipped when OPENAI_API_KEY is
 * not set. Run them intentionally with:
 *
 *   OPENAI_API_KEY=<key> npx vitest run tests/e2e/openai-e2e.test.ts
 *
 * Keep prompts minimal to reduce cost.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { OpenAILLMClient } from "../../src/llm/openai-client.js";
import { buildLLMClient } from "../../src/llm/provider-factory.js";
import type { LLMResponse } from "../../src/llm/llm-client.js";

const API_KEY_SET = Boolean(process.env["OPENAI_API_KEY"]);

// ─── Helpers ───

/** Assert that a value conforms to the LLMResponse contract. */
function assertLLMResponse(res: LLMResponse): void {
  expect(typeof res.content).toBe("string");
  expect(typeof res.usage).toBe("object");
  expect(typeof res.usage.input_tokens).toBe("number");
  expect(typeof res.usage.output_tokens).toBe("number");
  expect(res.usage.input_tokens).toBeGreaterThanOrEqual(0);
  expect(res.usage.output_tokens).toBeGreaterThanOrEqual(0);
  expect(typeof res.stop_reason).toBe("string");
}

// ─── Suite ───

describe.skipIf(!API_KEY_SET)("OpenAI E2E — real API calls", () => {
  // ── Test 1: sendMessage returns a valid LLMResponse ──────────────────────

  it(
    "OpenAILLMClient.sendMessage() returns a valid LLMResponse",
    async () => {
      const client = new OpenAILLMClient({ apiKey: process.env["OPENAI_API_KEY"]! });

      const res = await client.sendMessage([
        { role: "user", content: "Reply with just the word 'hello'" },
      ]);

      assertLLMResponse(res);
      expect(res.content.length).toBeGreaterThan(0);
    },
    30_000
  );

  // ── Test 2: buildLLMClient('openai') creates an OpenAILLMClient ──────────

  it(
    "buildLLMClient() with PULSEED_LLM_PROVIDER=openai creates an OpenAILLMClient",
    async () => {
      const originalProvider = process.env["PULSEED_LLM_PROVIDER"];
      const originalAdapter = process.env["PULSEED_ADAPTER"];
      process.env["PULSEED_LLM_PROVIDER"] = "openai";
      process.env["PULSEED_ADAPTER"] = "openai_api";

      try {
        const client = await buildLLMClient();
        expect(client).toBeInstanceOf(OpenAILLMClient);

        // Verify it is usable — make a minimal call
        const res = await client.sendMessage([
          { role: "user", content: "Reply with just the word 'ping'" },
        ]);
        assertLLMResponse(res);
        expect(res.content.length).toBeGreaterThan(0);
      } finally {
        if (originalProvider === undefined) {
          delete process.env["PULSEED_LLM_PROVIDER"];
        } else {
          process.env["PULSEED_LLM_PROVIDER"] = originalProvider;
        }
        if (originalAdapter === undefined) {
          delete process.env["PULSEED_ADAPTER"];
        } else {
          process.env["PULSEED_ADAPTER"] = originalAdapter;
        }
      }
    },
    30_000
  );

  // ── Test 3: parseJSON validates structured output against a Zod schema ───

  it(
    "OpenAILLMClient.parseJSON() validates structured JSON response",
    async () => {
      const client = new OpenAILLMClient({ apiKey: process.env["OPENAI_API_KEY"]! });

      const GreetingSchema = z.object({
        greeting: z.string(),
        language: z.string(),
      });

      const res = await client.sendMessage([
        {
          role: "user",
          content:
            'Reply ONLY with a JSON object in this exact shape (no markdown, no extra text): {"greeting":"hello","language":"english"}',
        },
      ]);

      assertLLMResponse(res);

      // parseJSON should extract and validate the JSON
      const parsed = client.parseJSON(res.content, GreetingSchema);
      expect(typeof parsed.greeting).toBe("string");
      expect(typeof parsed.language).toBe("string");
    },
    30_000
  );
});
