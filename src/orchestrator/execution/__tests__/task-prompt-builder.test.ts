import * as path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn(),
    readFile: vi.fn(),
  };
});

// Mock issue-context-fetcher so dynamic import in buildTaskGenerationPrompt is controlled
vi.mock("../context/issue-context-fetcher.js", () => ({
  fetchIssueContext: vi.fn(async () => ""),
}));

import * as fsp from "node:fs/promises";
import { buildTaskGenerationPrompt } from "../task/task-prompt-builder.js";
import { fetchIssueContext } from "../context/issue-context-fetcher.js";
import type { StateManager } from "../../../base/state/state-manager.js";

const mockFetchIssueContext = vi.mocked(fetchIssueContext);
const mockAccess = vi.mocked(fsp.access);
const mockReadFile = vi.mocked(fsp.readFile);
const packageJsonContents = JSON.stringify({
  name: "pulseed",
  version: "0.4.3",
  description: "AI agent orchestrator that gives existing agents the drive to persist — set a goal, and PulSeed observes, delegates, verifies, and loops until done.",
});

// Minimal Goal shape used in tests
function makeGoal(overrides: {
  id: string;
  title: string;
  description?: string;
  parent_id?: string | null;
}) {
  return {
    id: overrides.id,
    title: overrides.title,
    description: overrides.description ?? "",
    parent_id: overrides.parent_id ?? null,
    dimensions: [],
    status: "active" as const,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    threshold_type: "min" as const,
    threshold_value: 0,
    current_value: null,
    confidence: 0.5,
    tags: [],
  };
}

