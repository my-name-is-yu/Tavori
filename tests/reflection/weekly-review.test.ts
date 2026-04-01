import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../helpers/temp-dir.js";
import { createMockLLMClient } from "../helpers/mock-llm.js";
import { runWeeklyReview } from "../../src/reflection/weekly-review.js";
import type { Goal } from "../../src/types/goal.js";

// ─── Fixtures ───

function makeGoal(id: string, overrides: Partial<Goal> = {}): Goal {
  return {
    id,
    parent_id: null,
    node_type: "goal",
    title: `Goal ${id}`,
    description: "",
    status: "active",
    dimensions: [
      {
        name: "progress",
        label: "Progress",
        current_value: 0.4,
        threshold: { type: "min", value: 1.0 },
        confidence: 0.8,
        observation_method: { type: "self_report" },
        last_updated: null,
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeStateManager(goals: Goal[]) {
  return {
    listGoalIds: vi.fn().mockResolvedValue(goals.map((g) => g.id)),
    loadGoal: vi.fn().mockImplementation(async (id: string) => goals.find((g) => g.id === id) ?? null),
    loadGapHistory: vi.fn().mockResolvedValue([]),
  };
}

const VALID_LLM_RESPONSE = JSON.stringify({
  rankings: [
    { goal_id: "g1", progress_rate: 0.8, strategy_effectiveness: "high", recommendation: "Keep going" },
    { goal_id: "g2", progress_rate: 0.3, strategy_effectiveness: "low", recommendation: "Switch strategy" },
  ],
  suggested_additions: ["Add a documentation goal"],
  suggested_removals: ["g2"],
  summary: "Good week overall. g1 made strong progress.",
});

// ─── Tests ───

describe("runWeeklyReview", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  it("happy path: returns a valid WeeklyReviewReport with 2 goals", async () => {
    tmpDir = makeTempDir();
    const goals = [makeGoal("g1"), makeGoal("g2")];
    const stateManager = makeStateManager(goals);
    const llmClient = createMockLLMClient([VALID_LLM_RESPONSE]);

    const report = await runWeeklyReview({
      stateManager: stateManager as never,
      llmClient,
      baseDir: tmpDir,
    });

    expect(report.goals_reviewed).toBe(2);
    expect(report.rankings).toHaveLength(2);
    expect(report.rankings[0]?.goal_id).toBe("g1");
    expect(report.rankings[0]?.strategy_effectiveness).toBe("high");
    expect(report.suggested_additions).toEqual(["Add a documentation goal"]);
    expect(report.suggested_removals).toEqual(["g2"]);
    expect(report.summary).toBe("Good week overall. g1 made strong progress.");
  });

  it("empty goals: returns report with zero goals and empty rankings", async () => {
    tmpDir = makeTempDir();
    const stateManager = makeStateManager([]);
    const llmClient = createMockLLMClient([]);

    const report = await runWeeklyReview({
      stateManager: stateManager as never,
      llmClient,
      baseDir: tmpDir,
    });

    expect(report.goals_reviewed).toBe(0);
    expect(report.rankings).toHaveLength(0);
    expect(llmClient.callCount).toBe(0);
  });

  it("persists report to file with correct week-based name", async () => {
    tmpDir = makeTempDir();
    const goals = [makeGoal("g1")];
    const stateManager = makeStateManager(goals);
    const llmClient = createMockLLMClient([
      JSON.stringify({
        rankings: [{ goal_id: "g1", progress_rate: 0.5, strategy_effectiveness: "medium", recommendation: "OK" }],
        suggested_additions: [],
        suggested_removals: [],
        summary: "Steady week.",
      }),
    ]);

    const report = await runWeeklyReview({
      stateManager: stateManager as never,
      llmClient,
      baseDir: tmpDir,
    });

    const filePath = path.join(tmpDir, "reflections", `weekly-${report.week}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.goals_reviewed).toBe(1);
    expect(content.week).toBe(report.week);
  });

  it("LLM error: returns partial report without crashing", async () => {
    tmpDir = makeTempDir();
    const goals = [makeGoal("g1")];
    const stateManager = makeStateManager(goals);
    const llmClient = {
      callCount: 0,
      sendMessage: vi.fn().mockRejectedValue(new Error("LLM timeout")),
      parseJSON: vi.fn(),
    };

    const report = await runWeeklyReview({
      stateManager: stateManager as never,
      llmClient: llmClient as never,
      baseDir: tmpDir,
    });

    expect(report.goals_reviewed).toBe(1);
    expect(report.rankings).toHaveLength(0);
    expect(report.summary).toBe("");
  });

  it("week string matches YYYY-Wnn format", async () => {
    tmpDir = makeTempDir();
    const stateManager = makeStateManager([]);
    const llmClient = createMockLLMClient([]);

    const report = await runWeeklyReview({
      stateManager: stateManager as never,
      llmClient,
      baseDir: tmpDir,
    });

    expect(report.week).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("calls notificationDispatcher when goals present", async () => {
    tmpDir = makeTempDir();
    const goals = [makeGoal("g1")];
    const stateManager = makeStateManager(goals);
    const llmClient = createMockLLMClient([VALID_LLM_RESPONSE]);
    const dispatcher = { dispatch: vi.fn().mockResolvedValue([]) };

    await runWeeklyReview({
      stateManager: stateManager as never,
      llmClient,
      baseDir: tmpDir,
      notificationDispatcher: dispatcher as never,
    });

    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
    const call = dispatcher.dispatch.mock.calls[0][0];
    expect(call.report_type).toBe("weekly_report");
  });
});
