import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { EthicsGate } from "../src/traits/ethics-gate.js";
import { GoalDependencyGraph } from "../src/goal/goal-dependency-graph.js";
import { GoalTreeManager } from "../src/goal/goal-tree-manager.js";
import { evaluateDecompositionQuality } from "../src/goal/goal-tree-quality.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";

import { PASS_VERDICT_SIMPLE_JSON as PASS_VERDICT } from "./helpers/ethics-fixtures.js";

// Quality evaluation responses
const GOOD_QUALITY_RESPONSE = JSON.stringify({
  coverage: 0.9,
  overlap: 0.1,
  actionability: 0.85,
  reasoning: "Good decomposition with high coverage and low overlap",
});

const HIGH_OVERLAP_RESPONSE = JSON.stringify({
  coverage: 0.8,
  overlap: 0.8,
  actionability: 0.7,
  reasoning: "Subgoals are highly redundant with each other",
});

const LOW_COVERAGE_RESPONSE = JSON.stringify({
  coverage: 0.3,
  overlap: 0.1,
  actionability: 0.8,
  reasoning: "Subgoals only cover a small portion of the parent goal",
});

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;
let ethicsGate: EthicsGate;
let dependencyGraph: GoalDependencyGraph;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  const ethicsLLM = createMockLLMClient(Array(50).fill(PASS_VERDICT));
  ethicsGate = new EthicsGate(stateManager, ethicsLLM);
  dependencyGraph = new GoalDependencyGraph(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ─── 1. evaluateDecompositionQuality (standalone function from goal-tree-quality.ts) ───

describe("evaluateDecompositionQuality", () => {
  it("returns high quality metrics for a good decomposition", async () => {
    const llm = createMockLLMClient([GOOD_QUALITY_RESPONSE]);

    const metrics = await evaluateDecompositionQuality(
      "Build a reliable web application",
      [
        "Set up CI/CD pipeline with automated tests achieving 80% coverage",
        "Implement error monitoring with Sentry capturing all production errors",
        "Deploy to production with zero-downtime deployments using blue-green strategy",
      ],
      { llmClient: llm }
    );

    expect(metrics.coverage).toBeCloseTo(0.9, 2);
    expect(metrics.overlap).toBeCloseTo(0.1, 2);
    expect(metrics.actionability).toBeCloseTo(0.85, 2);
    // depthEfficiency = 1 - overlap * 0.5 = 1 - 0.1 * 0.5 = 0.95
    expect(metrics.depthEfficiency).toBeCloseTo(0.95, 2);
  });

  it("detects high overlap in subgoals", async () => {
    const llm = createMockLLMClient([HIGH_OVERLAP_RESPONSE]);

    const metrics = await evaluateDecompositionQuality(
      "Improve code quality",
      [
        "Write unit tests to improve code quality",
        "Write tests to verify code quality",
        "Add automated tests for code quality assurance",
      ],
      { llmClient: llm }
    );

    expect(metrics.overlap).toBeGreaterThan(0.7);
    // depthEfficiency should be reduced: 1 - 0.8 * 0.5 = 0.6
    expect(metrics.depthEfficiency).toBeCloseTo(0.6, 2);
  });

  it("detects low coverage in subgoals", async () => {
    const llm = createMockLLMClient([LOW_COVERAGE_RESPONSE]);

    const metrics = await evaluateDecompositionQuality(
      "Launch a complete e-commerce platform",
      [
        "Set up product listing page",
      ],
      { llmClient: llm }
    );

    expect(metrics.coverage).toBeLessThan(0.5);
  });

  it("logs a warning when coverage is below 0.5", async () => {
    const llm = createMockLLMClient([LOW_COVERAGE_RESPONSE]);
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await evaluateDecompositionQuality(
      "Launch a complete e-commerce platform",
      ["Set up product listing page"],
      { llmClient: llm, logger: mockLogger as never }
    );

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("poor quality detected")
    );
  });

  it("logs a warning when overlap is above 0.7", async () => {
    const llm = createMockLLMClient([HIGH_OVERLAP_RESPONSE]);
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await evaluateDecompositionQuality(
      "Improve code quality",
      [
        "Write unit tests to improve code quality",
        "Write tests to verify code quality",
      ],
      { llmClient: llm, logger: mockLogger as never }
    );

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("poor quality detected")
    );
  });

  it("does NOT log a warning for good quality", async () => {
    const llm = createMockLLMClient([GOOD_QUALITY_RESPONSE]);
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await evaluateDecompositionQuality(
      "Build a reliable web application",
      [
        "Set up CI/CD pipeline achieving 80% test coverage",
        "Implement error monitoring",
        "Deploy with zero-downtime strategy",
      ],
      { llmClient: llm, logger: mockLogger as never }
    );

    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("poor quality detected")
    );
  });

  it("handles empty subgoals — returns zero coverage and warns", async () => {
    const llm = createMockLLMClient([]);
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const metrics = await evaluateDecompositionQuality(
      "Build a reliable web application",
      [],
      { llmClient: llm, logger: mockLogger as never }
    );

    expect(metrics.coverage).toBe(0);
    expect(metrics.overlap).toBe(0);
    expect(metrics.actionability).toBe(0);
    expect(metrics.depthEfficiency).toBe(1);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("handles single subgoal without throwing", async () => {
    const llm = createMockLLMClient([GOOD_QUALITY_RESPONSE]);

    const metrics = await evaluateDecompositionQuality(
      "Build a reliable web application",
      ["Set up CI/CD pipeline achieving 80% test coverage"],
      { llmClient: llm }
    );

    expect(metrics).toBeDefined();
    expect(metrics.coverage).toBeGreaterThanOrEqual(0);
    expect(metrics.coverage).toBeLessThanOrEqual(1);
  });

  it("returns conservative metrics on LLM failure", async () => {
    const llmFail = createMockLLMClient(["invalid json {{{"]);

    const metrics = await evaluateDecompositionQuality(
      "Build a reliable web application",
      ["Set up CI/CD pipeline"],
      { llmClient: llmFail }
    );

    // Falls back to conservative zeros
    expect(metrics.coverage).toBe(0);
    expect(metrics.overlap).toBe(0);
    expect(metrics.actionability).toBe(0);
  });

  it("computes depthEfficiency correctly: 1 - (overlap * 0.5)", async () => {
    const overlapValue = 0.4;
    const response = JSON.stringify({
      coverage: 0.7,
      overlap: overlapValue,
      actionability: 0.7,
      reasoning: "Moderate overlap",
    });
    const llm = createMockLLMClient([response]);

    const metrics = await evaluateDecompositionQuality(
      "Improve system performance",
      ["Optimize database queries", "Add response caching"],
      { llmClient: llm }
    );

    expect(metrics.depthEfficiency).toBeCloseTo(1 - overlapValue * 0.5, 5);
  });
});

// ─── 2. GoalTreeManager still constructs and decomposes correctly ───

describe("GoalTreeManager construction", () => {
  it("constructs without errors", () => {
    const llm = createMockLLMClient([]);
    const manager = new GoalTreeManager(stateManager, llm, ethicsGate, dependencyGraph);
    expect(manager).toBeDefined();
  });
});
