import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { observeWithLLM } from "../src/observation/observation-llm.js";
import { LLMObservationResponseSchema } from "../src/observation/observation-helpers.js";
import type { ILLMClient } from "../src/llm/llm-client.js";
import type { ObservationLogEntry } from "../src/types/state.js";
import type { Logger } from "../src/runtime/logger.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

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
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

// No-op applyObservation callback
const noopApply = vi.fn();

// ─── Guard 3 Tests ─────────────────────────────────────────────────────────

describe("Guard 3: Score-evidence consistency check (§4.3)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("conatus-guard3-");
    noopApply.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Test 1: No evidence + LLM returns score > 0.0 → overridden to 0.0, confidence = 0.1 ───

  it("overrides score to 0.0 and sets confidence to 0.1 when no evidence and LLM returns score > 0.0", async () => {
    // Simulate no context: inject gitContextFetcher that returns empty string
    const gitContextFetcher = vi.fn().mockReturnValue("");
    const mockLLMClient = createMockLLMClient(0.8, "I think it is done");
    const logger = makeLogger();

    const entry = await observeWithLLM(
      "goal-no-evidence",
      "dim1",
      "Improve code quality",
      "Code Quality",
      JSON.stringify({ type: "min", value: 0.8 }),
      mockLLMClient,
      { gitContextFetcher },
      noopApply,
      undefined, // workspaceContext: none
      null,
      true, // dryRun
      logger
    );

    expect(entry.extracted_value).toBe(0.0);
    expect(entry.confidence).toBe(0.1);
    expect(entry.raw_result).toMatchObject({ score: 0.0 });
  });

  // ─── Test 2: No evidence + LLM returns score = 0.0 → no change ───

  it("leaves score at 0.0 and sets confidence to 0.1 when no evidence and LLM already returns 0.0", async () => {
    const gitContextFetcher = vi.fn().mockReturnValue("");
    const mockLLMClient = createMockLLMClient(0.0, "no evidence available");
    const logger = makeLogger();

    const entry = await observeWithLLM(
      "goal-no-evidence-zero",
      "dim1",
      "Improve code quality",
      "Code Quality",
      JSON.stringify({ type: "min", value: 0.8 }),
      mockLLMClient,
      { gitContextFetcher },
      noopApply,
      undefined,
      null,
      true,
      logger
    );

    expect(entry.extracted_value).toBe(0.0);
    expect(entry.confidence).toBe(0.1);
    // Logger.warn should NOT have been called (score was already 0.0)
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // ─── Test 3: Has evidence + LLM returns score > 0.0 → score unchanged, confidence = 0.70 ───

  it("leaves score unchanged and sets confidence to 0.70 when evidence is available", async () => {
    const contextOutput = "File: src/foo.ts\nconst quality = 0.92;";
    const mockLLMClient = createMockLLMClient(0.85, "evidence shows quality is high");
    const logger = makeLogger();

    const entry = await observeWithLLM(
      "goal-with-evidence",
      "dim1",
      "Improve code quality",
      "Code Quality",
      JSON.stringify({ type: "min", value: 0.8 }),
      mockLLMClient,
      {},
      noopApply,
      contextOutput, // workspaceContext provided
      null,
      true,
      logger
    );

    expect(entry.extracted_value).toBe(0.85);
    expect(entry.confidence).toBe(0.70);
    expect(entry.raw_result).toMatchObject({ score: 0.85 });
    // Logger.warn should NOT have been called
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("score overridden"));
  });

  // ─── Test 4: Logger.warn is called exactly when override happens ───

  it("calls logger.warn when score is overridden due to missing evidence", async () => {
    const gitContextFetcher = vi.fn().mockReturnValue("");
    const mockLLMClient = createMockLLMClient(0.6, "guessed");
    const logger = makeLogger();

    await observeWithLLM(
      "goal-warn-check",
      "dim1",
      "Improve code quality",
      "Code Quality",
      JSON.stringify({ type: "min", value: 0.8 }),
      mockLLMClient,
      { gitContextFetcher },
      noopApply,
      undefined,
      null,
      true,
      logger
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warnMsg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(warnMsg).toContain("score overridden to 0.0");
    expect(warnMsg).toContain("0.6");
  });
});
