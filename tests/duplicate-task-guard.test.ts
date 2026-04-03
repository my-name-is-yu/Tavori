import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { StrategyManager } from "../src/strategy/strategy-manager.js";
import { trigramSimilarity, generateTask } from "../src/execution/task/task-generation.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Fixtures ───

const VALID_TASK_RESPONSE = `\`\`\`json
{
  "work_description": "Add unit tests for the authentication module",
  "rationale": "Improve test coverage",
  "approach": "Use vitest",
  "success_criteria": [
    { "description": "All auth flows tested", "verification_method": "Run vitest", "is_blocking": true }
  ],
  "scope_boundary": {
    "in_scope": ["tests/auth"],
    "out_of_scope": ["src/auth"],
    "blast_radius": "tests/ only"
  },
  "constraints": [],
  "reversibility": "reversible",
  "estimated_duration": null
}
\`\`\``;

// ─── trigramSimilarity unit tests ───

describe("trigramSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(trigramSimilarity("hello world", "hello world")).toBe(1);
  });

  it("returns 0 for completely different strings", () => {
    // No shared trigrams between "abc" and "xyz"
    expect(trigramSimilarity("abc", "xyz")).toBe(0);
  });

  it("returns 1 for both empty strings", () => {
    expect(trigramSimilarity("", "")).toBe(1);
  });

  it("returns 0 when one string is empty", () => {
    expect(trigramSimilarity("hello", "")).toBe(0);
    expect(trigramSimilarity("", "hello")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(trigramSimilarity("Hello World", "hello world")).toBe(1);
  });

  it("returns a value >= 0.7 for highly similar strings", () => {
    const a = "Add unit tests for the authentication module";
    const b = "Add unit tests for authentication module";
    expect(trigramSimilarity(a, b)).toBeGreaterThanOrEqual(0.7);
  });

  it("returns a value < 0.7 for substantially different strings", () => {
    const a = "Add unit tests for the authentication module";
    const b = "Deploy the application to production environment";
    expect(trigramSimilarity(a, b)).toBeLessThan(0.7);
  });

  it("returns symmetric results (a,b) === (b,a)", () => {
    const a = "refactor the login handler";
    const b = "refactor login handler logic";
    expect(trigramSimilarity(a, b)).toBeCloseTo(trigramSimilarity(b, a), 10);
  });

  it("returns a value between 0 and 1 for partial overlap", () => {
    const sim = trigramSimilarity("the quick brown fox", "the quick red fox");
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});

// ─── Duplicate guard integration tests ───

describe("generateTask — duplicate guard (§4.2)", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(llmClient: ReturnType<typeof createMockLLMClient>) {
    const strategyManager = new StrategyManager(stateManager, llmClient);
    return { stateManager, llmClient, strategyManager };
  }

  it("returns a task when there is no task history", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
    const deps = makeDeps(llm);

    const task = await generateTask(deps, "goal-1", "test_coverage");
    expect(task).not.toBeNull();
    expect(task!.work_description).toBe("Add unit tests for the authentication module");
  });

  it("returns null when generated task is similar to a recently completed task", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
    const deps = makeDeps(llm);

    // Seed task history with a completed task that is very similar
    const history = [
      {
        id: "task-old-1",
        work_description: "Add unit tests for the authentication module",
        status: "completed",
      },
    ];
    await stateManager.writeRaw("tasks/goal-1/task-history.json", history);

    const warnMessages: string[] = [];
    const mockLogger = {
      warn: (msg: string) => { warnMessages.push(msg); },
      error: () => {},
      info: () => {},
      debug: () => {},
    };

    const task = await generateTask(
      { ...deps, logger: mockLogger as never },
      "goal-1",
      "test_coverage"
    );

    expect(task).toBeNull();
    expect(warnMessages.some((m) => m.includes("duplicate task rejected"))).toBe(true);
    expect(warnMessages.some((m) => m.includes("task-old-1"))).toBe(true);
  });

  it("returns null when generated task is similar to a recently failed task", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
    const deps = makeDeps(llm);

    const history = [
      {
        id: "task-failed-1",
        work_description: "Add unit tests for the authentication module",
        status: "failed",
      },
    ];
    await stateManager.writeRaw("tasks/goal-1/task-history.json", history);

    const task = await generateTask(deps, "goal-1", "test_coverage");
    expect(task).toBeNull();
  });

  it("does NOT reject when similar task is still pending (not completed/failed)", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
    const deps = makeDeps(llm);

    const history = [
      {
        id: "task-pending-1",
        work_description: "Add unit tests for the authentication module",
        status: "pending",
      },
    ];
    await stateManager.writeRaw("tasks/goal-1/task-history.json", history);

    const task = await generateTask(deps, "goal-1", "test_coverage");
    expect(task).not.toBeNull();
  });

  it("does NOT reject when the work description is substantially different", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
    const deps = makeDeps(llm);

    const history = [
      {
        id: "task-old-2",
        work_description: "Deploy the application to production environment with zero downtime",
        status: "completed",
      },
    ];
    await stateManager.writeRaw("tasks/goal-1/task-history.json", history);

    const task = await generateTask(deps, "goal-1", "test_coverage");
    expect(task).not.toBeNull();
  });

  it("only checks the last 10 history entries", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
    const deps = makeDeps(llm);

    // Entry at index 0 is similar but older than the last 10
    const history: Array<{ id: string; work_description: string; status: string }> = [
      {
        id: "task-old-ancient",
        work_description: "Add unit tests for the authentication module",
        status: "completed",
      },
    ];
    // Fill with 10 different recent entries
    for (let i = 0; i < 10; i++) {
      history.push({
        id: `task-recent-${i}`,
        work_description: `Deploy service ${i} to staging environment`,
        status: "completed",
      });
    }
    await stateManager.writeRaw("tasks/goal-1/task-history.json", history);

    // The ancient similar entry is beyond the last-10 window, so should NOT reject
    const task = await generateTask(deps, "goal-1", "test_coverage");
    expect(task).not.toBeNull();
  });

  it("returns a task when task-history.json does not exist", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
    const deps = makeDeps(llm);

    // No history file written
    const task = await generateTask(deps, "goal-1", "test_coverage");
    expect(task).not.toBeNull();
  });
});
