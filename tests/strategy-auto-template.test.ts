import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { StrategyManager } from "../src/strategy/strategy-manager.js";
import type { StrategyTemplateRegistry } from "../src/strategy/strategy-template-registry.js";
import type { Logger } from "../src/runtime/logger.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Fixtures ───

const CANDIDATE_RESPONSE = `\`\`\`json
[
  {
    "hypothesis": "Write 500 words every morning before checking email",
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

// ─── Helpers ───

function makeRegistry(): StrategyTemplateRegistry {
  return {
    registerTemplate: vi.fn().mockResolvedValue({}),
  } as unknown as StrategyTemplateRegistry;
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ─── Tests ───

describe("strategy auto-templating", () => {
  it("calls registerTemplate when strategy completes with effectiveness >= 0.5", async () => {
    const registry = makeRegistry();
    const mock = createMockLLMClient([CANDIDATE_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);
    manager.setStrategyTemplateRegistry(registry);

    const goalId = "goal-auto-template-1";
    const candidates = await manager.generateCandidates(
      goalId,
      "word_count",
      ["word_count"],
      { currentGap: 0.7, pastStrategies: [] }
    );
    const strategyId = candidates[0]!.id;

    await manager.activateBestCandidate(goalId);
    await manager.updateState(strategyId, "completed", { effectiveness_score: 0.8 });

    expect(registry.registerTemplate).toHaveBeenCalledOnce();
    const [strategyArg, goalIdArg] = (registry.registerTemplate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(strategyArg.id).toBe(strategyId);
    expect(strategyArg.state).toBe("completed");
    expect(strategyArg.effectiveness_score).toBe(0.8);
    expect(goalIdArg).toBe(goalId);
  });

  it("calls registerTemplate exactly at the threshold (effectiveness = 0.5)", async () => {
    const registry = makeRegistry();
    const mock = createMockLLMClient([CANDIDATE_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);
    manager.setStrategyTemplateRegistry(registry);

    const goalId = "goal-auto-template-threshold";
    const candidates = await manager.generateCandidates(
      goalId,
      "word_count",
      ["word_count"],
      { currentGap: 0.7, pastStrategies: [] }
    );
    const strategyId = candidates[0]!.id;

    await manager.activateBestCandidate(goalId);
    await manager.updateState(strategyId, "completed", { effectiveness_score: 0.5 });

    expect(registry.registerTemplate).toHaveBeenCalledOnce();
  });

  it("does NOT call registerTemplate when effectiveness < 0.5", async () => {
    const registry = makeRegistry();
    const mock = createMockLLMClient([CANDIDATE_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);
    manager.setStrategyTemplateRegistry(registry);

    const goalId = "goal-auto-template-low";
    const candidates = await manager.generateCandidates(
      goalId,
      "word_count",
      ["word_count"],
      { currentGap: 0.7, pastStrategies: [] }
    );
    const strategyId = candidates[0]!.id;

    await manager.activateBestCandidate(goalId);
    await manager.updateState(strategyId, "completed", { effectiveness_score: 0.3 });

    expect(registry.registerTemplate).not.toHaveBeenCalled();
  });

  it("does NOT call registerTemplate when effectiveness is null", async () => {
    const registry = makeRegistry();
    const mock = createMockLLMClient([CANDIDATE_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);
    manager.setStrategyTemplateRegistry(registry);

    const goalId = "goal-auto-template-null";
    const candidates = await manager.generateCandidates(
      goalId,
      "word_count",
      ["word_count"],
      { currentGap: 0.7, pastStrategies: [] }
    );
    const strategyId = candidates[0]!.id;

    await manager.activateBestCandidate(goalId);
    // No effectiveness_score provided — defaults to null
    await manager.updateState(strategyId, "completed");

    expect(registry.registerTemplate).not.toHaveBeenCalled();
  });

  it("does NOT call registerTemplate when strategy is terminated (not completed)", async () => {
    const registry = makeRegistry();
    const mock = createMockLLMClient([CANDIDATE_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);
    manager.setStrategyTemplateRegistry(registry);

    const goalId = "goal-auto-template-terminated";
    const candidates = await manager.generateCandidates(
      goalId,
      "word_count",
      ["word_count"],
      { currentGap: 0.7, pastStrategies: [] }
    );
    const strategyId = candidates[0]!.id;

    await manager.activateBestCandidate(goalId);
    await manager.updateState(strategyId, "terminated");

    expect(registry.registerTemplate).not.toHaveBeenCalled();
  });

  it("does not throw when no registry is set (graceful skip)", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);
    // No registry set

    const goalId = "goal-auto-template-no-registry";
    const candidates = await manager.generateCandidates(
      goalId,
      "word_count",
      ["word_count"],
      { currentGap: 0.7, pastStrategies: [] }
    );
    const strategyId = candidates[0]!.id;

    await manager.activateBestCandidate(goalId);

    // Should not throw even without a registry
    await expect(
      manager.updateState(strategyId, "completed", { effectiveness_score: 0.9 })
    ).resolves.toBeUndefined();
  });

  it("catches and logs registerTemplate errors without aborting (non-fatal)", async () => {
    const registry = {
      registerTemplate: vi.fn().mockRejectedValue(new Error("storage failure")),
    } as unknown as StrategyTemplateRegistry;
    const logger = makeLogger();
    const mock = createMockLLMClient([CANDIDATE_RESPONSE]);
    // Pass logger through constructor (5th arg)
    const manager = new StrategyManager(stateManager, mock, undefined, undefined, logger);
    manager.setStrategyTemplateRegistry(registry);

    const goalId = "goal-auto-template-error";
    const candidates = await manager.generateCandidates(
      goalId,
      "word_count",
      ["word_count"],
      { currentGap: 0.7, pastStrategies: [] }
    );
    const strategyId = candidates[0]!.id;

    await manager.activateBestCandidate(goalId);

    // Should not throw despite registry failure
    await expect(
      manager.updateState(strategyId, "completed", { effectiveness_score: 0.9 })
    ).resolves.toBeUndefined();
    // Flush microtask queue (multiple ticks) so the fire-and-forget registerTemplate promise settles
    await new Promise((r) => setImmediate(r));

    // Logger.warn should have been called with the error message
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("storage failure")
    );
  });

  it("logs info when template registration succeeds", async () => {
    const registry = makeRegistry();
    const logger = makeLogger();
    const mock = createMockLLMClient([CANDIDATE_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock, undefined, undefined, logger);
    manager.setStrategyTemplateRegistry(registry);

    const goalId = "goal-auto-template-log";
    const candidates = await manager.generateCandidates(
      goalId,
      "word_count",
      ["word_count"],
      { currentGap: 0.7, pastStrategies: [] }
    );
    const strategyId = candidates[0]!.id;

    await manager.activateBestCandidate(goalId);
    await manager.updateState(strategyId, "completed", { effectiveness_score: 0.75 });
    // Flush microtask queue (multiple ticks) so the fire-and-forget registerTemplate promise settles
    await new Promise((r) => setImmediate(r));

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Auto-templated strategy")
    );
  });
});
