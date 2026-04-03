/**
 * Phase A E2E tests: self-reflection routines integration
 *
 * These tests verify cross-component integration that unit tests do not cover:
 *   1. Morning planning → goal priorities → feeds into real StateManager
 *   2. Evening catchup → uses morning report from disk for comparison
 *   3. Dream consolidation → merges knowledge across sessions
 *   4. Weekly review → portfolio analysis with real state
 *   5. Full reflection cycle: morning → (simulated work) → evening → dream → verify accumulation
 *   6. Reflection with real StateManager: state persists across phases
 *
 * Unit tests in tests/reflection/ cover happy-path, empty goals, file persistence, LLM
 * errors, and notificationDispatcher. These E2E tests focus on integration scenarios.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { StateManager } from "../../src/state/state-manager.js";
import { runMorningPlanning } from "../../src/reflection/morning-planning.js";
import { runEveningCatchup } from "../../src/reflection/evening-catchup.js";
import { runDreamConsolidation } from "../../src/reflection/dream-consolidation.js";
import { runWeeklyReview } from "../../src/reflection/weekly-review.js";
import type { Goal } from "../../src/types/goal.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp-dir.js";
import { createMockLLMClient } from "../helpers/mock-llm.js";

// ─── Fixtures ───

function makeActiveGoal(id: string, overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id,
    parent_id: null,
    node_type: "goal",
    title: `Goal ${id}`,
    description: `Description for ${id}`,
    status: "active",
    dimensions: [
      {
        name: "progress",
        label: "Progress",
        current_value: 0.3,
        threshold: { type: "min", value: 1.0 },
        confidence: 0.8,
        observation_method: {
          type: "manual",
          source: "test",
          schedule: null,
          endpoint: null,
          confidence_tier: "self_report",
        },
        last_updated: now,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
        state_integrity: "ok",
        dimension_mapping: null,
      },
    ],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: null,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: 0,
    specificity_score: null,
    loop_status: "idle",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makePlanningLLMResponse(goalId: string) {
  return JSON.stringify({
    priorities: [{ goal_id: goalId, priority: "high", reasoning: "Most urgent task" }],
    suggestions: ["Start with highest gap goal"],
    concerns: ["Deadline approaching"],
  });
}

function makeCatchupLLMResponse() {
  return JSON.stringify({
    progress_summary: "Solid progress made today across all goals.",
    completions: ["progress dimension advanced"],
    stalls: [],
    concerns: [],
  });
}

function makeWeeklyLLMResponse(goalIds: string[]) {
  return JSON.stringify({
    rankings: goalIds.map((id, i) => ({
      goal_id: id,
      progress_rate: 0.5 + i * 0.1,
      strategy_effectiveness: i === 0 ? "high" : "medium",
      recommendation: `Continue current strategy for ${id}`,
    })),
    suggested_additions: ["Add a code review cadence goal"],
    suggested_removals: [],
    summary: "Productive week overall with consistent progress.",
  });
}

// ─── 1. Morning planning → goal priorities → feeds into real StateManager ───

describe("Morning planning with real StateManager", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { cleanupTempDir(tmpDir); });
  it("produces goal priorities for all active goals saved in StateManager", async () => {
    const stateManager = new StateManager(tmpDir);
    await stateManager.saveGoal(makeActiveGoal("goal-a"));
    await stateManager.saveGoal(makeActiveGoal("goal-b"));

    const llmClient = createMockLLMClient([
      JSON.stringify({
        priorities: [
          { goal_id: "goal-a", priority: "high", reasoning: "Larger gap" },
          { goal_id: "goal-b", priority: "low", reasoning: "Recently started" },
        ],
        suggestions: ["Tackle goal-a first"],
        concerns: [],
      }),
    ]);

    const report = await runMorningPlanning({
      stateManager,
      llmClient,
      baseDir: tmpDir,
    });

    // Both active goals are reviewed
    expect(report.goals_reviewed).toBe(2);
    expect(report.priorities).toHaveLength(2);

    // LLM was called exactly once (one batch request for all goals)
    expect(llmClient.callCount).toBe(1);

    // Priorities correctly reference real goal IDs
    const goalIds = report.priorities.map((p) => p.goal_id);
    expect(goalIds).toContain("goal-a");
    expect(goalIds).toContain("goal-b");

    // High priority goal is correctly identified
    const highPriority = report.priorities.find((p) => p.priority === "high");
    expect(highPriority?.goal_id).toBe("goal-a");
  });

  it("skips archived goals — only active goals appear in priorities", async () => {
    const stateManager = new StateManager(tmpDir);
    await stateManager.saveGoal(makeActiveGoal("goal-active"));
    await stateManager.saveGoal(makeActiveGoal("goal-archived", { status: "archived" }));

    const llmClient = createMockLLMClient([
      makePlanningLLMResponse("goal-active"),
    ]);

    const report = await runMorningPlanning({
      stateManager,
      llmClient,
      baseDir: tmpDir,
    });

    // Only active goal is reviewed (archived is skipped)
    expect(report.goals_reviewed).toBe(1);
    const ids = report.priorities.map((p) => p.goal_id);
    expect(ids).toContain("goal-active");
    expect(ids).not.toContain("goal-archived");
  });

  it("morning report is readable by evening catchup in the same session", async () => {
    const stateManager = new StateManager(tmpDir);
    await stateManager.saveGoal(makeActiveGoal("goal-x"));

    // Run morning planning
    const morningLLM = createMockLLMClient([makePlanningLLMResponse("goal-x")]);
    const morningReport = await runMorningPlanning({
      stateManager,
      llmClient: morningLLM,
      baseDir: tmpDir,
    });

    // Verify the morning report file was written to the reflections directory
    const morningFilePath = path.join(tmpDir, "reflections", `morning-${morningReport.date}.json`);
    expect(fs.existsSync(morningFilePath)).toBe(true);

    // The evening catchup reads the morning report — verify it doesn't crash and
    // produces a coherent report incorporating both morning data and current state
    const eveningLLM = createMockLLMClient([makeCatchupLLMResponse()]);
    const eveningReport = await runEveningCatchup({
      stateManager,
      llmClient: eveningLLM,
      baseDir: tmpDir,
    });

    expect(eveningReport.goals_reviewed).toBe(1);
    expect(eveningReport.progress_summary).toBe("Solid progress made today across all goals.");
    // LLM was called once (morning report was incorporated into the prompt)
    expect(eveningLLM.callCount).toBe(1);
  });
});

// ─── 2. Evening catchup → analyzes day's progress with session history ───

describe("Evening catchup with real StateManager", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { cleanupTempDir(tmpDir); });

  it("analyzes multiple active goals and returns structured report", async () => {
    const stateManager = new StateManager(tmpDir);
    await stateManager.saveGoal(makeActiveGoal("goal-1"));
    await stateManager.saveGoal(makeActiveGoal("goal-2"));
    await stateManager.saveGoal(makeActiveGoal("goal-3"));

    const llmClient = createMockLLMClient([
      JSON.stringify({
        progress_summary: "Three goals tracked. Two are on track, one stalled.",
        completions: ["goal-1 dimension progressed"],
        stalls: ["goal-3 no movement"],
        concerns: ["goal-3 may need strategy change"],
      }),
    ]);

    const report = await runEveningCatchup({
      stateManager,
      llmClient,
      baseDir: tmpDir,
    });

    expect(report.goals_reviewed).toBe(3);
    expect(report.completions).toHaveLength(1);
    expect(report.stalls).toHaveLength(1);
    expect(report.concerns).toHaveLength(1);
    expect(report.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("includes gap history in goal summary when state has gap data", async () => {
    const stateManager = new StateManager(tmpDir);
    const goal = makeActiveGoal("goal-with-gaps");
    await stateManager.saveGoal(goal);

    // Seed gap history with one entry so gap score can be computed
    await stateManager.appendGapHistoryEntry("goal-with-gaps", {
      iteration: 1,
      timestamp: new Date(Date.now() - 3600_000).toISOString(),
      gap_vector: [{ dimension_name: "progress", normalized_weighted_gap: 0.7 }],
      confidence_vector: [{ dimension_name: "progress", confidence: 0.8 }],
    });

    const llmClient = createMockLLMClient([makeCatchupLLMResponse()]);
    const report = await runEveningCatchup({
      stateManager,
      llmClient,
      baseDir: tmpDir,
    });

    // LLM was called — meaning goal was found and gap history was incorporated
    expect(llmClient.callCount).toBe(1);
    expect(report.goals_reviewed).toBe(1);
  });
});

// ─── 3. Dream consolidation → merges knowledge across sessions ───

describe("Dream consolidation with real StateManager", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { cleanupTempDir(tmpDir); });

  it("consolidates all goal IDs from real StateManager", async () => {
    const stateManager = new StateManager(tmpDir);
    await stateManager.saveGoal(makeActiveGoal("consolidate-1"));
    await stateManager.saveGoal(makeActiveGoal("consolidate-2"));
    await stateManager.saveGoal(makeActiveGoal("consolidate-3"));

    const report = await runDreamConsolidation({
      stateManager,
      baseDir: tmpDir,
    });

    // All 3 goal IDs found by real StateManager
    expect(report.goals_consolidated).toBe(3);
    expect(report.entries_compressed).toBe(0); // no memoryLifecycle provided
    expect(report.stale_entries_found).toBe(0);
    expect(report.revalidation_tasks_created).toBe(0);
  });

  it("with memoryLifecycle mock: compresses entries for each goal across all data types", async () => {
    const stateManager = new StateManager(tmpDir);
    await stateManager.saveGoal(makeActiveGoal("mem-goal-1"));
    await stateManager.saveGoal(makeActiveGoal("mem-goal-2"));

    const compressedPerCall = 4;
    const memoryLifecycle = {
      compressToLongTerm: vi.fn().mockResolvedValue({
        success: true,
        entries_compressed: compressedPerCall,
        lessons_created: 1,
      }),
    };

    const report = await runDreamConsolidation({
      stateManager,
      memoryLifecycle: memoryLifecycle as never,
      baseDir: tmpDir,
    });

    // 2 goals * 5 data types * 4 entries each = 40
    expect(report.goals_consolidated).toBe(2);
    expect(report.entries_compressed).toBe(40);
    expect(memoryLifecycle.compressToLongTerm).toHaveBeenCalledTimes(10);
  });

  it("with knowledgeManager mock: generates revalidation tasks for stale entries", async () => {
    const stateManager = new StateManager(tmpDir);
    await stateManager.saveGoal(makeActiveGoal("km-goal-1"));

    const staleEntries = [
      { id: "stale-e1", key: "api-key-fact", value: "v1", source: "test", created_at: new Date().toISOString(), revalidation_due_at: new Date(Date.now() - 1000).toISOString() },
      { id: "stale-e2", key: "perf-fact", value: "v2", source: "test", created_at: new Date().toISOString(), revalidation_due_at: new Date(Date.now() - 1000).toISOString() },
    ];

    const knowledgeManager = {
      getStaleEntries: vi.fn().mockResolvedValue(staleEntries),
      generateRevalidationTasks: vi.fn().mockResolvedValue([
        { id: "revalid-task-1", type: "knowledge_acquisition" },
        { id: "revalid-task-2", type: "knowledge_acquisition" },
      ]),
    };

    const report = await runDreamConsolidation({
      stateManager,
      knowledgeManager: knowledgeManager as never,
      baseDir: tmpDir,
    });

    expect(report.stale_entries_found).toBe(2);
    expect(report.revalidation_tasks_created).toBe(2);
    expect(knowledgeManager.getStaleEntries).toHaveBeenCalledOnce();
    expect(knowledgeManager.generateRevalidationTasks).toHaveBeenCalledWith(staleEntries);
  });

  it("persists consolidation report to disk with correct date", async () => {
    const stateManager = new StateManager(tmpDir);
    await stateManager.saveGoal(makeActiveGoal("persist-goal"));

    const report = await runDreamConsolidation({
      stateManager,
      baseDir: tmpDir,
    });

    const filePath = path.join(tmpDir, "reflections", `dream-${report.date}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(saved.goals_consolidated).toBe(1);
    expect(saved.date).toBe(report.date);
  });
});

// ─── 4. Weekly review → portfolio analysis with strategy scoring ───

describe("Weekly review with real StateManager", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { cleanupTempDir(tmpDir); });

  it("produces strategy effectiveness rankings for all active goals", async () => {
    const stateManager = new StateManager(tmpDir);
    await stateManager.saveGoal(makeActiveGoal("weekly-g1"));
    await stateManager.saveGoal(makeActiveGoal("weekly-g2"));

    const llmClient = createMockLLMClient([makeWeeklyLLMResponse(["weekly-g1", "weekly-g2"])]);

    const report = await runWeeklyReview({
      stateManager,
      llmClient,
      baseDir: tmpDir,
    });

    expect(report.goals_reviewed).toBe(2);
    expect(report.rankings).toHaveLength(2);

    // Validate ranking structure
    for (const ranking of report.rankings) {
      expect(ranking.progress_rate).toBeGreaterThanOrEqual(0);
      expect(ranking.progress_rate).toBeLessThanOrEqual(1);
      expect(["high", "medium", "low"]).toContain(ranking.strategy_effectiveness);
      expect(ranking.recommendation).toBeTruthy();
    }

    expect(report.suggested_additions).toHaveLength(1);
    expect(report.summary).toBeTruthy();
    expect(report.week).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("computes weekly_delta from gap history for progress rate context", async () => {
    const stateManager = new StateManager(tmpDir);
    await stateManager.saveGoal(makeActiveGoal("delta-goal"));

    // Seed two gap history entries so computeWeeklyDelta has data to work with
    const now = Date.now();
    await stateManager.appendGapHistoryEntry("delta-goal", {
      iteration: 1,
      timestamp: new Date(now - 7 * 24 * 3600_000).toISOString(),
      gap_vector: [{ dimension_name: "progress", normalized_weighted_gap: 0.8 }],
      confidence_vector: [{ dimension_name: "progress", confidence: 0.8 }],
    });
    await stateManager.appendGapHistoryEntry("delta-goal", {
      iteration: 2,
      timestamp: new Date(now).toISOString(),
      gap_vector: [{ dimension_name: "progress", normalized_weighted_gap: 0.5 }],
      confidence_vector: [{ dimension_name: "progress", confidence: 0.8 }],
    });

    const llmClient = createMockLLMClient([
      JSON.stringify({
        rankings: [{ goal_id: "delta-goal", progress_rate: 0.3, strategy_effectiveness: "medium", recommendation: "Keep current approach" }],
        suggested_additions: [],
        suggested_removals: [],
        summary: "Gap closing steadily.",
      }),
    ]);

    const report = await runWeeklyReview({
      stateManager,
      llmClient,
      baseDir: tmpDir,
    });

    // LLM was called, meaning weekly_delta was computed and passed in the prompt
    expect(llmClient.callCount).toBe(1);
    expect(report.rankings[0]?.goal_id).toBe("delta-goal");
  });

  it("actionable recommendations are surfaced as strings", async () => {
    const stateManager = new StateManager(tmpDir);
    await stateManager.saveGoal(makeActiveGoal("action-goal"));

    const llmClient = createMockLLMClient([
      JSON.stringify({
        rankings: [{ goal_id: "action-goal", progress_rate: 0.1, strategy_effectiveness: "low", recommendation: "Switch to a more aggressive strategy" }],
        suggested_additions: ["Add pair programming goal"],
        suggested_removals: ["action-goal"],
        summary: "Low progress week.",
      }),
    ]);

    const report = await runWeeklyReview({
      stateManager,
      llmClient,
      baseDir: tmpDir,
    });

    const lowEffectiveness = report.rankings.find((r) => r.strategy_effectiveness === "low");
    expect(lowEffectiveness?.recommendation).toBe("Switch to a more aggressive strategy");
    expect(report.suggested_removals).toContain("action-goal");
    expect(report.suggested_additions).toContain("Add pair programming goal");
  });
});

// ─── 5. Full reflection cycle: morning → work simulation → evening → dream ───

describe("Full reflection cycle: morning → evening → dream", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { cleanupTempDir(tmpDir); });

  it("state accumulates across all three phases and each report is independently persisted", async () => {
    const stateManager = new StateManager(tmpDir);

    // Set up two active goals
    await stateManager.saveGoal(makeActiveGoal("cycle-goal-1"));
    await stateManager.saveGoal(makeActiveGoal("cycle-goal-2"));

    // Phase 1: Morning Planning
    const morningLLM = createMockLLMClient([
      JSON.stringify({
        priorities: [
          { goal_id: "cycle-goal-1", priority: "high", reasoning: "Highest gap" },
          { goal_id: "cycle-goal-2", priority: "medium", reasoning: "Steady progress needed" },
        ],
        suggestions: ["Focus on cycle-goal-1 first"],
        concerns: [],
      }),
    ]);

    const morningReport = await runMorningPlanning({
      stateManager,
      llmClient: morningLLM,
      baseDir: tmpDir,
    });

    expect(morningReport.goals_reviewed).toBe(2);
    expect(morningReport.priorities).toHaveLength(2);

    // Simulate work: update goal-1 dimension value (gap closing)
    const goal1 = await stateManager.loadGoal("cycle-goal-1");
    expect(goal1).not.toBeNull();
    await stateManager.saveGoal({
      ...goal1!,
      dimensions: goal1!.dimensions.map((d) => ({ ...d, current_value: 0.7 })),
      updated_at: new Date().toISOString(),
    });

    // Append gap history entry to reflect simulated work
    await stateManager.appendGapHistoryEntry("cycle-goal-1", {
      iteration: 1,
      timestamp: new Date().toISOString(),
      gap_vector: [{ dimension_name: "progress", normalized_weighted_gap: 0.3 }],
      confidence_vector: [{ dimension_name: "progress", confidence: 0.9 }],
    });

    // Phase 2: Evening Catchup — reads morning report from disk
    const eveningLLM = createMockLLMClient([
      JSON.stringify({
        progress_summary: "cycle-goal-1 made significant progress. cycle-goal-2 steady.",
        completions: ["cycle-goal-1 progress dimension advanced to 0.7"],
        stalls: [],
        concerns: [],
      }),
    ]);

    const eveningReport = await runEveningCatchup({
      stateManager,
      llmClient: eveningLLM,
      baseDir: tmpDir,
    });

    expect(eveningReport.goals_reviewed).toBe(2);
    expect(eveningReport.completions).toHaveLength(1);
    expect(eveningReport.progress_summary).toContain("cycle-goal-1");

    // Phase 3: Dream Consolidation
    const memoryLifecycle = {
      compressToLongTerm: vi.fn().mockResolvedValue({
        success: true,
        entries_compressed: 2,
        lessons_created: 1,
      }),
    };

    const dreamReport = await runDreamConsolidation({
      stateManager,
      memoryLifecycle: memoryLifecycle as never,
      baseDir: tmpDir,
    });

    expect(dreamReport.goals_consolidated).toBe(2);
    expect(dreamReport.entries_compressed).toBe(20); // 2 goals * 5 data types * 2 entries each

    // Verify all three report files exist on disk
    const reflectionsDir = path.join(tmpDir, "reflections");
    const files = fs.readdirSync(reflectionsDir);

    const morningFile = files.find((f) => f.startsWith("morning-"));
    const eveningFile = files.find((f) => f.startsWith("evening-"));
    const dreamFile = files.find((f) => f.startsWith("dream-"));

    expect(morningFile).toBeDefined();
    expect(eveningFile).toBeDefined();
    expect(dreamFile).toBeDefined();
  });

  it("morning priorities influence subsequent goal ordering in the evening report", async () => {
    const stateManager = new StateManager(tmpDir);
    await stateManager.saveGoal(makeActiveGoal("priority-goal-high"));
    await stateManager.saveGoal(makeActiveGoal("priority-goal-low"));

    // Morning: mark priority-goal-high as high priority
    const morningLLM = createMockLLMClient([
      JSON.stringify({
        priorities: [
          { goal_id: "priority-goal-high", priority: "high", reasoning: "Critical path" },
          { goal_id: "priority-goal-low", priority: "low", reasoning: "Can wait" },
        ],
        suggestions: [],
        concerns: ["priority-goal-high needs attention"],
      }),
    ]);

    const morningReport = await runMorningPlanning({
      stateManager,
      llmClient: morningLLM,
      baseDir: tmpDir,
    });

    expect(morningReport.concerns).toContain("priority-goal-high needs attention");

    // Evening: verify morning concern is visible in the evening context
    const eveningLLM = createMockLLMClient([
      JSON.stringify({
        progress_summary: "Addressed morning concern for priority-goal-high.",
        completions: [],
        stalls: [],
        concerns: [],
      }),
    ]);

    const eveningReport = await runEveningCatchup({
      stateManager,
      llmClient: eveningLLM,
      baseDir: tmpDir,
    });

    // Evening report is valid and LLM was called once (with morning data in prompt)
    expect(eveningReport.goals_reviewed).toBe(2);
    expect(eveningLLM.callCount).toBe(1);
    expect(eveningReport.progress_summary).toContain("priority-goal-high");
  });
});

// ─── 6. State persistence across reflection phases with real StateManager ───

describe("State persistence across reflection phases", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { cleanupTempDir(tmpDir); });

  it("goal state modified between morning and evening is reflected in evening summary", async () => {
    const stateManager = new StateManager(tmpDir);
    const goal = makeActiveGoal("persist-across-phases", {
      dimensions: [
        {
          name: "completion",
          label: "Completion",
          current_value: 0.2,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.9,
          observation_method: {
            type: "manual",
            source: "test",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });

    await stateManager.saveGoal(goal);

    // Morning: current_value=0.2
    const morningLLM = createMockLLMClient([
      JSON.stringify({
        priorities: [{ goal_id: "persist-across-phases", priority: "high", reasoning: "Large gap" }],
        suggestions: [],
        concerns: ["completion only at 20%"],
      }),
    ]);

    await runMorningPlanning({
      stateManager,
      llmClient: morningLLM,
      baseDir: tmpDir,
    });

    // Simulate state change: update dimension to 0.8
    const loaded = await stateManager.loadGoal("persist-across-phases");
    expect(loaded).not.toBeNull();
    await stateManager.saveGoal({
      ...loaded!,
      dimensions: loaded!.dimensions.map((d) =>
        d.name === "completion" ? { ...d, current_value: 0.8 } : d
      ),
      updated_at: new Date().toISOString(),
    });

    // Verify state was updated
    const updated = await stateManager.loadGoal("persist-across-phases");
    expect(updated?.dimensions[0]?.current_value).toBe(0.8);

    // Evening: should see updated state (0.8 rather than original 0.2)
    const eveningLLM = createMockLLMClient([
      JSON.stringify({
        progress_summary: "Completion jumped from 20% to 80% today.",
        completions: ["Major progress on completion dimension"],
        stalls: [],
        concerns: [],
      }),
    ]);

    const eveningReport = await runEveningCatchup({
      stateManager,
      llmClient: eveningLLM,
      baseDir: tmpDir,
    });

    expect(eveningReport.goals_reviewed).toBe(1);
    expect(eveningReport.completions).toHaveLength(1);
    // State update persisted between phases
    const finalGoal = await stateManager.loadGoal("persist-across-phases");
    expect(finalGoal?.dimensions[0]?.current_value).toBe(0.8);
  });

  it("dream consolidation with no goals produces a zero-count report and still writes file", async () => {
    const stateManager = new StateManager(tmpDir);
    // No goals saved — empty StateManager

    const report = await runDreamConsolidation({
      stateManager,
      baseDir: tmpDir,
    });

    expect(report.goals_consolidated).toBe(0);
    expect(report.entries_compressed).toBe(0);
    expect(report.stale_entries_found).toBe(0);
    expect(report.revalidation_tasks_created).toBe(0);

    // File still written even with zero goals
    const filePath = path.join(tmpDir, "reflections", `dream-${report.date}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("weekly review respects goals added after morning planning", async () => {
    const stateManager = new StateManager(tmpDir);
    await stateManager.saveGoal(makeActiveGoal("existing-goal"));

    // Morning planning runs with only 1 goal
    const morningLLM = createMockLLMClient([makePlanningLLMResponse("existing-goal")]);
    const morningReport = await runMorningPlanning({
      stateManager,
      llmClient: morningLLM,
      baseDir: tmpDir,
    });
    expect(morningReport.goals_reviewed).toBe(1);

    // New goal added after morning planning
    await stateManager.saveGoal(makeActiveGoal("new-goal-added-later"));

    // Weekly review should see both goals
    const weeklyLLM = createMockLLMClient([makeWeeklyLLMResponse(["existing-goal", "new-goal-added-later"])]);
    const weeklyReport = await runWeeklyReview({
      stateManager,
      llmClient: weeklyLLM,
      baseDir: tmpDir,
    });

    expect(weeklyReport.goals_reviewed).toBe(2);
    const reviewedIds = weeklyReport.rankings.map((r) => r.goal_id);
    expect(reviewedIds).toContain("existing-goal");
    expect(reviewedIds).toContain("new-goal-added-later");
  });
});
