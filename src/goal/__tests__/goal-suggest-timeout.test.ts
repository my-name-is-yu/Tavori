/**
 * goal-suggest-timeout.test.ts
 *
 * Unit tests for the Promise.race timeout mechanism in suggestGoals().
 * Tests verify that:
 *   1. A slow LLM call is rejected after the timeout fires.
 *   2. The timer is cleared on success (no dangling timers).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { suggestGoals, SuggestTimeoutError } from "../goal-suggest.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { EthicsGate } from "../../platform/traits/ethics-gate.js";

// ─── Minimal mock factories ───────────────────────────────────────────────────

function makeEthicsGate(): EthicsGate {
  return {
    check: vi.fn().mockResolvedValue({ verdict: "pass", confidence: 1.0 }),
  } as unknown as EthicsGate;
}

function makeLLMClient(sendMessageImpl: () => Promise<{ content: string }>): ILLMClient {
  return {
    sendMessage: vi.fn().mockImplementation(sendMessageImpl),
    parseJSON: vi.fn().mockImplementation((content: string) => JSON.parse(content)),
  } as unknown as ILLMClient;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("suggestGoals — timeout mechanism", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects with a 'timed out' error when the LLM call never resolves", async () => {
    // LLM returns a promise that never settles
    const neverResolves = new Promise<{ content: string }>(() => { /* intentionally hangs */ });
    const llmClient = makeLLMClient(() => neverResolves);
    const ethicsGate = makeEthicsGate();

    const promise = suggestGoals(
      "some project context with src/ and package.json",
      llmClient,
      ethicsGate,
      [],
      { timeoutMs: 5_000 }
    );

    // Suppress unhandled rejection from the internal timeoutPromise
    // (Promise.race rejects, but the losing promise's rejection is still reported)
    promise.catch(() => {});

    // Advance fake timers past the timeout
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(promise).rejects.toBeInstanceOf(SuggestTimeoutError);
    await expect(promise).rejects.toThrow("timed out");
    await expect(promise).rejects.toThrow("5s");
  });

  it("clears the timer on success (no dangling timers)", async () => {
    const validResponse = JSON.stringify([
      {
        title: "Add tests",
        description: "Add unit tests for core modules",
        rationale: "Coverage is low",
        dimensions_hint: ["test_coverage"],
      },
    ]);

    // LLM resolves quickly (synchronously via microtask)
    const llmClient = makeLLMClient(() => Promise.resolve({ content: validResponse }));
    const ethicsGate = makeEthicsGate();

    await suggestGoals(
      "some project context with src/ and package.json",
      llmClient,
      ethicsGate,
      [],
      { timeoutMs: 30_000 }
    );

    // After success there should be no pending timers left
    expect(vi.getTimerCount()).toBe(0);
  });
});
