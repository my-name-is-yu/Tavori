import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { StateManager } from "../src/state-manager.js";
import { StrategyManager } from "../src/strategy-manager.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../src/llm-client.js";
import type { Strategy } from "../src/types/strategy.js";

// ─── Mock LLM Client ───

function createMockLLMClient(responses: string[]): ILLMClient {
  let callIndex = 0;
  return {
    async sendMessage(
      _messages: LLMMessage[],
      _options?: LLMRequestOptions
    ): Promise<LLMResponse> {
      return {
        content: responses[callIndex++] ?? "",
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      const match = content.match(/```json\n?([\s\S]*?)\n?```/) || [null, content];
      return schema.parse(JSON.parse(match[1] ?? content));
    },
  };
}

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

function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `motiva-strategy-test-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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

    const portfolio = manager.getPortfolio("goal-1");
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

    const portfolio = manager.getPortfolio("goal-1");
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

    expect(() => manager.updateState(candidate.id, "active")).not.toThrow();

    const portfolio = manager.getPortfolio("goal-1");
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

    manager.updateState(candidate.id, "active");
    manager.updateState(candidate.id, "completed");

    const portfolio = manager.getPortfolio("goal-1");
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

    manager.updateState(candidate.id, "active");
    manager.updateState(candidate.id, "terminated");

    const history = manager.getStrategyHistory("goal-1");
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

    manager.updateState(candidate.id, "active");
    manager.updateState(candidate.id, "evaluating");

    const portfolio = manager.getPortfolio("goal-1");
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

    manager.updateState(candidate.id, "active");
    manager.updateState(candidate.id, "evaluating");
    manager.updateState(candidate.id, "active");

    const portfolio = manager.getPortfolio("goal-1");
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

    manager.updateState(candidate.id, "active");
    manager.updateState(candidate.id, "evaluating");
    manager.updateState(candidate.id, "terminated");

    const history = manager.getStrategyHistory("goal-1");
    expect(history[0].state).toBe("terminated");
  });

  it("updateState stores effectiveness_score from metadata", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    manager.updateState(candidate.id, "active");
    manager.updateState(candidate.id, "completed", { effectiveness_score: 0.85 });

    const portfolio = manager.getPortfolio("goal-1");
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

    expect(() => manager.updateState(candidate.id, "completed")).toThrow(
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

    manager.updateState(candidate.id, "active");
    manager.updateState(candidate.id, "completed");

    expect(() => manager.updateState(candidate.id, "active")).toThrow(
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

    manager.updateState(candidate.id, "active");
    manager.updateState(candidate.id, "terminated");

    expect(() => manager.updateState(candidate.id, "active")).toThrow(
      "invalid transition"
    );
  });

  it("throws when strategy not found", () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);

    expect(() => manager.updateState("non-existent-id", "active")).toThrow(
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

    const still = manager.getActiveStrategy("goal-1");
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

    const history = manager.getStrategyHistory("goal-1");
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
  it("returns null when no strategy exists", () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);

    expect(manager.getActiveStrategy("goal-1")).toBeNull();
  });

  it("returns null when only candidates exist", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    expect(manager.getActiveStrategy("goal-1")).toBeNull();
  });

  it("returns the active strategy after activation", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const activated = await manager.activateBestCandidate("goal-1");

    const result = manager.getActiveStrategy("goal-1");
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
    manager.updateState(activated.id, "terminated");

    expect(manager.getActiveStrategy("goal-1")).toBeNull();
  });
});

// ─── getPortfolio ───

describe("getPortfolio", () => {
  it("returns null before any operations", () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);

    expect(manager.getPortfolio("goal-1")).toBeNull();
  });

  it("returns portfolio after generating candidates", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    const portfolio = manager.getPortfolio("goal-1");
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
    const portfolio = manager2.getPortfolio("goal-1");
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

    const portfolio = manager.getPortfolio("goal-1");
    expect(portfolio!.strategies).toHaveLength(2);
  });
});

// ─── detectStrategyGap ───

describe("detectStrategyGap", () => {
  it("returns strategy_deadlock signal when candidates array is empty", () => {
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

  it("empty signal has source_step = strategy_selection", () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);
    const result = manager.detectStrategyGap([]);
    expect(result!.source_step).toBe("strategy_selection");
  });

  it("signal has non-empty missing_knowledge description", () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);
    const result = manager.detectStrategyGap([]);
    expect(result!.missing_knowledge.length).toBeGreaterThan(0);
  });

  it("related_dimension is null for strategy deadlock signal", () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);
    const result = manager.detectStrategyGap([]);
    expect(result!.related_dimension).toBeNull();
  });
});

// ─── getStrategyHistory ───

describe("getStrategyHistory", () => {
  it("returns empty array when no history exists", () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);

    expect(manager.getStrategyHistory("goal-1")).toEqual([]);
  });

  it("includes terminated strategies in history", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    manager.updateState(candidate.id, "active");
    manager.updateState(candidate.id, "terminated");

    const history = manager.getStrategyHistory("goal-1");
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

    manager.updateState(candidate.id, "active");
    manager.updateState(candidate.id, "completed");

    const history = manager.getStrategyHistory("goal-1");
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

    const history = manager.getStrategyHistory("goal-1");
    expect(history).toHaveLength(0);
  });

  it("persists history across manager instances", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager1 = new StrategyManager(stateManager, mock);

    const [candidate] = await manager1.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    manager1.updateState(candidate.id, "active");
    manager1.updateState(candidate.id, "terminated");

    const manager2 = new StrategyManager(stateManager, createMockLLMClient([]));
    const history = manager2.getStrategyHistory("goal-1");
    expect(history).toHaveLength(1);
    expect(history[0].state).toBe("terminated");
  });
});
