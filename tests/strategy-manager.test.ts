import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { StateManager } from "../src/state-manager.js";
import { StrategyManager } from "../src/strategy/strategy-manager.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../src/llm/llm-client.js";
import type { Strategy } from "../src/types/strategy.js";
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

// ─── generateCandidates ───

describe("generateCandidates", () => {
  it("returns validated Strategy[] with state=candidate", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    const candidates = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].state).toBe("candidate");
    expect(candidates[0].goal_id).toBe("goal-1");
    expect(candidates[0].primary_dimension).toBe("word_count");
    expect(candidates[0].target_dimensions).toEqual(["word_count"]);
    expect(candidates[0].hypothesis).toContain("writing");
  });

  it("returns 2 candidates when LLM generates 2", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
    const manager = new StrategyManager(stateManager, mock);

    const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth", "word_count"], {
      currentGap: 0.5,
      pastStrategies: [],
    });

    expect(candidates).toHaveLength(2);
    expect(candidates[0].state).toBe("candidate");
    expect(candidates[1].state).toBe("candidate");
  });

  it("stores candidates in portfolio", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    const portfolio = await manager.getPortfolio("goal-1");
    expect(portfolio).not.toBeNull();
    expect(portfolio!.strategies).toHaveLength(1);
    expect(portfolio!.strategies[0].state).toBe("candidate");
  });

  it("assigns unique IDs to each candidate", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
    const manager = new StrategyManager(stateManager, mock);

    const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
      currentGap: 0.5,
      pastStrategies: [],
    });

    expect(candidates[0].id).not.toBe(candidates[1].id);
    expect(typeof candidates[0].id).toBe("string");
  });

  it("sets created_at timestamp as ISO string", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    const before = new Date().toISOString();
    const candidates = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const after = new Date().toISOString();

    expect(candidates[0].created_at >= before).toBe(true);
    expect(candidates[0].created_at <= after).toBe(true);
  });

  it("includes past strategies in the prompt (does not throw)", async () => {
    const pastStrategy: Strategy = {
      id: "old-strategy-1",
      goal_id: "goal-1",
      primary_dimension: "word_count",
      target_dimensions: ["word_count"],
      hypothesis: "Old approach that failed",
      expected_effect: [],
      resource_estimate: { sessions: 5, duration: { value: 7, unit: "days" }, llm_calls: null },
      state: "terminated",
      allocation: 0,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      gap_snapshot_at_start: null,
      tasks_generated: [],
      effectiveness_score: null,
      consecutive_stall_count: 1,
    };

    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await expect(
      manager.generateCandidates("goal-1", "word_count", ["word_count"], {
        currentGap: 0.7,
        pastStrategies: [pastStrategy],
      })
    ).resolves.not.toThrow();
  });
});

// ─── activateBestCandidate ───

describe("activateBestCandidate", () => {
  it("activates first candidate and sets state=active", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
      currentGap: 0.5,
      pastStrategies: [],
    });

    const activated = await manager.activateBestCandidate("goal-1");

    expect(activated.state).toBe("active");
    expect(activated.started_at).not.toBeNull();
    expect(typeof activated.started_at).toBe("string");
  });

  it("persists activated strategy in portfolio", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    await manager.activateBestCandidate("goal-1");

    const portfolio = await manager.getPortfolio("goal-1");
    const active = portfolio!.strategies.find((s) => s.state === "active");
    expect(active).toBeDefined();
    expect(active!.started_at).not.toBeNull();
  });

  it("throws when no candidates exist", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);

    await expect(manager.activateBestCandidate("goal-1")).rejects.toThrow(
      "no candidates found"
    );
  });

  it("selects the first candidate when multiple exist", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
    const manager = new StrategyManager(stateManager, mock);

    const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
      currentGap: 0.5,
      pastStrategies: [],
    });
    const firstCandidateId = candidates[0].id;

    const activated = await manager.activateBestCandidate("goal-1");
    expect(activated.id).toBe(firstCandidateId);
  });

  it("sets started_at as a valid ISO timestamp", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    const before = new Date().toISOString();
    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const activated = await manager.activateBestCandidate("goal-1");
    const after = new Date().toISOString();

    expect(activated.started_at! >= before).toBe(true);
    expect(activated.started_at! <= after).toBe(true);
  });
});

// ─── updateState ───

describe("updateState — valid transitions", () => {
  it("candidate → active succeeds", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await expect(manager.updateState(candidate.id, "active")).resolves.not.toThrow();

    const portfolio = await manager.getPortfolio("goal-1");
    const updated = portfolio!.strategies.find((s) => s.id === candidate.id);
    expect(updated!.state).toBe("active");
  });

  it("active → completed succeeds and sets completed_at", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "completed");

    const portfolio = await manager.getPortfolio("goal-1");
    const updated = portfolio!.strategies.find((s) => s.id === candidate.id);
    expect(updated!.state).toBe("completed");
    expect(updated!.completed_at).not.toBeNull();
  });

  it("active → terminated succeeds and archives to history", async () => {
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
    expect(history[0].id).toBe(candidate.id);
    expect(history[0].state).toBe("terminated");
    expect(history[0].completed_at).not.toBeNull();
  });

  it("active → evaluating succeeds", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "evaluating");

    const portfolio = await manager.getPortfolio("goal-1");
    const updated = portfolio!.strategies.find((s) => s.id === candidate.id);
    expect(updated!.state).toBe("evaluating");
  });

  it("evaluating → active succeeds", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "evaluating");
    await manager.updateState(candidate.id, "active");

    const portfolio = await manager.getPortfolio("goal-1");
    const updated = portfolio!.strategies.find((s) => s.id === candidate.id);
    expect(updated!.state).toBe("active");
  });

  it("evaluating → terminated succeeds and archives", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "evaluating");
    await manager.updateState(candidate.id, "terminated");

    const history = await manager.getStrategyHistory("goal-1");
    expect(history[0].state).toBe("terminated");
  });

  it("updateState stores effectiveness_score from metadata", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "completed", { effectiveness_score: 0.85 });

    const portfolio = await manager.getPortfolio("goal-1");
    const updated = portfolio!.strategies.find((s) => s.id === candidate.id);
    expect(updated!.effectiveness_score).toBe(0.85);
  });
});

describe("updateState — invalid transitions", () => {
  it("candidate → completed throws", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await expect(manager.updateState(candidate.id, "completed")).rejects.toThrow(
      "invalid transition"
    );
  });

  it("completed → active throws", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "completed");

    await expect(manager.updateState(candidate.id, "active")).rejects.toThrow(
      "invalid transition"
    );
  });

  it("terminated → active throws", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "terminated");

    await expect(manager.updateState(candidate.id, "active")).rejects.toThrow(
      "invalid transition"
    );
  });

  it("throws when strategy not found", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);

    await expect(async () => await manager.updateState("non-existent-id", "active")).rejects.toThrow(
      "not found"
    );
  });
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
      expect(async () => await manager.terminateStrategy("goal-1", candidate!.id, "last strategy")
      ).not.toThrow();

      const terminated = manager.terminateStrategy === undefined ? null : await manager.getPortfolio("goal-1");
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
