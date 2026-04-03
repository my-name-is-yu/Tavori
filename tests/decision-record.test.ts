import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state/state-manager.js";
import { KnowledgeManager } from "../src/knowledge/knowledge-manager.js";
import type { DecisionRecord } from "../src/types/knowledge.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { randomUUID } from "node:crypto";

// ─── Helpers ───

function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `pulseed-decision-record-test-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeDecisionRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: randomUUID(),
    goal_id: "goal-1",
    goal_type: "coding",
    strategy_id: "strategy-1",
    decision: "pivot",
    context: {
      gap_value: 0.5,
      stall_count: 2,
      cycle_count: 5,
      trust_score: 10,
    },
    outcome: "pending",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;
let manager: KnowledgeManager;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════
// recordDecision + queryDecisions
// ═══════════════════════════════════════════════════════

describe("recordDecision and queryDecisions", () => {
  it("saves a decision and queryDecisions retrieves it", async () => {
    const record = makeDecisionRecord({ goal_type: "coding" });
    await manager.recordDecision(record);

    const results = await manager.queryDecisions("coding");
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(record.id);
    expect(results[0]!.goal_type).toBe("coding");
    expect(results[0]!.decision).toBe("pivot");
  });

  it("queryDecisions filters by goal_type", async () => {
    const codingRecord = makeDecisionRecord({
      goal_type: "coding",
      goal_id: "goal-coding",
      timestamp: new Date(Date.now() - 1000).toISOString(),
    });
    const researchRecord = makeDecisionRecord({
      goal_type: "research",
      goal_id: "goal-research",
      timestamp: new Date().toISOString(),
    });
    await manager.recordDecision(codingRecord);
    await manager.recordDecision(researchRecord);

    const codingResults = await manager.queryDecisions("coding");
    expect(codingResults).toHaveLength(1);
    expect(codingResults[0]!.goal_type).toBe("coding");

    const researchResults = await manager.queryDecisions("research");
    expect(researchResults).toHaveLength(1);
    expect(researchResults[0]!.goal_type).toBe("research");
  });

  it("returns empty array when no records exist", async () => {
    const results = await manager.queryDecisions("nonexistent-type");
    expect(results).toEqual([]);
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await manager.recordDecision(
        makeDecisionRecord({
          goal_type: "coding",
          goal_id: `goal-limit-${i}`,
          timestamp: new Date(Date.now() - i * 1000).toISOString(),
        })
      );
    }
    const results = await manager.queryDecisions("coding", 3);
    expect(results).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════
// Time-decay weighting
// ═══════════════════════════════════════════════════════

describe("time-decay ordering", () => {
  it("returns recent records before older records", async () => {
    const oldTimestamp = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString();
    const recentTimestamp = new Date().toISOString();

    const oldRecord = makeDecisionRecord({
      goal_type: "coding",
      id: "old",
      timestamp: oldTimestamp,
    });
    const recentRecord = makeDecisionRecord({
      goal_type: "coding",
      id: "recent",
      timestamp: recentTimestamp,
    });

    // Insert old first, then recent
    await manager.recordDecision(oldRecord);
    await manager.recordDecision(recentRecord);

    const results = await manager.queryDecisions("coding");
    expect(results).toHaveLength(2);
    // Recent record should appear first (higher decay weight)
    expect(results[0]!.id).toBe("recent");
    expect(results[1]!.id).toBe("old");
  });
});

// ═══════════════════════════════════════════════════════
// purgeOldDecisions
// ═══════════════════════════════════════════════════════

describe("purgeOldDecisions", () => {
  it("removes records older than 90 days", async () => {
    const oldTimestamp = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    const recentTimestamp = new Date().toISOString();

    await manager.recordDecision(
      makeDecisionRecord({ goal_type: "coding", id: "old-record", timestamp: oldTimestamp })
    );
    await manager.recordDecision(
      makeDecisionRecord({ goal_type: "coding", id: "recent-record", timestamp: recentTimestamp })
    );

    const purged = await manager.purgeOldDecisions();
    expect(purged).toBe(1);

    const remaining = await manager.queryDecisions("coding");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe("recent-record");
  });

  it("returns 0 when no records exist", async () => {
    const purged = await manager.purgeOldDecisions();
    expect(purged).toBe(0);
  });
});
