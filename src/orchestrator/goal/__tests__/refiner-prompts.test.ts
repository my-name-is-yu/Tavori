import { describe, it, expect } from "vitest";
import { buildLeafTestPrompt } from "../refiner-prompts.js";
import type { Goal } from "../../../base/types/goal.js";

// ─── Helpers ───

const now = new Date().toISOString();

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    parent_id: null,
    node_type: "goal",
    title: "Improve test coverage",
    description: "Reach 80% statement coverage for the auth module",
    status: "active",
    dimensions: [],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: ["Must not break existing tests"],
    children_ids: [],
    target_date: null,
    origin: null,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: 1,
    specificity_score: null,
    loop_status: "idle",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ─── Tests ───

describe("buildLeafTestPrompt", () => {
  it("includes the goal description in the prompt", () => {
    const goal = makeGoal();
    const prompt = buildLeafTestPrompt(goal, ["shell", "file_existence"]);
    expect(prompt).toContain("Reach 80% statement coverage for the auth module");
  });

  it("includes all available data sources", () => {
    const goal = makeGoal({ constraints: [] });
    const prompt = buildLeafTestPrompt(goal, ["shell", "file_existence", "github_issue"]);
    expect(prompt).toContain("shell");
    expect(prompt).toContain("file_existence");
    expect(prompt).toContain("github_issue");
  });

  it("includes goal constraints when present", () => {
    const goal = makeGoal({ constraints: ["Must not break existing tests", "No new dependencies"] });
    const prompt = buildLeafTestPrompt(goal, ["shell"]);
    expect(prompt).toContain("Must not break existing tests");
    expect(prompt).toContain("No new dependencies");
  });

  it("shows 'none' for constraints when goal has none", () => {
    const goal = makeGoal({ constraints: [] });
    const prompt = buildLeafTestPrompt(goal, ["shell"]);
    expect(prompt).toContain("none");
  });

  it("includes the decomposition depth", () => {
    const goal = makeGoal({ decomposition_depth: 2 });
    const prompt = buildLeafTestPrompt(goal, ["shell"]);
    expect(prompt).toContain("Depth: 2");
  });

  it("includes the four required measurement criteria", () => {
    const goal = makeGoal();
    const prompt = buildLeafTestPrompt(goal, ["shell"]);
    expect(prompt).toContain("data_source");
    expect(prompt).toContain("observation_command");
    expect(prompt).toContain("threshold_type");
    expect(prompt).toContain("threshold_value");
  });

  it("includes JSON schema instructions with is_measurable field", () => {
    const goal = makeGoal();
    const prompt = buildLeafTestPrompt(goal, ["shell"]);
    expect(prompt).toContain('"is_measurable"');
    expect(prompt).toContain('"dimensions"');
    expect(prompt).toContain('"reason"');
  });

  it("falls back to default data sources when none are provided", () => {
    const goal = makeGoal({ constraints: [] });
    const prompt = buildLeafTestPrompt(goal, []);
    expect(prompt).toContain("shell");
    expect(prompt).toContain("file_existence");
  });

  it("returns a non-empty string", () => {
    const goal = makeGoal();
    const prompt = buildLeafTestPrompt(goal, ["shell"]);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});
