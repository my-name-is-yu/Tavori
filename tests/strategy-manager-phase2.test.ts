import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { StrategyManager } from "../src/strategy/strategy-manager.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Fixtures ───

const CANDIDATE_RESPONSE_ONE = `\`\`\`json
[
  {
    "hypothesis": "Increase daily writing output by dedicating the first 2 hours of each day to writing",
    "expected_effect": [
      { "dimension": "word_count", "direction": "increase", "magnitude": "medium" }
    ],
    "resource_estimate": {
      "sessions": 10,
      "duration": { "value": 14, "unit": "days" },
      "llm_calls": null
    },
    "allocation": 0.8
  }
]
\`\`\``;

const CANDIDATE_RESPONSE_TWO = `\`\`\`json
[
  {
    "hypothesis": "Use the Pomodoro technique for focused research sessions",
    "expected_effect": [
      { "dimension": "research_depth", "direction": "increase", "magnitude": "large" }
    ],
    "resource_estimate": {
      "sessions": 5,
      "duration": { "value": 7, "unit": "days" },
      "llm_calls": 2
    },
    "allocation": 0.6
  },
  {
    "hypothesis": "Create a structured outline before each writing session",
    "expected_effect": [
      { "dimension": "word_count", "direction": "increase", "magnitude": "small" }
    ],
    "resource_estimate": {
      "sessions": 3,
      "duration": { "value": 3, "unit": "days" },
      "llm_calls": null
    },
    "allocation": 0.4
  }
]
\`\`\``;

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── Phase 2 methods ───

