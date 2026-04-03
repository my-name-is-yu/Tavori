import { describe, it, expect, vi, beforeEach } from "vitest";
import { IterationBudget } from "../src/loop/iteration-budget.js";
import { runTreeIteration } from "../src/loop/tree-loop-runner.js";
import { CoreLoop } from "../src/loop/core-loop.js";
import type { CoreLoopDeps, LoopConfig } from "../src/loop/core-loop.js";

// ─── Unit tests: IterationBudget ───

describe("IterationBudget", () => {
  describe("constructor defaults", () => {
    it("initializes consumed to 0", () => {
      const budget = new IterationBudget(10);
      expect(budget.consumed).toBe(0);
    });

    it("sets total from constructor arg", () => {
      const budget = new IterationBudget(50);
      expect(budget.total).toBe(50);
    });

    it("sets perNodeLimit when provided", () => {
      const budget = new IterationBudget(100, 5);
      expect(budget.perNodeLimit).toBe(5);
    });

    it("perNodeLimit is undefined when not provided", () => {
      const budget = new IterationBudget(10);
      expect(budget.perNodeLimit).toBeUndefined();
    });

    it("is not exhausted at start", () => {
      const budget = new IterationBudget(10);
      expect(budget.exhausted).toBe(false);
    });
  });

  describe("consume() basic counting", () => {
    it("increments consumed by 1 by default", () => {
      const budget = new IterationBudget(10);
      budget.consume();
      expect(budget.consumed).toBe(1);
    });

    it("increments consumed by custom count", () => {
      const budget = new IterationBudget(10);
      budget.consume(3);
      expect(budget.consumed).toBe(3);
    });

    it("returns allowed=true when within budget", () => {
      const budget = new IterationBudget(10);
      const { allowed } = budget.consume();
      expect(allowed).toBe(true);
    });

    it("updates remaining correctly", () => {
      const budget = new IterationBudget(10);
      budget.consume(4);
      expect(budget.remaining).toBe(6);
    });
  });

  describe("consume() exhaustion", () => {
    it("returns allowed=false when budget is exactly exhausted", () => {
      const budget = new IterationBudget(3);
      budget.consume(); // 1
      budget.consume(); // 2
      budget.consume(); // 3
      const { allowed } = budget.consume(); // 4 — over limit
      expect(allowed).toBe(false);
    });

    it("returns allowed=false without incrementing consumed when exhausted", () => {
      const budget = new IterationBudget(2);
      budget.consume();
      budget.consume();
      budget.consume(); // over
      expect(budget.consumed).toBe(2);
    });

    it("sets exhausted=true when all iterations are consumed", () => {
      const budget = new IterationBudget(1);
      budget.consume();
      expect(budget.exhausted).toBe(true);
    });

    it("includes budget message in warnings when exhausted", () => {
      const budget = new IterationBudget(2);
      budget.consume();
      budget.consume();
      const { warnings } = budget.consume();
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toMatch(/Budget exhausted/);
    });
  });

  describe("warning emission at thresholds", () => {
    it("emits warning at 70% utilization", () => {
      const budget = new IterationBudget(10);
      const allWarnings: string[] = [];
      for (let i = 0; i < 7; i++) {
        const { warnings } = budget.consume();
        allWarnings.push(...warnings);
      }
      const has70Warning = allWarnings.some((w) => w.includes("70%"));
      expect(has70Warning).toBe(true);
    });

    it("emits warning at 90% utilization", () => {
      const budget = new IterationBudget(10);
      const allWarnings: string[] = [];
      for (let i = 0; i < 9; i++) {
        const { warnings } = budget.consume();
        allWarnings.push(...warnings);
      }
      const has90Warning = allWarnings.some((w) => w.includes("90%"));
      expect(has90Warning).toBe(true);
    });

    it("warnings are only emitted once at 70%", () => {
      const budget = new IterationBudget(20);
      const count70Warnings: string[] = [];
      for (let i = 0; i < 20; i++) {
        const { warnings } = budget.consume();
        for (const w of warnings) {
          if (w.includes("70%")) count70Warnings.push(w);
        }
      }
      expect(count70Warnings.length).toBe(1);
    });

    it("warnings only emitted once at 90%", () => {
      const budget = new IterationBudget(20);
      const count90Warnings: string[] = [];
      for (let i = 0; i < 20; i++) {
        const { warnings } = budget.consume();
        for (const w of warnings) {
          if (w.includes("90%")) count90Warnings.push(w);
        }
      }
      expect(count90Warnings.length).toBe(1);
    });

    it("does not emit warnings before threshold", () => {
      const budget = new IterationBudget(10);
      const allWarnings: string[] = [];
      for (let i = 0; i < 6; i++) {
        const { warnings } = budget.consume();
        allWarnings.push(...warnings);
      }
      expect(allWarnings.length).toBe(0);
    });
  });

  describe("getters", () => {
    it("remaining = total - consumed", () => {
      const budget = new IterationBudget(20);
      budget.consume(8);
      expect(budget.remaining).toBe(12);
    });

    it("utilizationRatio = consumed / total", () => {
      const budget = new IterationBudget(10);
      budget.consume(5);
      expect(budget.utilizationRatio).toBeCloseTo(0.5);
    });

    it("utilizationRatio is 0 at start", () => {
      const budget = new IterationBudget(10);
      expect(budget.utilizationRatio).toBe(0);
    });
  });

  describe("toJSON / fromJSON round-trip", () => {
    it("serializes and deserializes correctly", () => {
      const budget = new IterationBudget(50, 10);
      budget.consume(5);
      const json = budget.toJSON();
      const restored = IterationBudget.fromJSON(json);
      expect(restored.total).toBe(50);
      expect(restored.consumed).toBe(5);
      expect(restored.perNodeLimit).toBe(10);
      expect(restored.remaining).toBe(45);
    });

    it("preserves warning thresholds in round-trip", () => {
      const budget = new IterationBudget(100);
      const json = budget.toJSON();
      expect(json.warning_thresholds).toEqual([0.7, 0.9]);
      const restored = IterationBudget.fromJSON(json);
      // Emit warning at 70% on restored budget to verify thresholds work
      const allWarnings: string[] = [];
      for (let i = restored.consumed; i < 70; i++) {
        const { warnings } = restored.consume();
        allWarnings.push(...warnings);
      }
      expect(allWarnings.some((w) => w.includes("70%"))).toBe(true);
    });

    it("handles missing per_node_limit (undefined)", () => {
      const budget = new IterationBudget(10);
      const json = budget.toJSON();
      const restored = IterationBudget.fromJSON(json);
      expect(restored.perNodeLimit).toBeUndefined();
    });
  });

  describe("perNodeLimit", () => {
    it("can be read from constructor", () => {
      const budget = new IterationBudget(100, 3);
      expect(budget.perNodeLimit).toBe(3);
    });

    it("is included in toJSON as per_node_limit", () => {
      const budget = new IterationBudget(100, 7);
      expect(budget.toJSON().per_node_limit).toBe(7);
    });
  });
});

