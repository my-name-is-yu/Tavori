import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { StateManager } from "../src/state-manager.js";
import type { ILLMClient } from "../src/llm/llm-client.js";
import type { Logger } from "../src/runtime/logger.js";
import { makeTempDir, cleanupTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";

// ─── Helpers ───

function createMockLLMClient(score: number, reason = "test"): ILLMClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      content: JSON.stringify({ score, reason }),
      usage: { input_tokens: 50, output_tokens: 20 },
      stop_reason: "end_turn",
    }),
    parseJSON: vi.fn().mockReturnValue({ score, reason }),
  };
}

function createMockLogger(): { logger: Logger; warnMessages: string[] } {
  const warnMessages: string[] = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((msg: string) => warnMessages.push(msg)),
    error: vi.fn(),
    close: vi.fn(),
  } as unknown as Logger;
  return { logger, warnMessages };
}

describe("ObservationEngine — score jump suppression (§3.3)", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-obs-clamp-");
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("allows score change within ±0.4 — no suppression", async () => {
    const goal = makeGoal({ id: "goal-ok" });
    await stateManager.saveGoal(goal);

    // prev=0.5, proposed=0.85 — delta=0.35 which is within 0.4
    const llmClient = createMockLLMClient(0.85, "good progress");
    const { logger, warnMessages } = createMockLogger();
    const engine = new ObservationEngine(
      stateManager,
      [],
      llmClient,
      undefined,
      { gitContextFetcher: async () => "some workspace content" },
      logger
    );

    const entry = await engine.observeWithLLM(
      "goal-ok",
      "dim1",
      "Test goal",
      "dim1",
      JSON.stringify({ type: "min", value: 1 }),
      "some workspace content",
      0.5, // previousScore
      true  // dryRun
    );

    expect(entry.extracted_value).toBe(0.85);
    expect(entry.confidence).toBe(0.70); // normal confidence, no suppression
    expect(warnMessages.some((m) => m.includes("observation score jump suppressed"))).toBe(false);
  });

  it("suppresses score jump when delta > 0.4 — score stays at prev, confidence=0.50", async () => {
    const goal = makeGoal({ id: "goal-jump" });
    await stateManager.saveGoal(goal);

    // prev=0.2, proposed=0.9 — delta=0.7 which exceeds 0.4
    const llmClient = createMockLLMClient(0.9, "jump");
    const { logger, warnMessages } = createMockLogger();
    const engine = new ObservationEngine(
      stateManager,
      [],
      llmClient,
      undefined,
      { gitContextFetcher: async () => "workspace context" },
      logger
    );

    const entry = await engine.observeWithLLM(
      "goal-jump",
      "dim1",
      "Test goal",
      "dim1",
      JSON.stringify({ type: "min", value: 1 }),
      "workspace context",
      0.2, // previousScore
      true  // dryRun
    );

    // Score should be suppressed to previousScore
    expect(entry.extracted_value).toBe(0.2);
    expect(entry.confidence).toBe(0.50);

    const suppressMsg = warnMessages.find((m) => m.includes("observation score jump suppressed"));
    expect(suppressMsg).toBeDefined();
    expect(suppressMsg).toContain("prev=0.200");
    expect(suppressMsg).toContain("proposed=0.900");
  });

  it("suppresses downward jump > 0.4 as well", async () => {
    const goal = makeGoal({ id: "goal-down-jump" });
    await stateManager.saveGoal(goal);

    // prev=0.9, proposed=0.3 — delta=0.6 which exceeds 0.4
    const llmClient = createMockLLMClient(0.3, "dropped");
    const { logger, warnMessages } = createMockLogger();
    const engine = new ObservationEngine(
      stateManager,
      [],
      llmClient,
      undefined,
      { gitContextFetcher: async () => "workspace context" },
      logger
    );

    const entry = await engine.observeWithLLM(
      "goal-down-jump",
      "dim1",
      "Test goal",
      "dim1",
      JSON.stringify({ type: "min", value: 1 }),
      "workspace context",
      0.9, // previousScore
      true  // dryRun
    );

    expect(entry.extracted_value).toBe(0.9); // suppressed — stays at prev
    expect(entry.confidence).toBe(0.50);
    expect(warnMessages.some((m) => m.includes("observation score jump suppressed"))).toBe(true);
  });

  it("does not suppress when previousScore is not provided (null/undefined)", async () => {
    const goal = makeGoal({ id: "goal-no-prev" });
    await stateManager.saveGoal(goal);

    // No previousScore — any score is accepted
    const llmClient = createMockLLMClient(0.95, "first observation");
    const { logger, warnMessages } = createMockLogger();
    const engine = new ObservationEngine(
      stateManager,
      [],
      llmClient,
      undefined,
      { gitContextFetcher: async () => "workspace content" },
      logger
    );

    const entry = await engine.observeWithLLM(
      "goal-no-prev",
      "dim1",
      "Test goal",
      "dim1",
      JSON.stringify({ type: "min", value: 1 }),
      "workspace content",
      null, // no previousScore
      true  // dryRun
    );

    expect(entry.extracted_value).toBe(0.95);
    expect(entry.confidence).toBe(0.70);
    expect(warnMessages.some((m) => m.includes("observation score jump suppressed"))).toBe(false);
  });

  // ─── Range clamping tests ───

  it("min type: extractedValue does not trigger clamp for normal scores (score <= 1)", async () => {
    const goal = makeGoal({ id: "goal-clamp-min" });
    await stateManager.saveGoal(goal);

    // score=0.99, threshold=100 → extractedValue=99, which is < 100*2=200 — no clamp
    const llmClient = createMockLLMClient(0.99, "high score");
    const { logger, warnMessages } = createMockLogger();
    const engine = new ObservationEngine(
      stateManager,
      [],
      llmClient,
      undefined,
      { gitContextFetcher: async () => "content" },
      logger
    );

    const entry = await engine.observeWithLLM(
      "goal-clamp-min",
      "dim1",
      "Test goal",
      "dim1",
      JSON.stringify({ type: "min", value: 100 }),
      "content",
      null,
      true
    );

    // extractedValue = 0.99 * 100 = 99 — within bounds, no clamp warning
    expect(entry.extracted_value).toBeCloseTo(99, 1);
    expect(warnMessages.some((m) => m.includes("clamped for min threshold"))).toBe(false);
  });

  it("min type: no suspicious warning when extractedValue <= threshold*1.5", async () => {
    const goal = makeGoal({ id: "goal-no-suspicious" });
    await stateManager.saveGoal(goal);

    // score=0.9, threshold=100 → extractedValue=90, which is < 100*1.5=150 — no warning
    const llmClient = createMockLLMClient(0.9, "normal");
    const { logger, warnMessages } = createMockLogger();
    const engine = new ObservationEngine(
      stateManager,
      [],
      llmClient,
      undefined,
      { gitContextFetcher: async () => "content" },
      logger
    );

    const entry = await engine.observeWithLLM(
      "goal-no-suspicious",
      "dim1",
      "Test goal",
      "dim1",
      JSON.stringify({ type: "min", value: 100 }),
      "content",
      null,
      true
    );

    // extractedValue = 90 — below 1.5x, no suspicious warning
    expect(entry.extracted_value).toBeCloseTo(90, 1);
    expect(warnMessages.some((m) => m.includes("suspiciously high"))).toBe(false);
  });

  it("max type: score=0.0 gives threshold*2 and triggers suspicious warning (>1.5x)", async () => {
    const goal = makeGoal({ id: "goal-max-worst" });
    await stateManager.saveGoal(goal);

    // score=0.0 → extractedValue = 100*(2-0) = 200 = threshold*2
    const llmClient = createMockLLMClient(0.0, "way over max");
    const { logger, warnMessages } = createMockLogger();
    const engine = new ObservationEngine(
      stateManager,
      [],
      llmClient,
      undefined,
      { gitContextFetcher: async () => "content" },
      logger
    );

    const entry = await engine.observeWithLLM(
      "goal-max-worst",
      "dim1",
      "Test goal",
      "dim1",
      JSON.stringify({ type: "max", value: 100 }),
      "content",
      null,
      true
    );

    // score=0.0 → extractedValue = 200 — equal to clampMax so NOT clamped
    expect(entry.extracted_value).toBeCloseTo(200, 1);
    expect(warnMessages.some((m) => m.includes("clamped for max threshold"))).toBe(false);
    // 200 > 100*1.5=150 → suspicious warning fires
    expect(warnMessages.some((m) => m.includes("suspiciously high for max threshold"))).toBe(true);
  });

  it("max type: score=1.0 gives exactly threshold with no warnings", async () => {
    const goal = makeGoal({ id: "goal-max-at-limit" });
    await stateManager.saveGoal(goal);

    const llmClient = createMockLLMClient(1.0, "exactly at max");
    const { logger, warnMessages } = createMockLogger();
    const engine = new ObservationEngine(
      stateManager,
      [],
      llmClient,
      undefined,
      { gitContextFetcher: async () => "content" },
      logger
    );

    const entry = await engine.observeWithLLM(
      "goal-max-at-limit",
      "dim1",
      "Test goal",
      "dim1",
      JSON.stringify({ type: "max", value: 100 }),
      "content",
      null,
      true
    );

    // score=1.0 → extractedValue = 100*(2-1.0) = 100 — at threshold, no warnings
    expect(entry.extracted_value).toBeCloseTo(100, 1);
    expect(warnMessages.some((m) => m.includes("clamped"))).toBe(false);
    expect(warnMessages.some((m) => m.includes("suspiciously high"))).toBe(false);
  });

  it("delta exactly equal to 0.4 is NOT suppressed (boundary is exclusive)", async () => {
    const goal = makeGoal({ id: "goal-boundary" });
    await stateManager.saveGoal(goal);

    // prev=0.5, proposed=0.9 — delta=0.4 exactly — should NOT be suppressed
    const llmClient = createMockLLMClient(0.9, "boundary");
    const { logger, warnMessages } = createMockLogger();
    const engine = new ObservationEngine(
      stateManager,
      [],
      llmClient,
      undefined,
      { gitContextFetcher: async () => "workspace content" },
      logger
    );

    const entry = await engine.observeWithLLM(
      "goal-boundary",
      "dim1",
      "Test goal",
      "dim1",
      JSON.stringify({ type: "min", value: 1 }),
      "workspace content",
      0.5, // previousScore — delta=0.4 exactly
      true  // dryRun
    );

    // Exactly 0.4 is not strictly greater than 0.4, so score should pass through
    expect(entry.extracted_value).toBe(0.9);
    expect(entry.confidence).toBe(0.70);
    expect(warnMessages.some((m) => m.includes("observation score jump suppressed"))).toBe(false);
  });
});
