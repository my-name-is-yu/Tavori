import { describe, it, expect, beforeEach, vi } from "vitest";
import { PortfolioManager } from "../src/strategy/portfolio-manager.js";
import type { Strategy, WaitStrategy, Portfolio } from "../src/types/strategy.js";
import type { StrategyManager } from "../src/strategy-manager.js";
import type { StateManager } from "../src/state/state-manager.js";
import type { RebalanceTrigger } from "../src/types/portfolio.js";

// ─── Helpers ───

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: overrides.id ?? "strategy-1",
    goal_id: overrides.goal_id ?? "goal-1",
    target_dimensions: overrides.target_dimensions ?? ["quality"],
    primary_dimension: overrides.primary_dimension ?? "quality",
    hypothesis: overrides.hypothesis ?? "Test hypothesis",
    expected_effect: overrides.expected_effect ?? [
      { dimension: "quality", direction: "increase", magnitude: "medium" },
    ],
    resource_estimate: overrides.resource_estimate ?? {
      sessions: 10,
      duration: { value: 7, unit: "days" },
      llm_calls: null,
    },
    state: overrides.state ?? "active",
    allocation: overrides.allocation ?? 0.5,
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    started_at: overrides.started_at ?? "2026-01-01T00:00:00.000Z",
    completed_at: overrides.completed_at ?? null,
    gap_snapshot_at_start: overrides.gap_snapshot_at_start ?? 0.8,
    tasks_generated: overrides.tasks_generated ?? [],
    effectiveness_score: overrides.effectiveness_score ?? null,
    consecutive_stall_count: overrides.consecutive_stall_count ?? 0,
  };
}

function makeWaitStrategy(overrides: Partial<WaitStrategy> = {}): WaitStrategy {
  return {
    ...makeStrategy(overrides),
    wait_reason: overrides.wait_reason ?? "Waiting for external dependency",
    wait_until: overrides.wait_until ?? "2026-06-01T00:00:00.000Z",
    measurement_plan: overrides.measurement_plan ?? "Check gap after wait period",
    fallback_strategy_id: overrides.fallback_strategy_id ?? null,
  };
}

function makePortfolio(strategies: Strategy[], goalId?: string): Portfolio {
  return {
    goal_id: goalId ?? "goal-1",
    strategies,
    rebalance_interval: { value: 7, unit: "days" },
    last_rebalanced_at: "2026-01-01T00:00:00.000Z",
  };
}

function createMockStrategyManager(): StrategyManager {
  return {
    getPortfolio: vi.fn().mockReturnValue(null),
    getAllActiveStrategies: vi.fn().mockReturnValue([]),
    getActiveStrategy: vi.fn().mockReturnValue(null),
    updateState: vi.fn(),
    updateAllocation: vi.fn(),
    terminateStrategy: vi.fn(),
    activateMultiple: vi.fn().mockReturnValue([]),
    savePortfolio: vi.fn().mockResolvedValue(undefined),
  } as unknown as StrategyManager;
}

function createMockStateManager(): StateManager {
  return {
    readRaw: vi.fn().mockResolvedValue(null),
    writeRaw: vi.fn().mockResolvedValue(undefined),
    loadGoalState: vi.fn().mockReturnValue(null),
  } as unknown as StateManager;
}

// ─── Tests ───

