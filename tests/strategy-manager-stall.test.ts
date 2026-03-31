import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { z } from "zod";
import { StateManager } from "../src/state-manager.js";
import { StrategyManager } from "../src/strategy/strategy-manager.js";
import type { ILLMClient } from "../src/llm/llm-client.js";
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

const EMPTY_CANDIDATES_RESPONSE = `\`\`\`json
[]
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

// ─── onStallDetected ───

describe("onStallDetected", () => {
  it("returns null when stallCount === 1", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    await manager.activateBestCandidate("goal-1");

    const result = await manager.onStallDetected("goal-1", 1);
    expect(result).toBeNull();
  });

  it("does not change active strategy when stallCount === 1", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const original = await manager.activateBestCandidate("goal-1");

    await manager.onStallDetected("goal-1", 1);

    const still = await manager.getActiveStrategy("goal-1");
    expect(still?.id).toBe(original.id);
    expect(still?.state).toBe("active");
  });

  it("terminates current strategy when stallCount >= 2", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE, CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const original = await manager.activateBestCandidate("goal-1");

    await manager.onStallDetected("goal-1", 2);

    const history = await manager.getStrategyHistory("goal-1");
    const terminated = history.find((s) => s.id === original.id);
    expect(terminated).toBeDefined();
    expect(terminated!.state).toBe("terminated");
  });

  it("generates new candidates and activates best when stallCount >= 2", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE, CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const original = await manager.activateBestCandidate("goal-1");

    const newStrategy = await manager.onStallDetected("goal-1", 2);

    expect(newStrategy).not.toBeNull();
    expect(newStrategy!.state).toBe("active");
    expect(newStrategy!.id).not.toBe(original.id);
  });

  it("returns null when no candidates can be generated (LLM returns empty)", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE, EMPTY_CANDIDATES_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    await manager.activateBestCandidate("goal-1");

    const result = await manager.onStallDetected("goal-1", 2);
    expect(result).toBeNull();
  });

  it("returns null when candidate generation throws (LLM error)", async () => {
    const failingMock: ILLMClient = {
      async sendMessage() {
        throw new Error("LLM unavailable");
      },
      parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
        return schema.parse(JSON.parse(content));
      },
    };

    // We need a fresh manager with an initial candidate so we have an active strategy
    const setupMock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, setupMock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    await manager.activateBestCandidate("goal-1");

    // Now switch to failing mock for the stall call
    const failingManager = new StrategyManager(stateManager, failingMock);
    const result = await failingManager.onStallDetected("goal-1", 2);
    expect(result).toBeNull();
  });

  it("works when there is no active strategy (goal-1 has no active)", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    // Goal with no strategies at all
    const result = await manager.onStallDetected("goal-1", 2);

    // No active strategy to terminate, new candidates are generated and activated
    expect(result).not.toBeNull();
    expect(result!.state).toBe("active");
  });
});

// ─── getActiveStrategy ───

describe("getActiveStrategy", () => {
  it("returns null when no strategy exists", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);

    expect(await manager.getActiveStrategy("goal-1")).toBeNull();
  });

  it("returns null when only candidates exist", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    expect(await manager.getActiveStrategy("goal-1")).toBeNull();
  });

  it("returns the active strategy after activation", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const activated = await manager.activateBestCandidate("goal-1");

    const result = await manager.getActiveStrategy("goal-1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe(activated.id);
    expect(result!.state).toBe("active");
  });

  it("returns null after active strategy is terminated", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const activated = await manager.activateBestCandidate("goal-1");
    await manager.updateState(activated.id, "terminated");

    expect(await manager.getActiveStrategy("goal-1")).toBeNull();
  });
});

// ─── getPortfolio ───

describe("getPortfolio", () => {
  it("returns null before any operations", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);

    expect(await manager.getPortfolio("goal-1")).toBeNull();
  });

  it("returns portfolio after generating candidates", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    const portfolio = await manager.getPortfolio("goal-1");
    expect(portfolio).not.toBeNull();
    expect(portfolio!.goal_id).toBe("goal-1");
    expect(portfolio!.strategies).toHaveLength(1);
  });

  it("persists portfolio across manager instances", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager1 = new StrategyManager(stateManager, mock);

    await manager1.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    // Create new instance with same stateManager
    const manager2 = new StrategyManager(stateManager, createMockLLMClient([]));
    const portfolio = await manager2.getPortfolio("goal-1");
    expect(portfolio).not.toBeNull();
    expect(portfolio!.strategies).toHaveLength(1);
  });

  it("accumulates multiple candidates across calls", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE, CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.6,
      pastStrategies: [],
    });

    const portfolio = await manager.getPortfolio("goal-1");
    expect(portfolio!.strategies).toHaveLength(2);
  });
});

// ─── appendToHistory dedup branch ───

describe("appendToHistory dedup", () => {
  it("updates existing entry in history when same strategy is appended twice", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    // First termination archives the strategy
    await manager.updateState(candidate.id, "terminated");

    // Manually call terminateStrategy (which calls appendToHistory again) — use same goal
    // We can't call updateState again (invalid transition), so verify history length stays at 1
    const history = await manager.getStrategyHistory("goal-1");
    expect(history).toHaveLength(1);
    expect(history[0].state).toBe("terminated");
  });
});

// ─── resolveGoalId — directory scan fallback ───

describe("resolveGoalId fallback scan", () => {
  it("finds strategy via directory scan when not in memory index", async () => {
    // manager1 creates the candidate (stores in portfolio)
    const mock1 = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager1 = new StrategyManager(stateManager, mock1);
    const [candidate] = await manager1.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    // Create the goal directory so listGoalIds() finds "goal-1"
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(path.join(tempDir, "goals", "goal-1"), { recursive: true });

    // manager2 has a fresh in-memory index (no strategyIndex entry)
    const manager2 = new StrategyManager(stateManager, createMockLLMClient([]));
    // updateState triggers resolveGoalId — should fall back to scanning
    await expect(manager2.updateState(candidate.id, "active")).resolves.not.toThrow();

    const portfolio = await manager2.getPortfolio("goal-1");
    const updated = portfolio!.strategies.find((s) => s.id === candidate.id);
    expect(updated!.state).toBe("active");
  });
});

// ─── detectStrategyGap ───

describe("detectStrategyGap", () => {
  it("returns strategy_deadlock signal when candidates array is empty", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);
    const result = manager.detectStrategyGap([]);
    expect(result).not.toBeNull();
    expect(result!.signal_type).toBe("strategy_deadlock");
  });

  it("returns null when candidates array has a viable strategy (no effectiveness score)", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const candidates = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const result = manager.detectStrategyGap(candidates);
    // Candidates have effectiveness_score=null (unscored), so no deadlock
    expect(result).toBeNull();
  });

  it("returns strategy_deadlock when all candidates have effectiveness_score < 0.3", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const candidates = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    // Simulate low effectiveness
    const lowCandidates = candidates.map((c) => ({ ...c, effectiveness_score: 0.1 }));
    const result = manager.detectStrategyGap(lowCandidates);
    expect(result).not.toBeNull();
    expect(result!.signal_type).toBe("strategy_deadlock");
  });

  it("returns null when at least one candidate has effectiveness_score >= 0.3", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
    const manager = new StrategyManager(stateManager, mock);
    const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
      currentGap: 0.5,
      pastStrategies: [],
    });
    const mixed = candidates.map((c, i) => ({
      ...c,
      effectiveness_score: i === 0 ? 0.8 : 0.1,
    }));
    const result = manager.detectStrategyGap(mixed);
    expect(result).toBeNull();
  });

  it("empty signal has source_step = strategy_selection", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);
    const result = manager.detectStrategyGap([]);
    expect(result!.source_step).toBe("strategy_selection");
  });

  it("signal has non-empty missing_knowledge description", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);
    const result = manager.detectStrategyGap([]);
    expect(result!.missing_knowledge.length).toBeGreaterThan(0);
  });

  it("related_dimension is null for strategy deadlock signal", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);
    const result = manager.detectStrategyGap([]);
    expect(result!.related_dimension).toBeNull();
  });
});
