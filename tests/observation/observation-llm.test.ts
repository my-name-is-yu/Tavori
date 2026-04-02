import { describe, it, expect, vi } from "vitest";
import { observeWithLLM } from "../../src/observation/observation-llm.js";
import type { ILLMClient } from "../../src/llm/llm-client.js";
import type { Logger } from "../../src/runtime/logger.js";

function createMockLLMClient(score: number, reason = "test reason"): ILLMClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      content: JSON.stringify({ score, reason }),
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: "end_turn",
    }),
    parseJSON: vi.fn().mockReturnValue({ score, reason }),
  };
}

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

const noopApply = vi.fn();

describe("Observation LLM malformed JSON regression", () => {
  it("logs malformed threshold JSON, returns an observation, and does not throw", async () => {
    const gitContextFetcher = vi.fn().mockReturnValue("");
    const mockLLMClient = createMockLLMClient(0.65, "malformed threshold should not block");
    const logger = makeLogger();

    const entry = await observeWithLLM(
      "goal-malformed-threshold",
      "dim-malformed",
      "Improve code quality",
      "Code Quality",
      "{not valid json",
      mockLLMClient,
      { gitContextFetcher },
      noopApply,
      undefined,
      null,
      true,
      logger
    );

    expect(entry.extracted_value).toBe(0.65);
    expect(entry.raw_result).toMatchObject({ score: 0.65 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse thresholdDescription for binary check")
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse thresholdDescription JSON goal=")
    );
  });
});