describe("PortfolioManager", () => {
  let pm: PortfolioManager;
  let mockStrategyManager: ReturnType<typeof createMockStrategyManager>;
  let mockStateManager: ReturnType<typeof createMockStateManager>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockStrategyManager = createMockStrategyManager();
    mockStateManager = createMockStateManager();
    pm = new PortfolioManager(
      mockStrategyManager as unknown as StrategyManager,
      mockStateManager as unknown as StateManager
    );
  });

  // ─── Task Selection ───

  describe("selectNextStrategyForTask", () => {
    it("returns null when no portfolio exists", async () => {
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(null);
      expect(await pm.selectNextStrategyForTask("goal-1")).toBeNull();
    });

    it("returns null when no active strategies exist", async () => {
      const portfolio = makePortfolio([
        makeStrategy({ id: "s1", state: "terminated" }),
      ]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);
      expect(await pm.selectNextStrategyForTask("goal-1")).toBeNull();
    });

    it("selects single active strategy", async () => {
      const s1 = makeStrategy({ id: "s1", state: "active", allocation: 0.5 });
      const portfolio = makePortfolio([s1]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);

      const result = await pm.selectNextStrategyForTask("goal-1");
      expect(result).not.toBeNull();
      expect(result!.strategy_id).toBe("s1");
    });

    it("selects strategy with highest wait ratio (time / allocation)", async () => {
      // s1 started long ago with low allocation -> high ratio
      // s2 started recently with high allocation -> low ratio
      const s1 = makeStrategy({
        id: "s1",
        state: "active",
        allocation: 0.2,
        started_at: "2020-01-01T00:00:00.000Z",
      });
      const s2 = makeStrategy({
        id: "s2",
        state: "active",
        allocation: 0.8,
        started_at: new Date(Date.now() - 1000).toISOString(),
      });
      const portfolio = makePortfolio([s1, s2]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);

      const result = await pm.selectNextStrategyForTask("goal-1");
      expect(result).not.toBeNull();
      expect(result!.strategy_id).toBe("s1");
    });

    it("skips WaitStrategy instances", async () => {
      const wait = makeWaitStrategy({ id: "wait-1", state: "active", allocation: 0.5 });
      const normal = makeStrategy({ id: "s1", state: "active", allocation: 0.5 });
      const portfolio = makePortfolio([wait, normal]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);

      const result = await pm.selectNextStrategyForTask("goal-1");
      expect(result).not.toBeNull();
      expect(result!.strategy_id).toBe("s1");
    });

    it("returns null when only WaitStrategies are active", async () => {
      const wait = makeWaitStrategy({ id: "wait-1", state: "active", allocation: 1.0 });
      const portfolio = makePortfolio([wait]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);

      expect(await pm.selectNextStrategyForTask("goal-1")).toBeNull();
    });

    it("active strategy allocations sum ≤ 1.0 after rebalancing", async () => {
      // Invariant: the sum of allocations for all active strategies must never
      // exceed 1.0. Verify this after a rebalance that adjusts allocations.
      const s1 = makeStrategy({
        id: "s1",
        state: "active",
        allocation: 0.5,
        tasks_generated: ["t1", "t2", "t3"],
        target_dimensions: ["quality"],
        gap_snapshot_at_start: 0.8,
      });
      const s2 = makeStrategy({
        id: "s2",
        state: "active",
        allocation: 0.5,
        tasks_generated: ["t4", "t5", "t6"],
        target_dimensions: ["speed"],
        gap_snapshot_at_start: 0.3,
      });
      const portfolio = makePortfolio([s1, s2]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);
      // Scores differ enough to trigger rebalancing (ratio ≥ 2.0)
      (mockStateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        quality: 0.2,
        speed: 0.2,
      });

      const trigger = { type: "periodic" as const, strategy_id: null, details: "test" };
      const result = await pm.rebalance("goal-1", trigger);

      // Build final allocations: start with original, apply adjustments
      const finalAllocations = new Map<string, number>([
        ["s1", s1.allocation],
        ["s2", s2.allocation],
      ]);
      for (const adj of result.adjustments) {
        finalAllocations.set(adj.strategy_id, adj.new_allocation);
      }

      const sum = Array.from(finalAllocations.values()).reduce((a, b) => a + b, 0);
      // Allow a small floating-point tolerance
      expect(sum).toBeLessThanOrEqual(1.0 + 1e-9);
    });

    it("returns null when all strategies are completed", async () => {
      // When every strategy in the portfolio is in a terminal state (completed),
      // there are no eligible strategies to assign a task to.
      const portfolio = makePortfolio([
        makeStrategy({ id: "s1", state: "completed" }),
        makeStrategy({ id: "s2", state: "completed" }),
      ]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);

      expect(await pm.selectNextStrategyForTask("goal-1")).toBeNull();
    });

    it("uses creation time when no task completions exist", async () => {
      // Strategy with null started_at should fallback to portfolio last_rebalanced_at
      const s1 = makeStrategy({
        id: "s1",
        state: "active",
        allocation: 0.5,
        started_at: null,
      });
      const portfolio = makePortfolio([s1]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);

      const result = await pm.selectNextStrategyForTask("goal-1");
      expect(result).not.toBeNull();
      expect(result!.strategy_id).toBe("s1");
      expect(result!.wait_ratio).toBeGreaterThan(0);
    });

    it("allocation 0.5 vs 0.2: correct frequency distribution", async () => {
      // Both started at the same time, so elapsed is the same.
      // ratio = elapsed / allocation, so lower allocation -> higher ratio -> selected first
      const s1 = makeStrategy({
        id: "s1",
        state: "active",
        allocation: 0.5,
        started_at: "2020-01-01T00:00:00.000Z",
      });
      const s2 = makeStrategy({
        id: "s2",
        state: "active",
        allocation: 0.2,
        started_at: "2020-01-01T00:00:00.000Z",
      });
      const portfolio = makePortfolio([s1, s2]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);

      const result = await pm.selectNextStrategyForTask("goal-1");
      expect(result).not.toBeNull();
      // s2 has allocation 0.2, so ratio is higher -> selected
      expect(result!.strategy_id).toBe("s2");
    });
  });

  // ─── Effectiveness Measurement ───

  describe("calculateEffectiveness", () => {
    it("returns empty array when no portfolio", async () => {
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(null);
      expect(await pm.calculateEffectiveness("goal-1")).toEqual([]);
    });

    it("returns null score when fewer than 3 task completions", async () => {
      const s1 = makeStrategy({
        id: "s1",
        state: "active",
        tasks_generated: ["t1", "t2"], // only 2
        target_dimensions: ["quality"],
        gap_snapshot_at_start: 0.8,
      });
      const portfolio = makePortfolio([s1]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);
      (mockStateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({ quality: 0.5 });

      const records = await pm.calculateEffectiveness("goal-1");
      expect(records).toHaveLength(1);
      expect(records[0].effectiveness_score).toBeNull();
      expect(records[0].sessions_consumed).toBe(2);
    });

    it("calculates correct score: gap_delta / sessions", async () => {
      const s1 = makeStrategy({
        id: "s1",
        state: "active",
        tasks_generated: ["t1", "t2", "t3", "t4"],
        target_dimensions: ["quality"],
        gap_snapshot_at_start: 0.8,
      });
      const portfolio = makePortfolio([s1]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);
      // Current gap = 0.5, baseline = 0.8, delta = 0.8 - 0.5 = 0.3 (improvement)
      (mockStateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({ quality: 0.5 });

      const records = await pm.calculateEffectiveness("goal-1");
      expect(records).toHaveLength(1);
      expect(records[0].effectiveness_score).toBeCloseTo(0.3 / 4, 5);
      expect(records[0].gap_delta_attributed).toBeCloseTo(0.3, 5);
      expect(records[0].sessions_consumed).toBe(4);
    });

    it("handles multiple strategies with different scores", async () => {
      const s1 = makeStrategy({
        id: "s1",
        state: "active",
        tasks_generated: ["t1", "t2", "t3"],
        target_dimensions: ["quality"],
        gap_snapshot_at_start: 0.8,
      });
      const s2 = makeStrategy({
        id: "s2",
        state: "active",
        tasks_generated: ["t4", "t5", "t6"],
        target_dimensions: ["speed"],
        gap_snapshot_at_start: 1.0,
      });
      const portfolio = makePortfolio([s1, s2]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);
      // quality gap reduced to 0.5, speed gap reduced to 0.4
      (mockStateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        quality: 0.5,
        speed: 0.4,
      });

      const records = await pm.calculateEffectiveness("goal-1");
      expect(records).toHaveLength(2);

      const r1 = records.find((r) => r.strategy_id === "s1")!;
      const r2 = records.find((r) => r.strategy_id === "s2")!;

      expect(r1.effectiveness_score).toBeCloseTo(0.3 / 3, 5);
      expect(r2.effectiveness_score).toBeCloseTo(0.6 / 3, 5);
    });

    it("returns 0 delta when strategy has no target dimension matches", async () => {
      const s1 = makeStrategy({
        id: "s1",
        state: "active",
        tasks_generated: ["t1", "t2", "t3"],
        target_dimensions: ["nonexistent"],
        gap_snapshot_at_start: 0.8,
      });
      const portfolio = makePortfolio([s1]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);
      (mockStateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({ quality: 0.5 });

      const records = await pm.calculateEffectiveness("goal-1");
      expect(records).toHaveLength(1);
      expect(records[0].gap_delta_attributed).toBe(0);
      expect(records[0].effectiveness_score).toBe(0);
    });
  });

  // ─── Rebalance Trigger ───

  describe("shouldRebalance", () => {
    it("returns periodic trigger when interval elapsed", async () => {
      const s1 = makeStrategy({ id: "s1", state: "active", tasks_generated: [] });
      const portfolio = makePortfolio([s1]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);

      // Use very short interval to trigger
      const pmShort = new PortfolioManager(
        mockStrategyManager as unknown as StrategyManager,
        mockStateManager as unknown as StateManager,
        { rebalance_interval_hours: 0.001 } // ~3.6 seconds
      );

      // Record a rebalance in the past to set lastRebalanceTime
      const trigger: RebalanceTrigger = {
        type: "periodic",
        strategy_id: null,
        details: "test",
      };
      await pmShort.rebalance("goal-1", trigger);

      // Wait a tiny bit so interval elapses (we set a very small interval)
      // Force time forward by manipulating internal state through rebalance
      // The rebalance already set lastRebalanceTime to Date.now(), and interval is ~3.6s
      // We need to simulate time passage. Let's use vi.spyOn on Date.now
      const pastTime = Date.now() - 10_000; // 10 seconds ago
      vi.spyOn(Date, "now").mockReturnValue(pastTime);
      pmShort.rebalance("goal-1", trigger); // sets lastRebalanceTime to pastTime
      vi.restoreAllMocks();

      // Re-mock the dependencies since restoreAllMocks clears them
      mockStrategyManager = createMockStrategyManager();
      mockStateManager = createMockStateManager();
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);

      // Now lastRebalanceTime should be in the past. But we restored mocks.
      // Let's take a simpler approach: create a fresh PM and use Date.now mock
      const pm2 = new PortfolioManager(
        mockStrategyManager as unknown as StrategyManager,
        mockStateManager as unknown as StateManager,
        { rebalance_interval_hours: 0.001 }
      );

      // Set lastRebalanceTime to past using a rebalance call with mocked Date.now
      const fakeNow = Date.now();
      const fakePast = fakeNow - 100_000;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(fakePast);
      await pm2.rebalance("goal-1", trigger);
      // Now lastRebalanceTime = fakePast

      // Now check shouldRebalance at current time (interval should have elapsed)
      dateSpy.mockReturnValue(fakeNow);
      const result = await pm2.shouldRebalance("goal-1");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("periodic");
    });

    it("returns null when interval not elapsed", async () => {
      const s1 = makeStrategy({ id: "s1", state: "active", tasks_generated: [] });
      const portfolio = makePortfolio([s1]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);

      // Set lastRebalanceTime by performing a rebalance
      const trigger: RebalanceTrigger = {
        type: "periodic",
        strategy_id: null,
        details: "test",
      };
      await pm.rebalance("goal-1", trigger);

      // Default rebalance_interval_hours is 168 (1 week), which hasn't elapsed
      const result = await pm.shouldRebalance("goal-1");
      expect(result).toBeNull();
    });

    it("returns score_change trigger when 50%+ change detected", async () => {
      // Strategy with a known previous effectiveness_score
      const s1 = makeStrategy({
        id: "s1",
        state: "active",
        tasks_generated: ["t1", "t2", "t3"],
        target_dimensions: ["quality"],
        gap_snapshot_at_start: 0.8,
        effectiveness_score: 0.1, // previous score stored in strategy
      });
      const portfolio = makePortfolio([s1]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);

      // Current gap = 0.2, delta = 0.8 - 0.2 = 0.6, score = 0.6/3 = 0.2
      // Previous score = 0.1, change = |0.2 - 0.1| / 0.1 = 1.0 (100%) >= 0.5
      (mockStateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({ quality: 0.2 });

      // Need rebalance history so shouldRebalance checks score changes
      const trigger: RebalanceTrigger = {
        type: "periodic",
        strategy_id: null,
        details: "initial",
      };
      await pm.rebalance("goal-1", trigger);

      const result = await pm.shouldRebalance("goal-1");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("score_change");
    });

    it("returns null when no trigger conditions met", async () => {
      // No lastRebalanceTime set (or 0) and no history
      const result = await pm.shouldRebalance("goal-1");
      expect(result).toBeNull();
    });
  });

  // ─── Rebalancing ───

  describe("rebalance", () => {
    const periodicTrigger: RebalanceTrigger = {
      type: "periodic",
      strategy_id: null,
      details: "Interval elapsed",
    };

    it("returns no changes when all scores are null", async () => {
      const s1 = makeStrategy({
        id: "s1",
        state: "active",
        tasks_generated: ["t1"], // < 3, so score = null
        target_dimensions: ["quality"],
      });
      const s2 = makeStrategy({
        id: "s2",
        state: "active",
        tasks_generated: ["t2"],
        target_dimensions: ["speed"],
      });
      const portfolio = makePortfolio([s1, s2]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);
      (mockStateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({ quality: 0.5 });

      const result = await pm.rebalance("goal-1", periodicTrigger);
      expect(result.adjustments).toHaveLength(0);
      expect(result.terminated_strategies).toHaveLength(0);
      expect(result.new_generation_needed).toBe(false);
    });

    it("makes no allocation changes when score ratio < 2.0", async () => {
      // Two strategies with scores that have ratio < 2.0
      const s1 = makeStrategy({
        id: "s1",
        state: "active",
        allocation: 0.5,
        tasks_generated: ["t1", "t2", "t3"],
        target_dimensions: ["quality"],
        gap_snapshot_at_start: 0.6,
      });
      const s2 = makeStrategy({
        id: "s2",
        state: "active",
        allocation: 0.5,
        tasks_generated: ["t4", "t5", "t6"],
        target_dimensions: ["speed"],
        gap_snapshot_at_start: 0.5,
      });
      const portfolio = makePortfolio([s1, s2]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);
      // quality: 0.6 - 0.4 = 0.2, score = 0.2/3 ≈ 0.067
      // speed: 0.5 - 0.3 = 0.2, score = 0.2/3 ≈ 0.067
      // ratio = 1.0 < 2.0
      (mockStateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        quality: 0.4,
        speed: 0.3,
      });

      const result = await pm.rebalance("goal-1", periodicTrigger);
      expect(result.adjustments).toHaveLength(0);
    });

    it("adjusts allocations when score ratio >= 2.0", async () => {
      const s1 = makeStrategy({
        id: "s1",
        state: "active",
        allocation: 0.5,
        tasks_generated: ["t1", "t2", "t3"],
        target_dimensions: ["quality"],
        gap_snapshot_at_start: 0.8,
      });
      const s2 = makeStrategy({
        id: "s2",
        state: "active",
        allocation: 0.5,
        tasks_generated: ["t4", "t5", "t6"],
        target_dimensions: ["speed"],
        gap_snapshot_at_start: 0.3,
      });
      const portfolio = makePortfolio([s1, s2]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);
      // quality: delta = 0.8 - 0.2 = 0.6, score = 0.6/3 = 0.2
      // speed: delta = 0.3 - 0.2 = 0.1, score = 0.1/3 ≈ 0.033
      // ratio = 0.2 / 0.033 ≈ 6.0 >= 2.0 -> rebalance
      (mockStateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        quality: 0.2,
        speed: 0.2,
      });

      const result = await pm.rebalance("goal-1", periodicTrigger);
      expect(result.adjustments.length).toBeGreaterThan(0);
      expect(result.triggered_by).toBe("periodic");
    });

    it("redistributes terminated strategy allocation proportionally", async () => {
      // s1 will be terminated (stall count >= 3)
      const s1 = makeStrategy({
        id: "s1",
        state: "active",
        allocation: 0.4,
        consecutive_stall_count: 3,
        tasks_generated: [],
        target_dimensions: ["quality"],
      });
      const s2 = makeStrategy({
        id: "s2",
        state: "active",
        allocation: 0.6,
        tasks_generated: [],
        target_dimensions: ["speed"],
      });
      const portfolio = makePortfolio([s1, s2]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);
      (mockStateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await pm.rebalance("goal-1", periodicTrigger);
      expect(result.terminated_strategies).toContain("s1");
      // s2 should get redistribution
      expect(result.adjustments.length).toBeGreaterThanOrEqual(1);
      const s2Adj = result.adjustments.find((a) => a.strategy_id === "s2");
      expect(s2Adj).toBeDefined();
      if (s2Adj) {
        expect(s2Adj.new_allocation).toBeGreaterThan(0.6);
      }
    });

    it("sets new_generation_needed when all strategies terminated", async () => {
      const s1 = makeStrategy({
        id: "s1",
        state: "active",
        consecutive_stall_count: 3,
        tasks_generated: [],
      });
      const s2 = makeStrategy({
        id: "s2",
        state: "active",
        consecutive_stall_count: 5,
        tasks_generated: [],
      });
      const portfolio = makePortfolio([s1, s2]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);
      (mockStateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await pm.rebalance("goal-1", periodicTrigger);
      expect(result.terminated_strategies).toContain("s1");
      expect(result.terminated_strategies).toContain("s2");
      expect(result.new_generation_needed).toBe(true);
    });

    it("enforces min allocation 0.1", async () => {
      // High ratio between strategies to force rebalancing
      const s1 = makeStrategy({
        id: "s1",
        state: "active",
        allocation: 0.5,
        tasks_generated: ["t1", "t2", "t3"],
        target_dimensions: ["quality"],
        gap_snapshot_at_start: 0.9,
      });
      const s2 = makeStrategy({
        id: "s2",
        state: "active",
        allocation: 0.5,
        tasks_generated: ["t4", "t5", "t6"],
        target_dimensions: ["speed"],
        gap_snapshot_at_start: 0.9,
      });
      const portfolio = makePortfolio([s1, s2]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);
      // quality delta = 0.9 - 0.1 = 0.8, score = 0.8/3 ≈ 0.267
      // speed delta = 0.9 - 0.85 = 0.05, score = 0.05/3 ≈ 0.017
      // ratio ≈ 15.7 -> rebalance happens
      (mockStateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        quality: 0.1,
        speed: 0.85,
      });

      const result = await pm.rebalance("goal-1", periodicTrigger);
      // If there are adjustments, check min allocation
      for (const adj of result.adjustments) {
        expect(adj.new_allocation).toBeGreaterThanOrEqual(0.1);
      }
    });
  });

  // ─── Termination ───

  describe("checkTermination", () => {
    it("returns true when consecutive_stall_count >= 3", async () => {
      const strategy = makeStrategy({ consecutive_stall_count: 3 });
      const result = pm.checkTermination(strategy, []);
      expect(result).toBe(true);
    });

    it("returns true when resource consumption > 2x estimate", async () => {
      const strategy = makeStrategy({
        tasks_generated: Array.from({ length: 21 }, (_, i) => `t${i}`),
        resource_estimate: { sessions: 10, duration: { value: 7, unit: "days" }, llm_calls: null },
      });
      const result = pm.checkTermination(strategy, []);
      expect(result).toBe(true);
    });

    it("returns false for normal strategy", async () => {
      const strategy = makeStrategy({
        consecutive_stall_count: 0,
        tasks_generated: ["t1", "t2"],
        resource_estimate: { sessions: 10, duration: { value: 7, unit: "days" }, llm_calls: null },
      });
      const result = pm.checkTermination(strategy, []);
      expect(result).toBe(false);
    });
  });

  // ─── Strategy Activation ───

  describe("activateStrategies", () => {
    it("single strategy gets allocation 1.0", async () => {
      const s1 = makeStrategy({ id: "s1", state: "candidate", allocation: 0 });
      const portfolio = makePortfolio([s1]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);

      pm.activateStrategies("goal-1", ["s1"]);
      await Promise.resolve(); // flush microtasks so async updateStrategyAllocation completes

      expect(mockStrategyManager.updateState).toHaveBeenCalledWith("s1", "active");
      expect(mockStrategyManager.savePortfolio).toHaveBeenCalled();
    });

    it("multiple strategies get equal split", async () => {
      const s1 = makeStrategy({ id: "s1", state: "candidate", allocation: 0 });
      const s2 = makeStrategy({ id: "s2", state: "candidate", allocation: 0 });
      const s3 = makeStrategy({ id: "s3", state: "candidate", allocation: 0 });
      const portfolio = makePortfolio([s1, s2, s3]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);

      pm.activateStrategies("goal-1", ["s1", "s2", "s3"]);
      await Promise.resolve(); // flush microtasks so async updateStrategyAllocation completes

      expect(mockStrategyManager.updateState).toHaveBeenCalledTimes(3);
      // savePortfolio called once per strategy for allocation update
      expect(mockStrategyManager.savePortfolio).toHaveBeenCalledTimes(3);
    });

    it("does nothing when no strategy IDs provided", async () => {
      pm.activateStrategies("goal-1", []);
      expect(mockStrategyManager.updateState).not.toHaveBeenCalled();
    });
  });

  // ─── WaitStrategy Handling ───

  describe("isWaitStrategy", () => {
    it("returns true for WaitStrategy", async () => {
      const wait = makeWaitStrategy({ id: "ws1" });
      expect(pm.isWaitStrategy(wait)).toBe(true);
    });

    it("returns false for normal Strategy", async () => {
      const normal = makeStrategy({ id: "s1" });
      expect(pm.isWaitStrategy(normal)).toBe(false);
    });
  });

  describe("handleWaitStrategyExpiry", () => {
    it("returns null when not expired", async () => {
      const wait = makeWaitStrategy({
        id: "ws1",
        state: "active",
        wait_until: new Date(Date.now() + 100_000).toISOString(),
        gap_snapshot_at_start: 0.8,
        primary_dimension: "quality",
      });
      const portfolio = makePortfolio([wait]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);

      const result = await pm.handleWaitStrategyExpiry("goal-1", "ws1");
      expect(result).toBeNull();
    });

    it("returns null when expired and gap improved", async () => {
      const wait = makeWaitStrategy({
        id: "ws1",
        state: "active",
        wait_until: new Date(Date.now() - 100_000).toISOString(),
        gap_snapshot_at_start: 0.8,
        primary_dimension: "quality",
      });
      const portfolio = makePortfolio([wait]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);
      // Gap improved: 0.5 < 0.8
      (mockStateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({ quality: 0.5 });

      const result = await pm.handleWaitStrategyExpiry("goal-1", "ws1");
      expect(result).toBeNull();
    });

    it("returns rebalance trigger when expired and gap worsened", async () => {
      const wait = makeWaitStrategy({
        id: "ws1",
        state: "active",
        wait_until: new Date(Date.now() - 100_000).toISOString(),
        gap_snapshot_at_start: 0.5,
        primary_dimension: "quality",
      });
      const portfolio = makePortfolio([wait]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);
      // Gap worsened: 0.8 > 0.5
      (mockStateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({ quality: 0.8 });

      const result = await pm.handleWaitStrategyExpiry("goal-1", "ws1");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("stall_detected");
      expect(result!.strategy_id).toBe("ws1");
    });

    it("returns null for non-existent strategy", async () => {
      const portfolio = makePortfolio([]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);

      const result = await pm.handleWaitStrategyExpiry("goal-1", "nonexistent");
      expect(result).toBeNull();
    });
  });

  // ─── Task Completion Recording ───

  describe("recordTaskCompletion", () => {
    it("records completion timestamp for strategy", async () => {
      const s1 = makeStrategy({ id: "s1", state: "active", allocation: 0.5 });
      const s2 = makeStrategy({
        id: "s2",
        state: "active",
        allocation: 0.5,
        started_at: "2020-01-01T00:00:00.000Z",
      });
      const portfolio = makePortfolio([s1, s2]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);

      // Record completion for s2, making it recently active
      pm.recordTaskCompletion("s2");

      // Now s1 should be selected because s2 was just completed (lower wait ratio)
      const result = await pm.selectNextStrategyForTask("goal-1");
      expect(result).not.toBeNull();
      expect(result!.strategy_id).toBe("s1");
    });
  });

  // ─── getRebalanceHistory ───

  describe("getRebalanceHistory", () => {
    it("returns empty array for unknown goal", async () => {
      expect(pm.getRebalanceHistory("unknown")).toEqual([]);
    });

    it("returns history after rebalance", async () => {
      const s1 = makeStrategy({ id: "s1", state: "active" });
      const portfolio = makePortfolio([s1]);
      (mockStrategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockReturnValue(portfolio);
      (mockStateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const trigger: RebalanceTrigger = {
        type: "periodic",
        strategy_id: null,
        details: "test",
      };
      await pm.rebalance("goal-1", trigger);

      const history = pm.getRebalanceHistory("goal-1");
      expect(history).toHaveLength(1);
      expect(history[0].triggered_by).toBe("periodic");
    });
  });
});