function makeMockStateManager(goals: Record<string, ReturnType<typeof makeGoal>>): StateManager {
  return {
    loadGoal: vi.fn(async (id: string) => goals[id] ?? null),
    readRaw: vi.fn(async () => null),
  } as unknown as StateManager;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAccess.mockImplementation(async (filePath: unknown) => {
    if (typeof filePath === "string" && path.basename(filePath) === "package.json") {
      return undefined;
    }

    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  mockReadFile.mockImplementation(async (filePath: unknown) => {
    if (typeof filePath === "string" && path.basename(filePath) === "package.json") {
      return packageJsonContents;
    }

    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
});

describe("buildTaskGenerationPrompt — parent goal chain", () => {
  it("includes parent goal chain section when goal has parent_id", async () => {
    const parent = makeGoal({ id: "parent-1", title: "Parent Goal", description: "Parent description" });
    const child = makeGoal({ id: "child-1", title: "Child Goal", description: "Child description", parent_id: "parent-1" });
    const sm = makeMockStateManager({ "parent-1": parent, "child-1": child });

    const prompt = await buildTaskGenerationPrompt(sm, "child-1", "coverage");

    expect(prompt).toContain("## Parent Goal Context");
    expect(prompt).toContain("Goal: Parent Goal");
    expect(prompt).toContain("Description: Parent description");
  });

  it("does not include parent goal chain section when goal has no parent_id", async () => {
    const goal = makeGoal({ id: "root-1", title: "Root Goal" });
    const sm = makeMockStateManager({ "root-1": goal });

    const prompt = await buildTaskGenerationPrompt(sm, "root-1", "coverage");

    expect(prompt).not.toContain("## Parent Goal Context");
  });

  it("stops parent chain at 3 levels", async () => {
    const level3 = makeGoal({ id: "l3", title: "Level 3", description: "desc3" });
    const level2 = makeGoal({ id: "l2", title: "Level 2", description: "desc2", parent_id: "l3" });
    const level1 = makeGoal({ id: "l1", title: "Level 1", description: "desc1", parent_id: "l2" });
    const level0 = makeGoal({ id: "l0", title: "Level 0", description: "desc0", parent_id: "l1" });
    // l3 also has a parent — should NOT be loaded
    const level4 = makeGoal({ id: "l4", title: "Level 4 (should not appear)", description: "desc4" });
    const goals = { l0: level0, l1: level1, l2: level2, l3: { ...level3, parent_id: "l4" }, l4: level4 };

    const sm = makeMockStateManager(goals as Record<string, ReturnType<typeof makeGoal>>);

    const prompt = await buildTaskGenerationPrompt(sm, "l0", "coverage");

    expect(prompt).toContain("Goal: Level 1");
    expect(prompt).toContain("Goal: Level 2");
    expect(prompt).toContain("Goal: Level 3");
    expect(prompt).not.toContain("Level 4 (should not appear)");
  });

  it("handles gracefully when a parent goal does not exist", async () => {
    const child = makeGoal({ id: "child-2", title: "Child Goal", parent_id: "missing-parent" });
    const sm = makeMockStateManager({ "child-2": child });

    const prompt = await buildTaskGenerationPrompt(sm, "child-2", "coverage");

    // parent chain section should be absent (loadGoal returned null, chain is empty)
    expect(prompt).not.toContain("## Parent Goal Context");
    // prompt should still be generated without throwing
    expect(prompt).toContain("Goal: Child Goal");
  });
});

describe("buildTaskGenerationPrompt — task purpose section", () => {
  it("includes task purpose section with dimension and subgoal title", async () => {
    const goal = makeGoal({ id: "g1", title: "My Subgoal" });
    const sm = makeMockStateManager({ "g1": goal });

    const prompt = await buildTaskGenerationPrompt(sm, "g1", "test_coverage");

    expect(prompt).toContain("## Task Purpose");
    expect(prompt).toContain('dimension "test_coverage"');
    expect(prompt).toContain('"My Subgoal"');
  });

  it("includes parent goal title in task purpose when parent exists", async () => {
    const parent = makeGoal({ id: "p1", title: "Grand Goal" });
    const child = makeGoal({ id: "c1", title: "Sub Task", parent_id: "p1" });
    const sm = makeMockStateManager({ "p1": parent, "c1": child });

    const prompt = await buildTaskGenerationPrompt(sm, "c1", "velocity");

    expect(prompt).toContain("## Task Purpose");
    expect(prompt).toContain('"Grand Goal"');
    expect(prompt).toContain(', which is part of the parent goal "Grand Goal"');
  });

  it("omits parent goal from task purpose when no parent", async () => {
    const goal = makeGoal({ id: "g2", title: "Standalone Goal" });
    const sm = makeMockStateManager({ "g2": goal });

    const prompt = await buildTaskGenerationPrompt(sm, "g2", "quality");

    expect(prompt).toContain("## Task Purpose");
    expect(prompt).not.toContain("which is part of the parent goal");
  });
});

describe("buildTaskGenerationPrompt — section ordering", () => {
  it("places parent chain and task purpose before adapter section", async () => {
    const parent = makeGoal({ id: "par", title: "Parent" });
    const child = makeGoal({ id: "ch", title: "Child", parent_id: "par" });
    const sm = makeMockStateManager({ "par": parent, "ch": child });

    const prompt = await buildTaskGenerationPrompt(sm, "ch", "dim", undefined, "github_issue");

    const parentChainIdx = prompt.indexOf("## Parent Goal Context");
    const taskPurposeIdx = prompt.indexOf("## Task Purpose");
    const adapterIdx = prompt.indexOf("Execution context:");

    expect(parentChainIdx).toBeGreaterThan(-1);
    expect(taskPurposeIdx).toBeGreaterThan(parentChainIdx);
    expect(adapterIdx).toBeGreaterThan(taskPurposeIdx);
  });
});

describe("buildTaskGenerationPrompt — code-agent operational KPI grounding", () => {
  it("discourages test-only tasks for operational KPI dimensions", async () => {
    const goal = makeGoal({ id: "g-kpi", title: "Stabilize resident daemon" });
    const sm = makeMockStateManager({ "g-kpi": goal });

    const prompt = await buildTaskGenerationPrompt(
      sm,
      "g-kpi",
      "resident_daemon_recovery",
      undefined,
      "openai_codex_cli"
    );

    expect(prompt).toContain("operational KPI dimensions");
    expect(prompt).toContain("do not generate a test-only/regression-only task");
    expect(prompt).toContain("include at least one relevant test/build command");
    expect(prompt).toContain("npx vitest run <test-file>");
    expect(prompt).toContain("do not wrap it in prose like \"Use rg ...\"");
  });
});

describe("buildTaskGenerationPrompt — referenced issue section", () => {
  beforeEach(() => {
    mockFetchIssueContext.mockReset();
    // Default: no issue context
    mockFetchIssueContext.mockResolvedValue("");
  });

  it("includes issue content in prompt when fetchIssueContext returns content", async () => {
    const issueContent = "## Referenced Issue #42\nTitle: Fix the regression\nSome body text here.";
    mockFetchIssueContext.mockResolvedValue(issueContent);

    const goal = makeGoal({ id: "g-issue", title: "Goal with issue ref #42" });
    const sm = makeMockStateManager({ "g-issue": goal });

    const prompt = await buildTaskGenerationPrompt(sm, "g-issue", "coverage");

    expect(prompt).toContain("## Referenced Issue #42");
    expect(prompt).toContain("Title: Fix the regression");
    expect(prompt).toContain("Some body text here.");
  });

  it("does not produce double heading when fetchIssueContext returns formatted content", async () => {
    const issueContent = "## Referenced Issue #99\nTitle: Double heading check\nBody.";
    mockFetchIssueContext.mockResolvedValue(issueContent);

    const goal = makeGoal({ id: "g-double", title: "Double heading goal #99" });
    const sm = makeMockStateManager({ "g-double": goal });

    const prompt = await buildTaskGenerationPrompt(sm, "g-double", "quality");

    // Should appear exactly once — not wrapped in an additional outer heading
    const occurrences = (prompt.match(/## Referenced Issue/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("does not include any issue section when fetchIssueContext returns empty string", async () => {
    mockFetchIssueContext.mockResolvedValue("");

    const goal = makeGoal({ id: "g-no-issue", title: "Goal without issues" });
    const sm = makeMockStateManager({ "g-no-issue": goal });

    const prompt = await buildTaskGenerationPrompt(sm, "g-no-issue", "coverage");

    expect(prompt).not.toContain("## Referenced Issue");
  });

  it("memoizes repo and issue context across repeated prompt builds", async () => {
    const goal = makeGoal({ id: "g-cache", title: "Cached prompt goal #301", description: "Confirm prompt context is reused" });
    const sm = makeMockStateManager({ "g-cache": goal });
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/tmp/pulseed-cache-test");

    try {
      const prompt1 = await buildTaskGenerationPrompt(sm, "g-cache", "coverage");

      expect(mockAccess).toHaveBeenCalledTimes(1);
      expect(mockReadFile).toHaveBeenCalledTimes(1);
      expect(mockFetchIssueContext).toHaveBeenCalledTimes(1);

      const prompt2 = await buildTaskGenerationPrompt(sm, "g-cache", "coverage");

      expect(prompt2).toBe(prompt1);
      expect(mockAccess).toHaveBeenCalledTimes(1);
      expect(mockReadFile).toHaveBeenCalledTimes(1);
      expect(mockFetchIssueContext).toHaveBeenCalledTimes(1);
    } finally {
      cwdSpy.mockRestore();
    }
  });
});

describe("buildTaskGenerationPrompt — recent failed task history", () => {
  beforeEach(() => {
    mockFetchIssueContext.mockReset();
    mockFetchIssueContext.mockResolvedValue("");
  });

  it("includes recent failed attempts to discourage repeated task generation", async () => {
    const goal = makeGoal({ id: "g-repeat", title: "Improve daemon recovery" });
    const sm = {
      loadGoal: vi.fn(async (id: string) => (id === "g-repeat" ? goal : null)),
      readRaw: vi.fn(async (key: string) => {
        if (key === "tasks/g-repeat/task-history.json") {
          return [
            {
              task_id: "task-old",
              status: "running",
              verification_verdict: "fail",
              consecutive_failure_count: 1,
              verification_evidence: ["execution failed before applying a durable recovery change"],
            },
          ];
        }
        if (key === "tasks/g-repeat/task-old.json") {
          return {
            work_description: "Add focused daemon recovery regression test",
          };
        }
        return null;
      }),
    } as unknown as StateManager;

    const prompt = await buildTaskGenerationPrompt(sm, "g-repeat", "resident_daemon_recovery");

    expect(prompt).toContain("Recent Failed/Discarded Task Attempts");
    expect(prompt).toContain("Add focused daemon recovery regression test");
    expect(prompt).toContain("execution failed before applying a durable recovery change");
    expect(prompt).toContain("Do not generate another task that repeats the same edit/test direction");
  });
});