// ─── Integration: CoreLoop with IterationBudget ───

function makeMockDeps(): CoreLoopDeps {
  const mockGoal = {
    id: "goal-1",
    title: "Test Goal",
    status: "active" as const,
    dimensions: [
      {
        name: "dim1",
        threshold: { type: "min" as const, value: 100 },
        current_value: 50,
        confidence: 0.8,
        last_updated: new Date().toISOString(),
      },
    ],
    children_ids: [],
    parent_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  return {
    stateManager: {
      loadGoal: vi.fn().mockResolvedValue(mockGoal),
      saveGoal: vi.fn().mockResolvedValue(undefined),
      saveGapHistory: vi.fn().mockResolvedValue(undefined),
      readRaw: vi.fn().mockResolvedValue(null),
      writeRaw: vi.fn().mockResolvedValue(undefined),
      archiveGoal: vi.fn().mockResolvedValue(undefined),
      restoreFromCheckpoint: vi.fn().mockResolvedValue(0),
    } as unknown as CoreLoopDeps["stateManager"],
    observationEngine: {
      observe: vi.fn().mockResolvedValue({
        dimensionName: "dim1",
        observedValue: 50,
        confidence: 0.8,
        source: "mock",
        timestamp: new Date().toISOString(),
      }),
    } as unknown as CoreLoopDeps["observationEngine"],
    gapCalculator: {
      calculateGapVector: vi.fn().mockReturnValue({
        dimensions: [{ name: "dim1", gap: 0.5, normalizedGap: 0.5, confidence: 0.8, rawGap: 50 }],
        aggregateGap: 0.5,
        timestamp: new Date().toISOString(),
      }),
      aggregateGaps: vi.fn().mockReturnValue(0.5),
    },
    driveScorer: {
      scoreAllDimensions: vi.fn().mockReturnValue([]),
      rankDimensions: vi.fn().mockReturnValue([]),
    },
    taskLifecycle: {
      generateTask: vi.fn().mockResolvedValue(null),
    } as unknown as CoreLoopDeps["taskLifecycle"],
    satisficingJudge: {
      isGoalComplete: vi.fn().mockReturnValue({ is_complete: false, blocking_dimensions: [], low_confidence_dimensions: [], needs_verification_task: false, checked_at: new Date().toISOString() }),
      judgeCompletion: vi.fn().mockResolvedValue({ is_complete: false, blocking_dimensions: [], low_confidence_dimensions: [], needs_verification_task: false, checked_at: new Date().toISOString() }),
    } as unknown as CoreLoopDeps["satisficingJudge"],
    stallDetector: {
      detect: vi.fn().mockResolvedValue({ stalled: false }),
      resetEscalation: vi.fn().mockResolvedValue(undefined),
      getReport: vi.fn().mockReturnValue(null),
    } as unknown as CoreLoopDeps["stallDetector"],
    strategyManager: {
      getActiveStrategy: vi.fn().mockResolvedValue(null),
      rebalance: vi.fn().mockResolvedValue(undefined),
    } as unknown as CoreLoopDeps["strategyManager"],
    reportingEngine: {
      generateExecutionSummary: vi.fn().mockReturnValue({}),
      saveReport: vi.fn().mockResolvedValue(undefined),
    },
    driveSystem: {} as CoreLoopDeps["driveSystem"],
    adapterRegistry: {
      listAdapters: vi.fn().mockReturnValue(["mock"]),
      getAdapter: vi.fn().mockReturnValue(null),
    } as unknown as CoreLoopDeps["adapterRegistry"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as CoreLoopDeps["logger"],
  };
}

describe("CoreLoop integration with IterationBudget", () => {
  it("stops when shared budget is exhausted before maxIterations", async () => {
    const deps = makeMockDeps();
    const budget = new IterationBudget(2); // only 2 iterations allowed
    const config: LoopConfig = {
      maxIterations: 50,
      delayBetweenLoopsMs: 0,
      iterationBudget: budget,
    };
    const loop = new CoreLoop(deps, config);
    const result = await loop.run("goal-1");
    // Should stop after 2 iterations due to budget, not 50
    expect(result.totalIterations).toBeLessThanOrEqual(2);
    expect(budget.exhausted).toBe(true);
  });

  it("logs a warning when budget is exhausted", async () => {
    const deps = makeMockDeps();
    const budget = new IterationBudget(1);
    const config: LoopConfig = {
      maxIterations: 10,
      delayBetweenLoopsMs: 0,
      iterationBudget: budget,
    };
    const loop = new CoreLoop(deps, config);
    await loop.run("goal-1");
    const logger = deps.logger as { info: ReturnType<typeof vi.fn> };
    const infoCalls: string[] = logger.info.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(infoCalls.some((msg) => msg.includes("budget exhausted"))).toBe(true);
  });

  it("two loops sharing a single IterationBudget both consume from it", async () => {
    const sharedBudget = new IterationBudget(4);

    const deps1 = makeMockDeps();
    const config1: LoopConfig = {
      maxIterations: 50,
      delayBetweenLoopsMs: 0,
      iterationBudget: sharedBudget,
    };
    const loop1 = new CoreLoop(deps1, config1);
    await loop1.run("goal-1");

    // First loop should consume some iterations
    const afterLoop1 = sharedBudget.consumed;
    expect(afterLoop1).toBeGreaterThan(0);

    // Second loop shares the same budget — it should see remaining capacity
    const deps2 = makeMockDeps();
    const config2: LoopConfig = {
      maxIterations: 50,
      delayBetweenLoopsMs: 0,
      iterationBudget: sharedBudget,
    };
    const loop2 = new CoreLoop(deps2, config2);
    await loop2.run("goal-1");

    // Combined consumed should equal total (budget fully shared)
    expect(sharedBudget.consumed).toBe(sharedBudget.total);
    expect(sharedBudget.exhausted).toBe(true);
  });
});

// ─── Integration: perNodeLimit enforced across multiple runTreeIteration calls ───

describe("runTreeIteration perNodeLimit across multiple calls", () => {
  it("respects perNodeLimit when nodeConsumedMap is threaded across calls", async () => {
    const budget = new IterationBudget(10, 1); // perNodeLimit=1

    const mockGoal = {
      id: "root-1",
      title: "Root",
      status: "active" as const,
      dimensions: [{ name: "d1", threshold: { type: "min" as const, value: 10 }, current_value: 0, confidence: 0.8, last_updated: new Date().toISOString() }],
      children_ids: ["child-1"],
      parent_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const mockChild = {
      id: "child-1",
      title: "Child",
      status: "active" as const,
      dimensions: [{ name: "d1", threshold: { type: "min" as const, value: 10 }, current_value: 0, confidence: 0.8, last_updated: new Date().toISOString() }],
      children_ids: [],
      parent_id: "root-1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const mockOrchestrator = {
      selectNextNode: vi.fn().mockResolvedValue("child-1"),
      onNodeCompleted: vi.fn().mockResolvedValue(undefined),
      startTreeExecution: vi.fn().mockResolvedValue(undefined),
    };

    const deps = {
      stateManager: {
        loadGoal: vi.fn().mockImplementation((id: string) => {
          if (id === "root-1") return Promise.resolve(mockGoal);
          if (id === "child-1") return Promise.resolve(mockChild);
          return Promise.resolve(null);
        }),
        saveGoal: vi.fn().mockResolvedValue(undefined),
        saveGapHistory: vi.fn().mockResolvedValue(undefined),
        readRaw: vi.fn().mockResolvedValue(null),
        writeRaw: vi.fn().mockResolvedValue(undefined),
      },
      satisficingJudge: {
        isGoalComplete: vi.fn().mockReturnValue({ is_complete: false, blocking_dimensions: [], low_confidence_dimensions: [], needs_verification_task: false, checked_at: new Date().toISOString() }),
        judgeTreeCompletion: vi.fn().mockResolvedValue({ is_complete: false, blocking_dimensions: [], low_confidence_dimensions: [], needs_verification_task: false, checked_at: new Date().toISOString() }),
      },
      treeLoopOrchestrator: mockOrchestrator,
      stateAggregator: undefined,
      goalRefiner: undefined,
      goalTreeManager: undefined,
    } as unknown as CoreLoopDeps;

    const config = {
      maxIterations: 10,
      maxConsecutiveErrors: 3,
      delayBetweenLoopsMs: 0,
      adapterType: "openai_codex_cli" as const,
      treeMode: true,
      multiGoalMode: false,
      goalIds: [],
      minIterations: 1,
      autoArchive: false,
      dryRun: false,
      maxConsecutiveSkips: 5,
      iterationBudget: budget,
    };

    const runOneIteration = vi.fn().mockResolvedValue({
      loopIndex: 0,
      goalId: "child-1",
      gapAggregate: 0.5,
      driveScores: [],
      taskResult: null,
      stallDetected: false,
      stallReport: null,
      pivotOccurred: false,
      completionJudgment: { is_complete: false, blocking_dimensions: [], low_confidence_dimensions: [], needs_verification_task: false, checked_at: new Date().toISOString() },
      elapsedMs: 0,
      error: null,
    });

    const nodeConsumedMap = new Map<string, number>();

    // First call: should run (count=0 < limit=1)
    await runTreeIteration("root-1", 0, deps, config, undefined, runOneIteration, nodeConsumedMap);
    expect(runOneIteration).toHaveBeenCalledTimes(1);

    // Second call with same map: should be skipped (count=1 >= limit=1)
    await runTreeIteration("root-1", 1, deps, config, undefined, runOneIteration, nodeConsumedMap);
    // runOneIteration should NOT have been called again — node limit enforced
    expect(runOneIteration).toHaveBeenCalledTimes(1);
  });
});
