import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state/state-manager.js";
import { ReportingEngine } from "../src/reporting/reporting-engine.js";
import type { Report } from "../src/types/report.js";
import type { CharacterConfig } from "../src/types/character.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Test helpers ───

function makeBaseParams(overrides: Partial<Parameters<ReportingEngine["generateExecutionSummary"]>[0]> = {}) {
  return {
    goalId: "goal-001",
    loopIndex: 1,
    observation: [
      { dimensionName: "test_coverage", progress: 0.6, confidence: 0.9 },
      { dimensionName: "build_pass", progress: 1.0, confidence: 0.95 },
    ],
    gapAggregate: 0.4,
    taskResult: { taskId: "task-abc", action: "run-tests", dimension: "test_coverage" },
    stallDetected: false,
    pivotOccurred: false,
    elapsedMs: 12300,
    ...overrides,
  };
}

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;
let engine: ReportingEngine;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  engine = new ReportingEngine(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── generateExecutionSummary ───

describe("generateExecutionSummary", () => {
  it("returns a Report object with correct type and title", () => {
    const report = engine.generateExecutionSummary(makeBaseParams());
    expect(report.report_type).toBe("execution_summary");
    expect(report.title).toBe("Execution Summary — Loop 1");
    expect(report.goal_id).toBe("goal-001");
  });

  it("includes loop index in content", () => {
    const report = engine.generateExecutionSummary(makeBaseParams({ loopIndex: 5 }));
    expect(report.content).toContain("Loop 5");
  });

  it("includes observation dimensions in content table", () => {
    const report = engine.generateExecutionSummary(makeBaseParams());
    expect(report.content).toContain("test_coverage");
    expect(report.content).toContain("build_pass");
  });

  it("formats progress as raw value and confidence as percentage", () => {
    const report = engine.generateExecutionSummary(makeBaseParams({
      observation: [{ dimensionName: "dim_x", progress: 0.75, confidence: 0.8 }],
    }));
    expect(report.content).toContain("0.8");
    expect(report.content).toContain("80.0%");
  });

  it("includes gap aggregate score", () => {
    const report = engine.generateExecutionSummary(makeBaseParams({ gapAggregate: 0.35 }));
    expect(report.content).toContain("0.3500");
  });

  it("includes task result when provided", () => {
    const report = engine.generateExecutionSummary(makeBaseParams({
      taskResult: { taskId: "task-xyz", action: "fix-lint", dimension: "code_quality" },
    }));
    expect(report.content).toContain("task-xyz");
    expect(report.content).toContain("fix-lint");
    expect(report.content).toContain("code_quality");
  });

  it("shows 'No task executed' when taskResult is null", () => {
    const report = engine.generateExecutionSummary(makeBaseParams({ taskResult: null }));
    expect(report.content).toContain("No task executed");
  });

  it("shows 'Stall detected: Yes' when stallDetected is true", () => {
    const report = engine.generateExecutionSummary(makeBaseParams({ stallDetected: true }));
    expect(report.content).toContain("**Stall detected**: Yes");
  });

  it("shows 'Strategy pivot: Yes' when pivotOccurred is true", () => {
    const report = engine.generateExecutionSummary(makeBaseParams({ pivotOccurred: true }));
    expect(report.content).toContain("**Strategy pivot**: Yes");
  });

  it("includes elapsed time in seconds", () => {
    const report = engine.generateExecutionSummary(makeBaseParams({ elapsedMs: 5500 }));
    expect(report.content).toContain("5.5s");
  });

  it("handles empty observation list", () => {
    const report = engine.generateExecutionSummary(makeBaseParams({ observation: [] }));
    expect(report.content).toContain("(none)");
  });

  it("assigns a unique id (UUID format)", () => {
    const r1 = engine.generateExecutionSummary(makeBaseParams());
    const r2 = engine.generateExecutionSummary(makeBaseParams());
    expect(r1.id).not.toBe(r2.id);
    expect(r1.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("sets generated_at as ISO timestamp", () => {
    const report = engine.generateExecutionSummary(makeBaseParams());
    expect(() => new Date(report.generated_at)).not.toThrow();
    expect(new Date(report.generated_at).toISOString()).toBe(report.generated_at);
  });

  it("sets verbosity to 'standard'", () => {
    const report = engine.generateExecutionSummary(makeBaseParams());
    expect(report.verbosity).toBe("standard");
  });

  it("sets delivered_at to null and read to false", () => {
    const report = engine.generateExecutionSummary(makeBaseParams());
    expect(report.delivered_at).toBeNull();
    expect(report.read).toBe(false);
  });
});

// ─── saveReport / getReport ───

describe("saveReport / getReport", () => {
  it("saves and retrieves a report by id", async () => {
    const report = engine.generateExecutionSummary(makeBaseParams());
    await engine.saveReport(report);
    const loaded = await engine.getReport(report.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(report.id);
    expect(loaded!.title).toBe(report.title);
  });

  it("returns null for a non-existent report id", async () => {
    const result = await engine.getReport("nonexistent-id");
    expect(result).toBeNull();
  });

  it("persists report to disk under reports/<goalId>/<reportId>.json", async () => {
    const report = engine.generateExecutionSummary(makeBaseParams({ goalId: "goal-persist" }));
    await engine.saveReport(report);
    const expectedPath = path.join(tempDir, "reports", "goal-persist", `${report.id}.json`);
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it("round-trips notification report through save/get", async () => {
    const report = await engine.generateNotification("urgent", {
      goalId: "goal-001",
      message: "Critical failure",
      details: "Something went wrong",
    });
    await engine.saveReport(report);
    const loaded = await engine.getReport(report.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.report_type).toBe("urgent_alert");
    expect(loaded!.content).toContain("Critical failure");
  });
});

// ─── listReports ───

describe("listReports", () => {
  it("returns empty array when no reports saved", async () => {
    expect(await engine.listReports()).toHaveLength(0);
  });

  it("returns all saved reports", async () => {
    const r1 = engine.generateExecutionSummary(makeBaseParams({ goalId: "goal-a" }));
    const r2 = engine.generateExecutionSummary(makeBaseParams({ goalId: "goal-b" }));
    await engine.saveReport(r1);
    await engine.saveReport(r2);
    const all = await engine.listReports();
    expect(all.length).toBe(2);
  });

  it("filters by goalId when provided", async () => {
    const r1 = engine.generateExecutionSummary(makeBaseParams({ goalId: "goal-a" }));
    const r2 = engine.generateExecutionSummary(makeBaseParams({ goalId: "goal-b" }));
    await engine.saveReport(r1);
    await engine.saveReport(r2);
    const goalA = await engine.listReports("goal-a");
    expect(goalA).toHaveLength(1);
    expect(goalA[0].goal_id).toBe("goal-a");
  });

  it("returns empty array for goalId with no reports", async () => {
    const r1 = engine.generateExecutionSummary(makeBaseParams({ goalId: "goal-a" }));
    await engine.saveReport(r1);
    expect(await engine.listReports("goal-b")).toHaveLength(0);
  });

  it("returns reports sorted by generated_at ascending", async () => {
    const r1 = engine.generateExecutionSummary(makeBaseParams({ loopIndex: 1 }));
    await engine.saveReport(r1);
    const r2 = engine.generateExecutionSummary(makeBaseParams({ loopIndex: 2 }));
    await engine.saveReport(r2);
    const r3 = engine.generateExecutionSummary(makeBaseParams({ loopIndex: 3 }));
    await engine.saveReport(r3);

    const all = await engine.listReports("goal-001");
    expect(all.length).toBe(3);
    for (let i = 1; i < all.length; i++) {
      expect(all[i].generated_at >= all[i - 1].generated_at).toBe(true);
    }
  });
});

// ─── formatForCLI ───

describe("formatForCLI", () => {
  it("formats execution summary compactly", () => {
    const report = engine.generateExecutionSummary(makeBaseParams({
      loopIndex: 5,
      goalId: "goal-001",
      gapAggregate: 0.35,
      elapsedMs: 12300,
      taskResult: { taskId: "fix-tests", action: "run-tests", dimension: "test_coverage" },
    }));
    const formatted = engine.formatForCLI(report);
    expect(formatted).toContain("[Loop 5]");
    expect(formatted).toContain("goal-001");
    expect(formatted).toContain("gap: 0.35");
    expect(formatted).toContain("fix-tests");
    expect(formatted).toContain("12.3s");
  });

  it("shows 'no task' when taskResult is null", () => {
    const report = engine.generateExecutionSummary(makeBaseParams({ taskResult: null }));
    const formatted = engine.formatForCLI(report);
    expect(formatted).toContain("no task");
  });

  it("formats daily summary compactly", async () => {
    const report = await engine.generateDailySummary("goal-001");
    await engine.saveReport(report);
    const formatted = engine.formatForCLI(report);
    expect(formatted).toContain("[Daily");
    expect(formatted).toContain("goal-001");
    expect(formatted).toContain("loops");
  });

  it("formats weekly report compactly", async () => {
    const report = await engine.generateWeeklyReport("goal-001");
    const formatted = engine.formatForCLI(report);
    expect(formatted).toContain("[Weekly");
    expect(formatted).toContain("goal-001");
    expect(formatted).toContain("total loops");
  });

  it("formats notification reports with fallback format", async () => {
    const report = await engine.generateNotification("urgent", {
      goalId: "goal-001",
      message: "Critical issue",
    });
    const formatted = engine.formatForCLI(report);
    expect(formatted).toContain("urgent_alert");
    expect(formatted).toContain("goal-001");
  });
});

// ─── generateNotification ───

describe("generateNotification", () => {
  it("urgent notification → report_type = urgent_alert", async () => {
    const report = await engine.generateNotification("urgent", {
      goalId: "goal-001",
      message: "Critical failure",
    });
    expect(report.report_type).toBe("urgent_alert");
    expect(report.title).toContain("Urgent");
    expect(report.content).toContain("Critical failure");
  });

  it("approval_required notification → report_type = approval_request", async () => {
    const report = await engine.generateNotification("approval_required", {
      goalId: "goal-001",
      message: "Deploy to production",
    });
    expect(report.report_type).toBe("approval_request");
    expect(report.title).toContain("Approval Required");
    expect(report.content).toContain("Deploy to production");
  });

  it("stall_escalation notification → report_type = stall_escalation", async () => {
    const report = await engine.generateNotification("stall_escalation", {
      goalId: "goal-001",
      message: "No progress in 5 loops",
    });
    expect(report.report_type).toBe("stall_escalation");
    expect(report.title).toContain("Stall Escalation");
    expect(report.content).toContain("No progress in 5 loops");
  });

  it("completed notification → report_type = goal_completion", async () => {
    const report = await engine.generateNotification("completed", {
      goalId: "goal-001",
      message: "All dimensions satisfied",
    });
    expect(report.report_type).toBe("goal_completion");
    expect(report.title).toContain("Goal Completed");
    expect(report.content).toContain("All dimensions satisfied");
  });

  it("capability_insufficient notification → report_type = capability_escalation", async () => {
    const report = await engine.generateNotification("capability_insufficient", {
      goalId: "goal-001",
      message: "Cannot execute this task",
    });
    expect(report.report_type).toBe("capability_escalation");
    expect(report.title).toContain("Capability Insufficient");
    expect(report.content).toContain("Cannot execute this task");
  });

  it("includes details section when provided", async () => {
    const report = await engine.generateNotification("urgent", {
      goalId: "goal-001",
      message: "Issue",
      details: "Additional context here",
    });
    expect(report.content).toContain("Additional context here");
    expect(report.content).toContain("### Details");
  });

  it("omits details section when details not provided", async () => {
    const report = await engine.generateNotification("urgent", {
      goalId: "goal-001",
      message: "Issue",
    });
    expect(report.content).not.toContain("### Details");
  });

  it("sets goal_id on notification", async () => {
    const report = await engine.generateNotification("completed", {
      goalId: "goal-xyz",
      message: "Done",
    });
    expect(report.goal_id).toBe("goal-xyz");
  });

  it("all notifications have valid generated_at timestamp", async () => {
    const types: Array<Parameters<ReportingEngine["generateNotification"]>[0]> = [
      "urgent",
      "approval_required",
      "stall_escalation",
      "completed",
      "capability_insufficient",
    ];
    for (const type of types) {
      const report = await engine.generateNotification(type, {
        goalId: "goal-001",
        message: "test",
      });
      expect(() => new Date(report.generated_at)).not.toThrow();
    }
  });
});

// ─── generateDailySummary ───

describe("generateDailySummary", () => {
  it("returns daily_summary report type", async () => {
    const report = await engine.generateDailySummary("goal-001");
    expect(report.report_type).toBe("daily_summary");
  });

  it("title includes today's date", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const report = await engine.generateDailySummary("goal-001");
    expect(report.title).toContain(today);
  });

  it("shows 0 loops when no execution summaries saved today", async () => {
    const report = await engine.generateDailySummary("goal-001");
    expect(report.content).toContain("**Loops run**: 0");
    expect(report.content).toContain("N/A");
  });

  it("counts loops from saved execution summaries", async () => {
    for (let i = 1; i <= 3; i++) {
      const r = engine.generateExecutionSummary(makeBaseParams({ loopIndex: i }));
      await engine.saveReport(r);
    }
    const report = await engine.generateDailySummary("goal-001");
    expect(report.content).toContain("**Loops run**: 3");
  });

  it("counts stalls correctly", async () => {
    const r1 = engine.generateExecutionSummary(makeBaseParams({ stallDetected: true }));
    const r2 = engine.generateExecutionSummary(makeBaseParams({ stallDetected: false }));
    const r3 = engine.generateExecutionSummary(makeBaseParams({ stallDetected: true }));
    await engine.saveReport(r1);
    await engine.saveReport(r2);
    await engine.saveReport(r3);
    const report = await engine.generateDailySummary("goal-001");
    expect(report.content).toContain("**Stalls detected**: 2");
  });

  it("counts pivots correctly", async () => {
    const r1 = engine.generateExecutionSummary(makeBaseParams({ pivotOccurred: true }));
    const r2 = engine.generateExecutionSummary(makeBaseParams({ pivotOccurred: true }));
    await engine.saveReport(r1);
    await engine.saveReport(r2);
    const report = await engine.generateDailySummary("goal-001");
    expect(report.content).toContain("**Strategy pivots**: 2");
  });

  it("computes gap reduction when gap decreases", async () => {
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const r1 = engine.generateExecutionSummary(makeBaseParams({ gapAggregate: 0.8, loopIndex: 1 }));
    await engine.saveReport(r1);
    vi.setSystemTime(t0 + 1);
    const r2 = engine.generateExecutionSummary(makeBaseParams({ gapAggregate: 0.5, loopIndex: 2 }));
    await engine.saveReport(r2);
    vi.useRealTimers();
    const report = await engine.generateDailySummary("goal-001");
    expect(report.content).toContain("gap reduced");
  });

  it("computes gap growth when gap increases", async () => {
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const r1 = engine.generateExecutionSummary(makeBaseParams({ gapAggregate: 0.3, loopIndex: 1 }));
    await engine.saveReport(r1);
    vi.setSystemTime(t0 + 1);
    const r2 = engine.generateExecutionSummary(makeBaseParams({ gapAggregate: 0.7, loopIndex: 2 }));
    await engine.saveReport(r2);
    vi.useRealTimers();
    const report = await engine.generateDailySummary("goal-001");
    expect(report.content).toContain("gap grew");
  });

  it("only counts summaries from goal matching goalId", async () => {
    const r1 = engine.generateExecutionSummary(makeBaseParams({ goalId: "goal-001" }));
    const r2 = engine.generateExecutionSummary(makeBaseParams({ goalId: "goal-002" }));
    await engine.saveReport(r1);
    await engine.saveReport(r2);
    const report = await engine.generateDailySummary("goal-001");
    expect(report.content).toContain("**Loops run**: 1");
  });
});

// ─── generateWeeklyReport ───

describe("generateWeeklyReport", () => {
  it("returns weekly_report report type", async () => {
    const report = await engine.generateWeeklyReport("goal-001");
    expect(report.report_type).toBe("weekly_report");
  });

  it("title includes today's date", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const report = await engine.generateWeeklyReport("goal-001");
    expect(report.title).toContain(today);
  });

  it("shows 0 days with activity when no daily summaries saved", async () => {
    const report = await engine.generateWeeklyReport("goal-001");
    expect(report.content).toContain("**Days with activity**: 0");
    expect(report.content).toContain("No daily activity");
  });

  it("aggregates daily summaries into total loops", async () => {
    for (let i = 1; i <= 3; i++) {
      const r = engine.generateExecutionSummary(makeBaseParams({ loopIndex: i }));
      await engine.saveReport(r);
    }
    const daily = await engine.generateDailySummary("goal-001");
    await engine.saveReport(daily);

    const weekly = await engine.generateWeeklyReport("goal-001");
    expect(weekly.content).toContain("**Days with activity**: 1");
    expect(weekly.content).toContain("**Total loops run**: 3");
  });

  it("includes daily trend section", async () => {
    const daily = await engine.generateDailySummary("goal-001");
    await engine.saveReport(daily);

    const weekly = await engine.generateWeeklyReport("goal-001");
    expect(weekly.content).toContain("### Daily Trend");
    expect(weekly.content).not.toContain("No daily activity");
  });

  it("includes period information", async () => {
    const report = await engine.generateWeeklyReport("goal-001");
    expect(report.content).toContain("Last 7 days");
  });
});

// ─── Edge cases ───

describe("edge cases", () => {
  it("getReport returns null when store is empty", async () => {
    expect(await engine.getReport("any-id")).toBeNull();
  });

  it("listReports with no reports returns empty array", async () => {
    expect(await engine.listReports()).toEqual([]);
    expect(await engine.listReports("goal-001")).toEqual([]);
  });

  it("multiple reports for multiple goals are retrievable independently", async () => {
    const goals = ["goal-a", "goal-b", "goal-c"];
    for (const g of goals) {
      const r = engine.generateExecutionSummary(makeBaseParams({ goalId: g }));
      await engine.saveReport(r);
    }
    for (const g of goals) {
      const reports = await engine.listReports(g);
      expect(reports).toHaveLength(1);
      expect(reports[0].goal_id).toBe(g);
    }
  });

  it("execution summary with 100% progress renders correctly", () => {
    const report = engine.generateExecutionSummary(makeBaseParams({
      observation: [{ dimensionName: "all_done", progress: 1.0, confidence: 1.0 }],
      gapAggregate: 0,
    }));
    expect(report.content).toContain("100.0%");
    expect(report.content).toContain("0.0000");
  });

  it("formatForCLI handles report with null goal_id gracefully", async () => {
    const report = await engine.generateNotification("completed", {
      goalId: "goal-001",
      message: "Done",
    });
    const modified: Report = { ...report, goal_id: null };
    const formatted = engine.formatForCLI(modified);
    expect(formatted).toContain("no goal");
  });

  it("saveReport / getReport round-trips all notification types", async () => {
    const types: Array<Parameters<ReportingEngine["generateNotification"]>[0]> = [
      "urgent",
      "approval_required",
      "stall_escalation",
      "completed",
      "capability_insufficient",
    ];
    for (const t of types) {
      const report = await engine.generateNotification(t, {
        goalId: "goal-round-trip",
        message: `Test ${t}`,
      });
      await engine.saveReport(report);
      const loaded = await engine.getReport(report.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.report_type).toBe(report.report_type);
    }
  });

  it("generateDailySummary with single loop shows 'Single loop' message", async () => {
    const r = engine.generateExecutionSummary(makeBaseParams({ loopIndex: 1 }));
    await engine.saveReport(r);
    const daily = await engine.generateDailySummary("goal-001");
    expect(daily.content).toContain("Single loop");
  });
});

// ─── CharacterConfig integration ───

describe("CharacterConfig — constructor", () => {
  it("constructor without characterConfig works (backwards compatible)", () => {
    const eng = new ReportingEngine(stateManager);
    const report = eng.generateExecutionSummary(makeBaseParams());
    expect(report.report_type).toBe("execution_summary");
    expect(report.content).toContain("## Execution Summary");
    expect(report.content).toContain("### Observation Results");
  });

  it("default config (proactivity=2) preserves existing detailed behavior", () => {
    const eng = new ReportingEngine(stateManager);
    const report = eng.generateExecutionSummary(makeBaseParams());
    expect(report.content).toContain("## Execution Summary");
    expect(report.content).toContain("### Observation Results");
  });
});

describe("CharacterConfig — proactivity_level (execution summary verbosity)", () => {
  it("proactivity=1: execution summary is brief (1-3 lines) for normal loop", () => {
    const config: CharacterConfig = {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 1,
    };
    const eng = new ReportingEngine(stateManager, undefined, config);
    const report = eng.generateExecutionSummary(makeBaseParams({
      stallDetected: false,
      pivotOccurred: false,
      taskResult: { taskId: "t1", action: "run", dimension: "dim" },
    }));
    expect(report.content).not.toContain("## Execution Summary");
    expect(report.content).not.toContain("### Observation Results");
    expect(report.content).toContain("Loop 1");
    expect(report.content).toContain("gap:");
  });

  it("proactivity=5: execution summary is detailed (full format)", () => {
    const config: CharacterConfig = {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 5,
    };
    const eng = new ReportingEngine(stateManager, undefined, config);
    const report = eng.generateExecutionSummary(makeBaseParams());
    expect(report.content).toContain("## Execution Summary");
    expect(report.content).toContain("### Observation Results");
    expect(report.content).toContain("### Gap Aggregate");
    expect(report.content).toContain("### Task Result");
    expect(report.content).toContain("### Status");
    expect(report.content).toContain("### Elapsed Time");
  });

  it("proactivity=3: execution summary uses normal (full) format", () => {
    const config: CharacterConfig = {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 3,
    };
    const eng = new ReportingEngine(stateManager, undefined, config);
    const report = eng.generateExecutionSummary(makeBaseParams());
    expect(report.content).toContain("## Execution Summary");
    expect(report.content).toContain("### Observation Results");
  });

  it("proactivity=1 but stallDetected=true: still produces detailed output", () => {
    const config: CharacterConfig = {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 1,
    };
    const eng = new ReportingEngine(stateManager, undefined, config);
    const report = eng.generateExecutionSummary(makeBaseParams({
      stallDetected: true,
      pivotOccurred: false,
      taskResult: { taskId: "t1", action: "run", dimension: "dim" },
    }));
    expect(report.content).toContain("## Execution Summary");
    expect(report.content).toContain("**Stall detected**: Yes");
    expect(report.content).toContain("### Observation Results");
  });

  it("proactivity=1 but pivotOccurred=true: still produces detailed output", () => {
    const config: CharacterConfig = {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 1,
    };
    const eng = new ReportingEngine(stateManager, undefined, config);
    const report = eng.generateExecutionSummary(makeBaseParams({
      stallDetected: false,
      pivotOccurred: true,
      taskResult: { taskId: "t1", action: "run", dimension: "dim" },
    }));
    expect(report.content).toContain("## Execution Summary");
    expect(report.content).toContain("**Strategy pivot**: Yes");
  });

  it("proactivity=1 but taskResult=null (completion-like): still produces detailed output", () => {
    const config: CharacterConfig = {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 1,
    };
    const eng = new ReportingEngine(stateManager, undefined, config);
    const report = eng.generateExecutionSummary(makeBaseParams({
      stallDetected: false,
      pivotOccurred: false,
      taskResult: null,
    }));
    expect(report.content).toContain("## Execution Summary");
    expect(report.content).toContain("No task executed");
  });

  it("proactivity=1: brief summary includes goal-relevant dimension names", () => {
    const config: CharacterConfig = {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 1,
    };
    const eng = new ReportingEngine(stateManager, undefined, config);
    const report = eng.generateExecutionSummary(makeBaseParams({
      stallDetected: false,
      pivotOccurred: false,
      taskResult: { taskId: "t1", action: "run", dimension: "test_coverage" },
    }));
    expect(report.content).toContain("test_coverage");
    expect(report.content).toContain("build_pass");
  });
});

describe("CharacterConfig — communication_directness (notification suggestions)", () => {
  it("directness=1: escalation notification includes suggestions section", async () => {
    const config: CharacterConfig = {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 1,
      proactivity_level: 2,
    };
    const eng = new ReportingEngine(stateManager, undefined, config);
    const report = await eng.generateNotification("stall_escalation", {
      goalId: "goal-001",
      message: "Stalled for 5 loops",
    });
    expect(report.content).toContain("Suggested next actions:");
  });

  it("directness=2: stall notification includes suggestions section", async () => {
    const config: CharacterConfig = {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 2,
      proactivity_level: 2,
    };
    const eng = new ReportingEngine(stateManager, undefined, config);
    const report = await eng.generateNotification("stall_escalation", {
      goalId: "goal-001",
      message: "Stalled",
    });
    expect(report.content).toContain("Suggested next actions:");
  });

  it("directness=1: capability_insufficient notification includes suggestions section", async () => {
    const config: CharacterConfig = {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 1,
      proactivity_level: 2,
    };
    const eng = new ReportingEngine(stateManager, undefined, config);
    const report = await eng.generateNotification("capability_insufficient", {
      goalId: "goal-001",
      message: "Cannot execute",
    });
    expect(report.content).toContain("Suggested next actions:");
  });

  it("directness=5: notifications have no suggestions section", async () => {
    const config: CharacterConfig = {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 5,
      proactivity_level: 2,
    };
    const eng = new ReportingEngine(stateManager, undefined, config);
    const escalation = await eng.generateNotification("stall_escalation", {
      goalId: "goal-001",
      message: "Stalled",
    });
    const stall = await eng.generateNotification("capability_insufficient", {
      goalId: "goal-001",
      message: "Cannot execute",
    });
    expect(escalation.content).not.toContain("Suggested next actions:");
    expect(stall.content).not.toContain("Suggested next actions:");
  });

  it("directness=4: notifications have no suggestions section", async () => {
    const config: CharacterConfig = {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 4,
      proactivity_level: 2,
    };
    const eng = new ReportingEngine(stateManager, undefined, config);
    const report = await eng.generateNotification("stall_escalation", {
      goalId: "goal-001",
      message: "Stalled",
    });
    expect(report.content).not.toContain("Suggested next actions:");
  });

  it("directness=3 (balanced): stall_escalation includes suggestions section", async () => {
    const config: CharacterConfig = {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 2,
    };
    const eng = new ReportingEngine(stateManager, undefined, config);
    const report = await eng.generateNotification("stall_escalation", {
      goalId: "goal-001",
      message: "Stalled",
    });
    expect(report.content).not.toContain("Suggested next actions:");
  });

  it("directness=3 (balanced): capability_insufficient notification includes suggestions", async () => {
    const config: CharacterConfig = {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 2,
    };
    const eng = new ReportingEngine(stateManager, undefined, config);
    const report = await eng.generateNotification("capability_insufficient", {
      goalId: "goal-001",
      message: "Cannot execute",
    });
    expect(report.content).toContain("Suggested next actions:");
  });

  it("directness=3 (balanced): urgent notification has no suggestions section", async () => {
    const config: CharacterConfig = {
      caution_level: 2,
      stall_flexibility: 1,
      communication_directness: 3,
      proactivity_level: 2,
    };
    const eng = new ReportingEngine(stateManager, undefined, config);
    const report = await eng.generateNotification("urgent", {
      goalId: "goal-001",
      message: "Urgent issue",
    });
    expect(report.content).not.toContain("Suggested next actions:");
  });

  it("default config (directness=3): escalation has suggestions, stall does not", async () => {
    const eng = new ReportingEngine(stateManager);
    const escalation = await eng.generateNotification("capability_insufficient", {
      goalId: "goal-001",
      message: "Cannot execute",
    });
    const stall = await eng.generateNotification("stall_escalation", {
      goalId: "goal-001",
      message: "Stalled",
    });
    expect(escalation.content).toContain("Suggested next actions:");
    expect(stall.content).not.toContain("Suggested next actions:");
  });
});