describe("Phase 2 methods", () => {
  describe("activateMultiple", () => {
    it("activates single strategy with allocation 1.0", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
      const manager = new StrategyManager(stateManager, mock);
      const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
        currentGap: 0.7,
        pastStrategies: [],
      });

      const activated = await manager.activateMultiple("goal-1", [candidate!.id]);

      expect(activated).toHaveLength(1);
      expect(activated[0]!.state).toBe("active");
      expect(activated[0]!.allocation).toBe(1.0);
    });

    it("activates multiple strategies with equal split", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
      const manager = new StrategyManager(stateManager, mock);
      const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
        currentGap: 0.5,
        pastStrategies: [],
      });

      const activated = await manager.activateMultiple("goal-1", candidates.map((c) => c.id));

      expect(activated).toHaveLength(2);
      expect(activated[0]!.allocation).toBeCloseTo(0.5, 5);
      expect(activated[1]!.allocation).toBeCloseTo(0.5, 5);
    });

    it("respects min 0.1 and max 0.7 constraints", async () => {
      // With 2 candidates, 1/2 = 0.5 which is within [0.1, 0.7], so no clamping needed
      // Test min: can't test easily without 10+ candidates; test max with single candidate (1.0, no max clamp for single)
      // Test that equal split for 2 does NOT exceed 0.7
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
      const manager = new StrategyManager(stateManager, mock);
      const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
        currentGap: 0.5,
        pastStrategies: [],
      });

      const activated = await manager.activateMultiple("goal-1", candidates.map((c) => c.id));

      for (const s of activated) {
        expect(s.allocation).toBeGreaterThanOrEqual(0.1);
        expect(s.allocation).toBeLessThanOrEqual(0.7);
      }
    });

    it("throws when strategyIds is empty", async () => {
      const mock = createMockLLMClient([]);
      const manager = new StrategyManager(stateManager, mock);

      await expect(async () => await manager.activateMultiple("goal-1", [])).rejects.toThrow();
    });

    it("leaves non-targeted strategies unchanged when activating a subset of candidates", async () => {
      // Generate two candidates, activate only one — the other should stay as candidate
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
      const manager = new StrategyManager(stateManager, mock);
      const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
        currentGap: 0.5,
        pastStrategies: [],
      });

      // Activate only the first candidate
      const activated = await manager.activateMultiple("goal-1", [candidates[0]!.id]);
      expect(activated).toHaveLength(1);
      expect(activated[0]!.state).toBe("active");

      // Second candidate should remain as candidate
      const portfolio = await manager.getPortfolio("goal-1");
      const second = portfolio!.strategies.find((s) => s.id === candidates[1]!.id);
      expect(second!.state).toBe("candidate");
    });

    it("throws when a strategy is not in candidate state", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
      const manager = new StrategyManager(stateManager, mock);
      const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
        currentGap: 0.7,
        pastStrategies: [],
      });

      // First activation succeeds
      await manager.activateMultiple("goal-1", [candidate!.id]);

      // Second attempt on already-active strategy throws
      await expect(async () => await manager.activateMultiple("goal-1", [candidate!.id])).rejects.toThrow(
        "not in candidate state"
      );
    });
  });

  describe("terminateStrategy", () => {
    it("sets state to terminated", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
      const manager = new StrategyManager(stateManager, mock);
      const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
        currentGap: 0.7,
        pastStrategies: [],
      });
      await manager.updateState(candidate!.id, "active");

      const terminated = await manager.terminateStrategy("goal-1", candidate!.id, "test reason");

      expect(terminated.state).toBe("terminated");
    });

    it("redistributes allocation to remaining active strategies", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
      const manager = new StrategyManager(stateManager, mock);
      const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
        currentGap: 0.5,
        pastStrategies: [],
      });

      // Activate both with equal split (0.5 each)
      await manager.activateMultiple("goal-1", candidates.map((c) => c.id));

      // Terminate first; second should get all its allocation
      await manager.terminateStrategy("goal-1", candidates[0]!.id, "test reason");

      const portfolio = await manager.getPortfolio("goal-1");
      const remaining = portfolio!.strategies.find((s) => s.id === candidates[1]!.id);
      expect(remaining!.allocation).toBeGreaterThan(0.5);
    });

    it("handles last strategy termination (no redistribution)", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
      const manager = new StrategyManager(stateManager, mock);
      const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
        currentGap: 0.7,
        pastStrategies: [],
      });
      await manager.activateMultiple("goal-1", [candidate!.id]);

      // Should not throw even with no remaining strategies
      await expect(manager.terminateStrategy("goal-1", candidate!.id, "last strategy")).resolves.toBeDefined();

      const history = await manager.getStrategyHistory("goal-1");
      expect(history.some((s) => s.state === "terminated")).toBe(true);
    });

    it("archives terminated strategy to history", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
      const manager = new StrategyManager(stateManager, mock);
      const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
        currentGap: 0.7,
        pastStrategies: [],
      });
      await manager.updateState(candidate!.id, "active");

      await manager.terminateStrategy("goal-1", candidate!.id, "test reason");

      const history = await manager.getStrategyHistory("goal-1");
      expect(history.some((s) => s.id === candidate!.id && s.state === "terminated")).toBe(true);
    });
  });

  describe("createWaitStrategy", () => {
    it("creates strategy with wait fields", async () => {
      const mock = createMockLLMClient([]);
      const manager = new StrategyManager(stateManager, mock);

      const result = await manager.createWaitStrategy("goal-1", {
        hypothesis: "Wait for external data",
        wait_reason: "Awaiting market data",
        wait_until: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        measurement_plan: "Check market data API",
        fallback_strategy_id: null,
        target_dimensions: ["word_count"],
        primary_dimension: "word_count",
      });

      expect(result).toBeDefined();
      expect(result.hypothesis).toBe("Wait for external data");
    });

    it("sets state to candidate", async () => {
      const mock = createMockLLMClient([]);
      const manager = new StrategyManager(stateManager, mock);

      const result = await manager.createWaitStrategy("goal-1", {
        hypothesis: "Wait for external data",
        wait_reason: "Awaiting market data",
        wait_until: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        measurement_plan: "Check market data API",
        fallback_strategy_id: null,
        target_dimensions: ["word_count"],
        primary_dimension: "word_count",
      });

      expect(result.state).toBe("candidate");
    });

    it("stores in portfolio", async () => {
      const mock = createMockLLMClient([]);
      const manager = new StrategyManager(stateManager, mock);

      const result = await manager.createWaitStrategy("goal-1", {
        hypothesis: "Wait for external data",
        wait_reason: "Awaiting market data",
        wait_until: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        measurement_plan: "Check market data API",
        fallback_strategy_id: null,
        target_dimensions: ["word_count"],
        primary_dimension: "word_count",
      });

      const portfolio = await manager.getPortfolio("goal-1");
      expect(portfolio).not.toBeNull();
      expect(portfolio!.strategies.some((s) => s.id === result.id)).toBe(true);
    });

    it("assigns unique ID", async () => {
      const mock = createMockLLMClient([]);
      const manager = new StrategyManager(stateManager, mock);
      const params = {
        hypothesis: "Wait",
        wait_reason: "reason",
        wait_until: new Date(Date.now() + 86400000).toISOString(),
        measurement_plan: "plan",
        fallback_strategy_id: null,
        target_dimensions: ["dim1"],
        primary_dimension: "dim1",
      };

      const s1 = await manager.createWaitStrategy("goal-1", params);
      const s2 = await manager.createWaitStrategy("goal-1", params);

      expect(s1.id).not.toBe(s2.id);
    });
  });

  describe("suspendStrategy", () => {
    it("sets state to suspended", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
      const manager = new StrategyManager(stateManager, mock);
      const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
        currentGap: 0.7,
        pastStrategies: [],
      });
      await manager.updateState(candidate!.id, "active");

      const suspended = await manager.suspendStrategy("goal-1", candidate!.id);

      expect(suspended.state).toBe("suspended");
    });

    it("redistributes allocation to remaining active strategies", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
      const manager = new StrategyManager(stateManager, mock);
      const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
        currentGap: 0.5,
        pastStrategies: [],
      });

      await manager.activateMultiple("goal-1", candidates.map((c) => c.id));
      await manager.suspendStrategy("goal-1", candidates[0]!.id);

      const portfolio = await manager.getPortfolio("goal-1");
      const remaining = portfolio!.strategies.find((s) => s.id === candidates[1]!.id);
      expect(remaining!.allocation).toBeGreaterThan(0.5);
    });

    it("throws when strategy not found", async () => {
      const mock = createMockLLMClient([]);
      const manager = new StrategyManager(stateManager, mock);

      await expect(async () => await manager.suspendStrategy("goal-1", "nonexistent-id")).rejects.toThrow("not found");
    });

    it("throws when strategy is not active or evaluating", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
      const manager = new StrategyManager(stateManager, mock);
      const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
        currentGap: 0.7,
        pastStrategies: [],
      });

      // candidate state is not active — should throw
      await expect(async () => await manager.suspendStrategy("goal-1", candidate!.id)).rejects.toThrow();
    });
  });

  describe("resumeStrategy", () => {
    it("restores to active state", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
      const manager = new StrategyManager(stateManager, mock);
      const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
        currentGap: 0.5,
        pastStrategies: [],
      });

      await manager.activateMultiple("goal-1", candidates.map((c) => c.id));
      await manager.suspendStrategy("goal-1", candidates[0]!.id);

      const resumed = await manager.resumeStrategy("goal-1", candidates[0]!.id, 0.4);

      expect(resumed.state).toBe("active");
      expect(resumed.allocation).toBe(0.4);
    });

    it("adjusts other allocations to maintain sum close to 1.0", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
      const manager = new StrategyManager(stateManager, mock);
      const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
        currentGap: 0.5,
        pastStrategies: [],
      });

      await manager.activateMultiple("goal-1", candidates.map((c) => c.id));
      await manager.suspendStrategy("goal-1", candidates[0]!.id);
      await manager.resumeStrategy("goal-1", candidates[0]!.id, 0.4);

      const portfolio = await manager.getPortfolio("goal-1");
      const active = portfolio!.strategies.filter(
        (s) => s.state === "active" || s.state === "evaluating"
      );
      const totalAlloc = active.reduce((sum, s) => sum + s.allocation, 0);
      expect(totalAlloc).toBeCloseTo(1.0, 5);
    });

    it("throws when strategy is not suspended", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
      const manager = new StrategyManager(stateManager, mock);
      const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
        currentGap: 0.7,
        pastStrategies: [],
      });
      await manager.updateState(candidate!.id, "active");

      await expect(async () => await manager.resumeStrategy("goal-1", candidate!.id, 0.5)).rejects.toThrow(
        "must be suspended"
      );
    });
  });

  describe("getAllActiveStrategies", () => {
    it("returns active and evaluating strategies", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
      const manager = new StrategyManager(stateManager, mock);
      const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
        currentGap: 0.5,
        pastStrategies: [],
      });

      await manager.activateMultiple("goal-1", candidates.map((c) => c.id));
      // Move first to evaluating
      await manager.updateState(candidates[0]!.id, "evaluating");

      const active = await manager.getAllActiveStrategies("goal-1");

      expect(active).toHaveLength(2);
      const states = active.map((s) => s.state);
      expect(states).toContain("evaluating");
      expect(states).toContain("active");
    });

    it("excludes suspended/terminated/candidate strategies", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
      const manager = new StrategyManager(stateManager, mock);
      const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
        currentGap: 0.5,
        pastStrategies: [],
      });

      // Activate both, then suspend one
      await manager.activateMultiple("goal-1", candidates.map((c) => c.id));
      await manager.suspendStrategy("goal-1", candidates[0]!.id);

      const active = await manager.getAllActiveStrategies("goal-1");

      // Only the non-suspended one should appear
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe(candidates[1]!.id);
    });

    it("returns empty array when no active strategies exist", async () => {
      const mock = createMockLLMClient([]);
      const manager = new StrategyManager(stateManager, mock);

      expect(await manager.getAllActiveStrategies("goal-1")).toEqual([]);
    });
  });

  describe("updateAllocation", () => {
    it("updates allocation for specific strategy", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
      const manager = new StrategyManager(stateManager, mock);
      const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
        currentGap: 0.7,
        pastStrategies: [],
      });
      await manager.updateState(candidate!.id, "active");

      await manager.updateAllocation("goal-1", candidate!.id, 0.6);

      const portfolio = await manager.getPortfolio("goal-1");
      const updated = portfolio!.strategies.find((s) => s.id === candidate!.id);
      expect(updated!.allocation).toBe(0.6);
    });

    it("throws when allocation is out of [0, 1] range", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
      const manager = new StrategyManager(stateManager, mock);
      const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
        currentGap: 0.7,
        pastStrategies: [],
      });

      await expect(async () => await manager.updateAllocation("goal-1", candidate!.id, 1.5)
      ).rejects.toThrow("allocation must be in [0, 1]");
    });

    it("throws when strategy not found", async () => {
      const mock = createMockLLMClient([]);
      const manager = new StrategyManager(stateManager, mock);

      await expect(async () => await manager.updateAllocation("goal-1", "nonexistent-id", 0.5)
      ).rejects.toThrow("not found");
    });

    it("leaves other strategies untouched when updating allocation in a multi-strategy portfolio", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
      const manager = new StrategyManager(stateManager, mock);
      const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
        currentGap: 0.5,
        pastStrategies: [],
      });

      await manager.activateMultiple("goal-1", candidates.map((c) => c.id));

      const targetId = candidates[0]!.id;
      const otherId = candidates[1]!.id;

      await manager.updateAllocation("goal-1", targetId, 0.3);

      const portfolio = await manager.getPortfolio("goal-1");
      const target = portfolio!.strategies.find((s) => s.id === targetId);
      const other = portfolio!.strategies.find((s) => s.id === otherId);

      expect(target!.allocation).toBe(0.3);
      // other strategy allocation is unchanged
      expect(other!.allocation).toBeCloseTo(0.5, 5);
    });

    it("persists updated allocation across manager instances", async () => {
      const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
      const manager1 = new StrategyManager(stateManager, mock);
      const [candidate] = await manager1.generateCandidates("goal-1", "word_count", ["word_count"], {
        currentGap: 0.7,
        pastStrategies: [],
      });
      await manager1.updateState(candidate!.id, "active");
      await manager1.updateAllocation("goal-1", candidate!.id, 0.55);

      const manager2 = new StrategyManager(stateManager, createMockLLMClient([]));
      const portfolio = await manager2.getPortfolio("goal-1");
      const strategy = portfolio!.strategies.find((s) => s.id === candidate!.id);
      expect(strategy!.allocation).toBe(0.55);
    });
  });
});

