import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { z } from "zod";
import { StateManager } from "../src/state/state-manager.js";
import { StrategyManager } from "../src/strategy/strategy-manager.js";
import type { ILLMClient } from "../src/llm/llm-client.js";
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
