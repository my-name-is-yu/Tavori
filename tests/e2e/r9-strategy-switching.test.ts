/**
 * R9 E2E verification: strategy switching
 *
 * Tests that PulSeed's StrategyManager correctly evaluates and switches strategies:
 *
 *   R9-1: Low effectiveness triggers strategy switch via onStallDetected
 *   R9-2: onStallDetected returns null when stallCount < 2
 *   R9-3: onStallDetected returns null when LLM cannot generate new candidates
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";

import { StrategyManager } from "../../src/strategy/strategy-manager.js";
import { StateManager } from "../../src/state-manager.js";
import type { ILLMClient } from "../../src/llm/llm-client.js";
import { makeTempDir } from "../helpers/temp-dir.js";

// ─── Helpers ───

function makeMockLLM(responses: string[]): ILLMClient {
  let callIndex = 0;
  return {
    ask: vi.fn().mockImplementation(async () => {
      const resp = responses[callIndex] ?? "[]";
      callIndex++;
      return resp;
    }),
    sendMessage: vi.fn().mockImplementation(async () => {
      const resp = responses[callIndex] ?? "[]";
      callIndex++;
      return { content: resp, usage: { input_tokens: 10, output_tokens: 10 } };
    }),
    parseJSON: vi.fn().mockImplementation((_jsonText: string, _schema: unknown) => {
      try {
        return JSON.parse(_jsonText);
      } catch {
        return JSON.parse(_jsonText.replace(/```json\n?/g, "").replace(/```\n?/g, ""));
      }
    }),
    estimateTokens: vi.fn().mockReturnValue(100),
  } as unknown as ILLMClient;
}

function makeCandidateResponse(descriptions: string[]): string {
  const candidates = descriptions.map((d) => ({
    hypothesis: d,
    expected_effect: [
      { dimension: "quality", direction: "increase", magnitude: "medium" },
    ],
    resource_estimate: {
      sessions: 3,
      duration: { value: 30, unit: "minutes" },
      llm_calls: null,
    },
    allocation: 0,
  }));
  return JSON.stringify(candidates);
}

// ─── Setup ───

let tmpDir: string;
let stateManager: StateManager;

beforeEach(() => {
  tmpDir = makeTempDir();
  stateManager = new StateManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ───

describe("R9: Strategy Switching", () => {
  it("R9-1: onStallDetected with stallCount>=2 terminates active and activates new candidate", async () => {
    const goalId = "goal-r9-1";

    const mockLLM = makeMockLLM([
      makeCandidateResponse(["Initial approach", "Backup approach"]),
      makeCandidateResponse(["Recovery strategy A", "Recovery strategy B"]),
    ]);

    const strategyManager = new StrategyManager(stateManager, mockLLM);

    // Generate initial candidates and activate one
    const candidates = await strategyManager.generateCandidates(
      goalId, "quality", ["quality"],
      { currentGap: 0.6, pastStrategies: [] },
    );
    expect(candidates.length).toBe(2);

    const activated = await strategyManager.activateBestCandidate(goalId);
    expect(activated.state).toBe("active");
    const originalId = activated.id;

    // Trigger stall detection with stallCount=2 (threshold for switch)
    const newStrategy = await strategyManager.onStallDetected(goalId, 2);

    // Should have terminated old strategy and activated a new one
    expect(newStrategy).not.toBeNull();
    expect(newStrategy!.state).toBe("active");
    expect(newStrategy!.id).not.toBe(originalId);

    // Original strategy should be terminated
    const history = await strategyManager.getStrategyHistory(goalId);
    const original = history.find((s) => s.id === originalId);
    expect(original?.state).toBe("terminated");
  });

  it("R9-2: onStallDetected returns null when stallCount < 2", async () => {
    const goalId = "goal-r9-2";
    const mockLLM = makeMockLLM([
      makeCandidateResponse(["Some approach"]),
    ]);

    const strategyManager = new StrategyManager(stateManager, mockLLM);

    await strategyManager.generateCandidates(goalId, "quality", ["quality"], {
      currentGap: 0.5, pastStrategies: [],
    });
    await strategyManager.activateBestCandidate(goalId);

    // stallCount=1 should NOT trigger a switch
    const result = await strategyManager.onStallDetected(goalId, 1);
    expect(result).toBeNull();

    // Active strategy should still be active
    const active = await strategyManager.getActiveStrategy(goalId);
    expect(active).not.toBeNull();
    expect(active!.state).toBe("active");
  });

  it("R9-3: onStallDetected returns null when LLM cannot generate new candidates", async () => {
    const goalId = "goal-r9-3";

    const mockLLM = makeMockLLM([
      makeCandidateResponse(["Only strategy"]),
      "[]",
    ]);

    const strategyManager = new StrategyManager(stateManager, mockLLM);

    await strategyManager.generateCandidates(goalId, "quality", ["quality"], {
      currentGap: 0.7, pastStrategies: [],
    });
    await strategyManager.activateBestCandidate(goalId);

    // Stall detected — but LLM returns no new candidates
    const result = await strategyManager.onStallDetected(goalId, 2);
    expect(result).toBeNull();
  });
});
