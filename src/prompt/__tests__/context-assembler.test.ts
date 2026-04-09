import { describe, it, expect, vi } from "vitest";
import { ContextAssembler } from "../context-assembler.js";
import type { ContextAssemblerDeps, ContextAssemblerGoalState } from "../context-assembler.js";

type TestLesson = NonNullable<Awaited<ReturnType<NonNullable<ContextAssemblerDeps["memoryLifecycle"]>["selectForWorkingMemory"]>>["lessons"]>[number];

const makeGoalState = (overrides: Partial<ContextAssemblerGoalState> = {}): ContextAssemblerGoalState & { id: string } => ({
  id: "goal-1",
  title: "Increase test coverage",
  description: "Get to 90% coverage",
  dimensions: [
    {
      name: "coverage",
      current_value: 75,
      threshold: { value: 90 },
      gap: 15,
      history: [
        { timestamp: "2026-01-01", value: 70 },
        { timestamp: "2026-01-02", value: 75 },
      ],
    },
  ],
  active_strategy: { hypothesis: "Add unit tests for uncovered files" },
  ...overrides,
});

describe("ContextAssembler", () => {
  describe("build() with no deps", () => {
    it("returns empty context block when no dependencies are injected", async () => {
      const assembler = new ContextAssembler({});
      const result = await assembler.build("observation", "goal-1");
      expect(result.contextBlock).toBe("");
      expect(result.totalTokensUsed).toBe(0);
    });

    it("returns empty systemPrompt (gateway uses PURPOSE_CONFIGS instead)", async () => {
      const assembler = new ContextAssembler({});
      const result = await assembler.build("observation", "goal-1");
      expect(result.systemPrompt).toBe("");
    });
  });

  describe("build() with stateManager", () => {
    it("includes goal_context when stateManager resolves goal state", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("observation", "goal-1");
      expect(result.contextBlock).toContain("goal_definition");
      expect(result.contextBlock).toContain("Increase test coverage");
    });

    it("includes current_state block with dimension data", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("observation", "goal-1");
      expect(result.contextBlock).toContain("current_state");
      expect(result.contextBlock).toContain("coverage");
      expect(result.contextBlock).toContain("75");
    });

    it("handles stateManager returning null gracefully", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(null),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("observation", "goal-1");
      expect(result.contextBlock).toBe("");
    });
  });

  describe("build() for observation purpose", () => {
    it("includes dimension_history when goal has history", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("observation", "goal-1");
      expect(result.contextBlock).toContain("dimension_history");
    });

    it("includes workspace_state when contextProvider is available", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        contextProvider: {
          buildWorkspaceContextItems: vi.fn().mockResolvedValue([
            { label: "file", content: "src/index.ts" },
          ]),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("observation", "goal-1");
      expect(result.contextBlock).toContain("workspace_state");
      expect(result.contextBlock).toContain("src/index.ts");
    });

    it("does not include lessons slot for observation", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        memoryLifecycle: {
          selectForWorkingMemory: vi.fn().mockResolvedValue({
            shortTerm: [],
            lessons: [{ lesson: "Important lesson", relevance_tags: ["HIGH"] }],
          }),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("observation", "goal-1");
      // observation slot matrix does not include 'lessons'
      expect(result.contextBlock).not.toContain("<lessons>");
    });
  });

  describe("build() for task_generation purpose", () => {
    it("includes reflections when reflectionGetter returns data", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        reflectionGetter: vi.fn().mockResolvedValue([
          {
            why_it_worked_or_failed: "Wrong approach",
            what_to_do_differently: "Use mocks",
            what_was_attempted: "Direct integration",
          },
        ]),
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("task_generation", "goal-1");
      expect(result.contextBlock).toContain("reflections");
      expect(result.contextBlock).toContain("Wrong approach");
    });

    it("includes lessons when memoryLifecycle returns lessons", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        memoryLifecycle: {
          selectForWorkingMemory: vi.fn().mockResolvedValue({
            shortTerm: [],
            lessons: [{ lesson: "Use vi.fn()", relevance_tags: ["HIGH"] }],
          }),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("task_generation", "goal-1");
      expect(result.contextBlock).toContain("lessons");
      expect(result.contextBlock).toContain("Use vi.fn()");
    });

    it("includes knowledge when knowledgeManager returns entries", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        knowledgeManager: {
          getRelevantKnowledge: vi.fn().mockResolvedValue([
            { question: "How?", answer: "Like this." },
          ]),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("task_generation", "goal-1");
      expect(result.contextBlock).toContain("knowledge");
      expect(result.contextBlock).toContain("How?");
    });

    it("includes failure_context from additionalContext", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("task_generation", "goal-1", undefined, {
        failureContext: "Previous attempt timed out",
      });
      expect(result.contextBlock).toContain("failure_context");
      expect(result.contextBlock).toContain("Previous attempt timed out");
    });
  });

  describe("budget trimming", () => {
    it("does not exceed token budget when budget is tight", async () => {
      const goalState = makeGoalState({
        description: "x".repeat(500),
      });
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(goalState),
        },
        budgetTokens: 50,
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("observation", "goal-1");
      // totalTokensUsed should be at or near the budget
      expect(result.totalTokensUsed).toBeLessThanOrEqual(60);
    });

    it("returns all slots when budget is large enough", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        budgetTokens: 10000,
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("observation", "goal-1");
      expect(result.contextBlock).toContain("goal_definition");
      expect(result.contextBlock).toContain("current_state");
    });
  });

  describe("context rot prevention — lesson stale filtering", () => {
    const makeLesson = (overrides: Partial<TestLesson> = {}): TestLesson => ({
      lesson: "Some lesson",
      relevance_tags: ["MEDIUM"],
      last_accessed: new Date().toISOString(),
      access_count: 5,
      ...overrides,
    });

    it("filters out stale lessons (older than 14 days AND access_count < 2) when there are more than budgeted entries", async () => {
      const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(); // 20 days ago
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        memoryLifecycle: {
          selectForWorkingMemory: vi.fn().mockResolvedValue({
            shortTerm: [],
            lessons: [
              makeLesson({ lesson: "Fresh lesson A", last_accessed: new Date().toISOString(), access_count: 3 }),
              makeLesson({ lesson: "Fresh lesson B", last_accessed: new Date().toISOString(), access_count: 1 }),
              makeLesson({ lesson: "Fresh lesson C", last_accessed: new Date().toISOString(), access_count: 4 }),
              makeLesson({ lesson: "Fresh lesson D", last_accessed: new Date().toISOString(), access_count: 2 }),
              makeLesson({ lesson: "Fresh lesson E", last_accessed: new Date().toISOString(), access_count: 5 }),
              makeLesson({ lesson: "Stale and rarely used", last_accessed: oldDate, access_count: 1 }),
            ],
          }),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("task_generation", "goal-1");
      expect(result.contextBlock).not.toContain("Stale and rarely used");
      expect(result.contextBlock).toContain("Fresh lesson A");
    });

    it("keeps stale lessons if they have high access_count (>= 2)", async () => {
      const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        memoryLifecycle: {
          selectForWorkingMemory: vi.fn().mockResolvedValue({
            shortTerm: [],
            lessons: [
              makeLesson({ lesson: "Fresh A" }),
              makeLesson({ lesson: "Fresh B" }),
              makeLesson({ lesson: "Fresh C" }),
              makeLesson({ lesson: "Fresh D" }),
              makeLesson({ lesson: "Fresh E" }),
              makeLesson({ lesson: "Old but used frequently", last_accessed: oldDate, access_count: 5 }),
            ],
          }),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("task_generation", "goal-1");
      expect(result.contextBlock).toContain("Old but used frequently");
    });

    it("keeps entries within the freshness window regardless of access_count", async () => {
      const recentDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days ago
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        memoryLifecycle: {
          selectForWorkingMemory: vi.fn().mockResolvedValue({
            shortTerm: [],
            lessons: [
              makeLesson({ lesson: "A" }),
              makeLesson({ lesson: "B" }),
              makeLesson({ lesson: "C" }),
              makeLesson({ lesson: "D" }),
              makeLesson({ lesson: "E" }),
              makeLesson({ lesson: "Recent but rarely accessed", last_accessed: recentDate, access_count: 0 }),
            ],
          }),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("task_generation", "goal-1");
      expect(result.contextBlock).toContain("Recent but rarely accessed");
    });

    it("does not filter when lessons count is at or below budget threshold", async () => {
      const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        memoryLifecycle: {
          selectForWorkingMemory: vi.fn().mockResolvedValue({
            shortTerm: [],
            lessons: [
              makeLesson({ lesson: "Stale rarely used", last_accessed: oldDate, access_count: 0 }),
            ],
          }),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("task_generation", "goal-1");
      // Only 1 lesson, within budget of 5, so no filtering applied
      expect(result.contextBlock).toContain("Stale rarely used");
    });
  });

  describe("context rot prevention — knowledge similarity threshold", () => {
    it("uses a 0.6 similarity threshold for vector knowledge search", async () => {
      const mockSearch = vi.fn().mockResolvedValue([]);
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        vectorIndex: {
          search: mockSearch,
        },
      };
      const assembler = new ContextAssembler(deps);
      await assembler.build("task_generation", "goal-1");
      expect(mockSearch).toHaveBeenCalledWith(expect.anything(), 5, 0.6);
    });
  });

  describe("context rot prevention — strategy template recency", () => {
    it("deprioritizes strategy templates older than 30 days when no vector index", async () => {
      const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        strategyTemplateSearch: vi.fn().mockResolvedValue([
          { hypothesis_pattern: "fresh-pattern", effectiveness_score: 0.9, created_at: new Date().toISOString() },
          { hypothesis_pattern: "old-pattern", effectiveness_score: 0.8, created_at: oldDate },
        ]),
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("strategy_generation", "goal-1");
      // Fresh template should appear, old should be filtered
      expect(result.contextBlock).toContain("fresh-pattern");
      expect(result.contextBlock).not.toContain("old-pattern");
    });

    it("falls back to all templates if all are old (no fresh ones)", async () => {
      const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        strategyTemplateSearch: vi.fn().mockResolvedValue([
          { hypothesis_pattern: "old-pattern-1", effectiveness_score: 0.8, created_at: oldDate },
          { hypothesis_pattern: "old-pattern-2", effectiveness_score: 0.7, created_at: oldDate },
        ]),
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("strategy_generation", "goal-1");
      // Both are old, but fallback keeps them
      expect(result.contextBlock).toContain("old-pattern-1");
    });
  });

  describe("additionalContext usage", () => {
    it("uses existingTasks from additionalContext for recent_task_results", async () => {
      const tasks = [
        { task_description: "Write test", outcome: "passed", success: true },
      ];
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("task_generation", "goal-1", undefined, {
        existingTasks: JSON.stringify(tasks),
      });
      expect(result.contextBlock).toContain("recent_task_results");
      expect(result.contextBlock).toContain("Write test");
    });
  });
});