// ─── Additional branch coverage ───

describe("activateMultiple — strategy not found in portfolio", () => {
  it("throws when a strategy ID does not exist in the portfolio", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);

    // Portfolio for goal-1 exists (will be created) but "ghost-id" is not in it
    await expect(
      manager.activateMultiple("goal-1", ["ghost-id"])
    ).rejects.toThrow("not found in portfolio");
  });
});

describe("terminateStrategy — strategy not found", () => {
  it("throws when strategy ID does not exist in the portfolio", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    // Create portfolio with one candidate
    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await expect(
      manager.terminateStrategy("goal-1", "nonexistent-id", "reason")
    ).rejects.toThrow("not found in portfolio");
  });
});

describe("resumeStrategy — error paths", () => {
  it("throws when allocation is negative", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);

    await expect(
      manager.resumeStrategy("goal-1", "any-id", -0.1)
    ).rejects.toThrow("allocation must be in [0, 1]");
  });

  it("throws when allocation exceeds 1", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);

    await expect(
      manager.resumeStrategy("goal-1", "any-id", 1.01)
    ).rejects.toThrow("allocation must be in [0, 1]");
  });

  it("throws when strategy ID does not exist in portfolio", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await expect(
      manager.resumeStrategy("goal-1", "nonexistent-id", 0.5)
    ).rejects.toThrow("not found in portfolio");
  });

  it("leaves non-active strategies unchanged when resuming (covers !others.some branch)", async () => {
    // Set up: two candidates, one active, one suspended, plus a third candidate (non-active)
    // The third candidate should be returned unchanged during the strategy map in resumeStrategy
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO, CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const firstBatch = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
      currentGap: 0.5,
      pastStrategies: [],
    });

    // Activate both from firstBatch
    await manager.activateMultiple("goal-1", firstBatch.map((c) => c.id));

    // Generate a third candidate (remains in candidate state — not active/evaluating)
    const secondBatch = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const thirdCandidateId = secondBatch[0]!.id;

    // Suspend first strategy
    await manager.suspendStrategy("goal-1", firstBatch[0]!.id);

    // Resume first strategy — third candidate should pass through unchanged
    const resumed = await manager.resumeStrategy("goal-1", firstBatch[0]!.id, 0.3);
    expect(resumed.state).toBe("active");

    // Verify the third candidate (non-active) is still in candidate state
    const portfolio = await manager.getPortfolio("goal-1");
    const third = portfolio!.strategies.find((s) => s.id === thirdCandidateId);
    expect(third!.state).toBe("candidate");
  });

  it("uses equal split when totalOtherAlloc is zero (no other active strategies)", async () => {
    // Suspend the only active strategy, then resume it — no others exist so totalOtherAlloc = 0
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    await manager.updateState(candidate!.id, "active");
    await manager.suspendStrategy("goal-1", candidate!.id);

    // Resume with allocation 0.6; no other active strategies (totalOtherAlloc = 0)
    const resumed = await manager.resumeStrategy("goal-1", candidate!.id, 0.6);
    expect(resumed.state).toBe("active");
    expect(resumed.allocation).toBe(0.6);
  });

  it("uses equal-split fallback when other active strategies have zero allocation", async () => {
    // Set up two active strategies, force the non-target one to have allocation 0
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
    const manager = new StrategyManager(stateManager, mock);
    const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
      currentGap: 0.5,
      pastStrategies: [],
    });

    await manager.activateMultiple("goal-1", candidates.map((c) => c.id));

    // Force id2's allocation to 0 via updateAllocation
    await manager.updateAllocation("goal-1", candidates[1]!.id, 0);

    // Suspend id1
    await manager.suspendStrategy("goal-1", candidates[0]!.id);

    // Resume id1: others=[id2] with allocation=0 → totalOtherAlloc=0 → uses equal split fallback
    const resumed = await manager.resumeStrategy("goal-1", candidates[0]!.id, 0.4);
    expect(resumed.state).toBe("active");
    expect(resumed.allocation).toBe(0.4);

    const portfolio = await manager.getPortfolio("goal-1");
    const other = portfolio!.strategies.find((s) => s.id === candidates[1]!.id);
    // remaining = 1 - 0.4 = 0.6; split equally among 1 other → 0.6
    expect(other!.allocation).toBeCloseTo(0.6, 5);
  });
});

