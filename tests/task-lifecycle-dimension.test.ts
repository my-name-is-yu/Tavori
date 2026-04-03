import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { z } from "zod";
import { StateManager } from "../src/state/state-manager.js";
import { SessionManager } from "../src/execution/session-manager.js";
import { TrustManager } from "../src/traits/trust-manager.js";
import { StrategyManager } from "../src/strategy/strategy-manager.js";
import { StallDetector } from "../src/drive/stall-detector.js";
import { TaskLifecycle } from "../src/execution/task/task-lifecycle.js";
import type { GapVector } from "../src/types/gap.js";
import type { DriveContext } from "../src/types/drive.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
} from "../src/llm/llm-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import type { Dimension } from "../src/types/goal.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Spy LLM Client ───

function createSpyLLMClient(responses: string[]): ILLMClient & { calls: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> } {
  let callIndex = 0;
  const calls: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> = [];
  return {
    calls,
    async sendMessage(
      messages: LLMMessage[],
      options?: LLMRequestOptions
    ): Promise<LLMResponse> {
      calls.push({ messages, options });
      return {
        content: responses[callIndex++] ?? "",
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      const match = content.match(/```json\n?([\s\S]*?)\n?```/) || [
        null,
        content,
      ];
      return schema.parse(JSON.parse(match[1] ?? content));
    },
  };
}

// ─── Fixtures ───

function makeGapVector(
  goalId: string,
  dimensions: Array<{ name: string; gap: number }>
): GapVector {
  return {
    goal_id: goalId,
    gaps: dimensions.map((d) => ({
      dimension_name: d.name,
      raw_gap: d.gap,
      normalized_gap: d.gap,
      normalized_weighted_gap: d.gap,
      confidence: 0.8,
      uncertainty_weight: 1.0,
    })),
    timestamp: new Date().toISOString(),
  };
}

function makeDriveContext(
  dimensionNames: string[]
): DriveContext {
  const time_since_last_attempt: Record<string, number> = {};
  const deadlines: Record<string, number | null> = {};
  const opportunities: Record<string, { value: number; detected_at: string }> = {};

  for (const name of dimensionNames) {
    time_since_last_attempt[name] = 24;
    deadlines[name] = null;
  }

  return { time_since_last_attempt, deadlines, opportunities };
}

function makeDimension(
  name: string,
  confidenceTier: "mechanical" | "independent_review" | "self_report"
): Dimension {
  return {
    name,
    label: name,
    current_value: 0,
    threshold: { type: "min", value: 1 },
    confidence: 0.8,
    observation_method: {
      type: "mechanical",
      source: "test",
      schedule: null,
      endpoint: null,
      confidence_tier: confidenceTier,
    },
    last_updated: null,
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok",
    dimension_mapping: null,
  };
}

// ─── Test Suite ───

describe("TaskLifecycle", async () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let trustManager: TrustManager;
  let strategyManager: StrategyManager;
  let stallDetector: StallDetector;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    sessionManager = new SessionManager(stateManager);
    trustManager = new TrustManager(stateManager);
    stallDetector = new StallDetector(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createLifecycle(
    llmClient: ILLMClient,
    options?: {
      approvalFn?: (task: import("../src/types/task.js").Task) => Promise<boolean>;
      logger?: import("../src/runtime/logger.js").Logger;
      adapterRegistry?: import("../src/execution/task/task-lifecycle.js").AdapterRegistry;
      execFileSyncFn?: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
    }
  ): TaskLifecycle {
    strategyManager = new StrategyManager(stateManager, llmClient);
    return new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      options
    );
  }

  // ─────────────────────────────────────────────
  // selectTargetDimension
  // ─────────────────────────────────────────────

  describe("selectTargetDimension", () => {
    it("returns the highest-ranked dimension", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "coverage", gap: 0.3 },
        { name: "performance", gap: 0.8 },
        { name: "reliability", gap: 0.5 },
      ]);
      const context = makeDriveContext(["coverage", "performance", "reliability"]);

      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(result).toBe("performance");
    });

    it("returns correct dimension when multiple dimensions are ranked", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "dim_a", gap: 0.1 },
        { name: "dim_b", gap: 0.9 },
        { name: "dim_c", gap: 0.5 },
        { name: "dim_d", gap: 0.7 },
      ]);
      const context = makeDriveContext(["dim_a", "dim_b", "dim_c", "dim_d"]);

      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(result).toBe("dim_b");
    });

    it("works with a single dimension", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [{ name: "only_dim", gap: 0.5 }]);
      const context = makeDriveContext(["only_dim"]);

      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(result).toBe("only_dim");
    });

    it("throws on empty gap vector", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", []);
      const context = makeDriveContext([]);

      expect(() => lifecycle.selectTargetDimension(gapVector, context)).toThrow(
        "empty gap vector"
      );
    });

    it("selects dimension with highest gap when all timings equal", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "a", gap: 0.2 },
        { name: "b", gap: 0.6 },
      ]);
      const context = makeDriveContext(["a", "b"]);

      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(result).toBe("b");
    });

    it("handles tied gap values deterministically", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "first", gap: 0.5 },
        { name: "second", gap: 0.5 },
      ]);
      const context = makeDriveContext(["first", "second"]);

      // With identical gaps and identical context, the result should be stable
      const result1 = lifecycle.selectTargetDimension(gapVector, context);
      const result2 = lifecycle.selectTargetDimension(gapVector, context);
      expect(result1).toBe(result2);
    });

    it("considers time_since_last_attempt in scoring", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "recent", gap: 0.5 },
        { name: "stale", gap: 0.5 },
      ]);
      // "stale" has much higher time since last attempt, so higher dissatisfaction
      const context: DriveContext = {
        time_since_last_attempt: { recent: 0, stale: 100 },
        deadlines: { recent: null, stale: null },
        opportunities: {},
      };

      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(result).toBe("stale");
    });

    it("considers deadline urgency in scoring", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "no_deadline", gap: 0.6 },
        { name: "urgent", gap: 0.4 },
      ]);
      // "urgent" has a close deadline
      const context: DriveContext = {
        time_since_last_attempt: { no_deadline: 24, urgent: 24 },
        deadlines: { no_deadline: null, urgent: 1 }, // 1 hour remaining
        opportunities: {},
      };

      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(result).toBe("urgent");
    });

    it("considers opportunity value in scoring", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "normal", gap: 0.3 },
        { name: "opportunistic", gap: 0.3 },
      ]);
      const context: DriveContext = {
        time_since_last_attempt: { normal: 24, opportunistic: 24 },
        deadlines: { normal: null, opportunistic: null },
        opportunities: {
          opportunistic: { value: 2.0, detected_at: new Date().toISOString() },
        },
      };

      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(result).toBe("opportunistic");
    });

    it("returns a string dimension name", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);

      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    // ─── confidence-tier weighting ───

    it("prefers mechanical dimension over self_report even with smaller gap", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      // todo_count: gap=0.5, mechanical (weight 1.0) → weighted score = 0.5 * 1.0 = 0.5
      // todo_quality: gap=0.8, self_report (weight 0.3) → weighted score = 0.8 * 0.3 = 0.24
      const gapVector = makeGapVector("goal-1", [
        { name: "todo_count", gap: 0.5 },
        { name: "todo_quality", gap: 0.8 },
      ]);
      const context = makeDriveContext(["todo_count", "todo_quality"]);
      const dimensions = [
        makeDimension("todo_count", "mechanical"),
        makeDimension("todo_quality", "self_report"),
      ];

      const result = lifecycle.selectTargetDimension(gapVector, context, dimensions);
      expect(result).toBe("todo_count");
    });

    it("falls back to largest-gap when all dimensions have the same confidence_tier", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "dim_a", gap: 0.3 },
        { name: "dim_b", gap: 0.7 },
        { name: "dim_c", gap: 0.5 },
      ]);
      const context = makeDriveContext(["dim_a", "dim_b", "dim_c"]);
      const dimensions = [
        makeDimension("dim_a", "independent_review"),
        makeDimension("dim_b", "independent_review"),
        makeDimension("dim_c", "independent_review"),
      ];

      const result = lifecycle.selectTargetDimension(gapVector, context, dimensions);
      expect(result).toBe("dim_b");
    });

    it("defaults unmapped dimension to self_report weight (0.3)", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      // known_dim: gap=0.4, mechanical → weighted = 0.4 * 1.0 = 0.4
      // unknown_dim: gap=0.9, no dimension entry → defaults to self_report (0.3) → weighted = 0.9 * 0.3 = 0.27
      const gapVector = makeGapVector("goal-1", [
        { name: "known_dim", gap: 0.4 },
        { name: "unknown_dim", gap: 0.9 },
      ]);
      const context = makeDriveContext(["known_dim", "unknown_dim"]);
      // Only provide metadata for known_dim; unknown_dim has no entry
      const dimensions = [makeDimension("known_dim", "mechanical")];

      const result = lifecycle.selectTargetDimension(gapVector, context, dimensions);
      expect(result).toBe("known_dim");
    });

    it("uses drive-score ranking when no dimensions provided", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "small_gap", gap: 0.2 },
        { name: "large_gap", gap: 0.9 },
      ]);
      const context = makeDriveContext(["small_gap", "large_gap"]);

      // Without dimensions, falls back to unweighted ranking (largest gap wins)
      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(result).toBe("large_gap");
    });

    it("independent_review beats self_report at equal gap", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "reviewed", gap: 0.5 },
        { name: "unreliable", gap: 0.5 },
      ]);
      const context = makeDriveContext(["reviewed", "unreliable"]);
      const dimensions = [
        makeDimension("reviewed", "independent_review"),
        makeDimension("unreliable", "self_report"),
      ];

      const result = lifecycle.selectTargetDimension(gapVector, context, dimensions);
      expect(result).toBe("reviewed");
    });

    it("breaks equal weighted scores by dimension_name lexicographic ascending", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "zeta", gap: 0.5 },
        { name: "alpha", gap: 0.5 },
        { name: "mu", gap: 0.5 },
      ]);
      const context = makeDriveContext(["zeta", "alpha", "mu"]);
      const dimensions = [
        makeDimension("zeta", "self_report"),
        makeDimension("alpha", "self_report"),
        makeDimension("mu", "self_report"),
      ];

      const result = lifecycle.selectTargetDimension(gapVector, context, dimensions);
      expect(result).toBe("alpha");
    });
  });
});