// ─── getStrategyHistory ───

describe("getStrategyHistory", () => {
  it("returns empty array when no history exists", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);

    expect(await manager.getStrategyHistory("goal-1")).toEqual([]);
  });

  it("includes terminated strategies in history", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "terminated");

    const history = await manager.getStrategyHistory("goal-1");
    expect(history).toHaveLength(1);
    expect(history[0].state).toBe("terminated");
  });

  it("includes completed strategies in history", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "completed");

    const history = await manager.getStrategyHistory("goal-1");
    expect(history).toHaveLength(1);
    expect(history[0].state).toBe("completed");
  });

  it("does not include candidate or active strategies in history", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
      currentGap: 0.5,
      pastStrategies: [],
    });
    await manager.activateBestCandidate("goal-1");

    const history = await manager.getStrategyHistory("goal-1");
    expect(history).toHaveLength(0);
  });

  it("persists history across manager instances", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager1 = new StrategyManager(stateManager, mock);

    const [candidate] = await manager1.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    await manager1.updateState(candidate.id, "active");
    await manager1.updateState(candidate.id, "terminated");

    const manager2 = new StrategyManager(stateManager, createMockLLMClient([]));
    const history = await manager2.getStrategyHistory("goal-1");
    expect(history).toHaveLength(1);
    expect(history[0].state).toBe("terminated");
  });
});
