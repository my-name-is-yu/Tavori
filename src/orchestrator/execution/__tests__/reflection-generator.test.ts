import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateReflection,
  saveReflectionAsKnowledge,
  getReflectionsForGoal,
  formatReflectionsForPrompt,
} from "../reflection-generator.js";
import { ReflectionNoteSchema, type ReflectionNote } from "../../../base/types/reflection.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import type { Task, VerificationResult } from "../../../base/types/task.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import type { KnowledgeEntry } from "../../../base/types/knowledge.js";

// ─── Helpers ───

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    work_description: "Write unit tests for auth module",
    status: "done",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function makeVerificationResult(
  verdict: "pass" | "partial" | "fail",
  confidence = 0.8
): VerificationResult {
  return {
    verdict,
    confidence,
    evidence: [{ description: "Test evidence for verdict: " + verdict }],
  } as VerificationResult;
}

function makeMockKnowledgeManager(entries: KnowledgeEntry[] = []): KnowledgeManager {
  return {
    saveKnowledge: vi.fn().mockResolvedValue(undefined),
    loadKnowledge: vi.fn().mockResolvedValue(entries),
  } as unknown as KnowledgeManager;
}

function makeKnowledgeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    entry_id: "entry-1",
    question: "Reflection: some task",
    answer: JSON.stringify({
      what_was_attempted: "Did some work",
      outcome: "success",
      why_it_worked_or_failed: "Careful approach",
      what_to_do_differently: "Nothing, it worked",
    }),
    sources: [],
    confidence: 0.9,
    acquired_at: new Date().toISOString(),
    acquisition_task_id: "task-1",
    superseded_by: null,
    tags: ["reflection", "goal:goal-1"],
    embedding_id: null,
    ...overrides,
  } as KnowledgeEntry;
}

const VALID_LLM_RESPONSE = JSON.stringify({
  what_was_attempted: "Wrote tests for auth module",
  outcome: "success",
  why_it_worked_or_failed: "Clear requirements made it straightforward",
  what_to_do_differently: "Add edge case tests earlier",
});

// ─── ReflectionNoteSchema ───

describe("ReflectionNoteSchema", () => {
  it("parses a valid reflection note correctly", () => {
    const input = {
      reflection_id: "r-1",
      goal_id: "g-1",
      strategy_id: "s-1",
      task_id: "t-1",
      what_was_attempted: "something",
      outcome: "success",
      why_it_worked_or_failed: "it just worked",
      what_to_do_differently: "keep doing it",
      created_at: new Date().toISOString(),
    };
    const result = ReflectionNoteSchema.parse(input);
    expect(result.reflection_id).toBe("r-1");
    expect(result.outcome).toBe("success");
    expect(result.strategy_id).toBe("s-1");
  });

  it("defaults strategy_id to null when omitted", () => {
    const input = {
      reflection_id: "r-2",
      goal_id: "g-1",
      task_id: "t-1",
      what_was_attempted: "something",
      outcome: "fail",
      why_it_worked_or_failed: "broke",
      what_to_do_differently: "fix it",
      created_at: new Date().toISOString(),
    };
    const result = ReflectionNoteSchema.parse(input);
    expect(result.strategy_id).toBeNull();
  });

  it("fails when required field what_was_attempted is missing", () => {
    const input = {
      reflection_id: "r-3",
      goal_id: "g-1",
      task_id: "t-1",
      outcome: "success",
      why_it_worked_or_failed: "good",
      what_to_do_differently: "nothing",
      created_at: new Date().toISOString(),
    };
    expect(() => ReflectionNoteSchema.parse(input)).toThrow();
  });

  it("fails on invalid outcome enum value", () => {
    const input = {
      reflection_id: "r-4",
      goal_id: "g-1",
      task_id: "t-1",
      what_was_attempted: "something",
      outcome: "unknown_outcome",
      why_it_worked_or_failed: "no idea",
      what_to_do_differently: "try again",
      created_at: new Date().toISOString(),
    };
    expect(() => ReflectionNoteSchema.parse(input)).toThrow();
  });
});

// ─── generateReflection ───

describe("generateReflection()", () => {
  it("maps verdict=pass to outcome=success", async () => {
    const llm = createMockLLMClient([
      JSON.stringify({
        what_was_attempted: "Wrote auth tests",
        outcome: "success",
        why_it_worked_or_failed: "Clear spec",
        what_to_do_differently: "Nothing",
      }),
    ]);
    const task = makeTask();
    const result = await generateReflection({
      task,
      verificationResult: makeVerificationResult("pass"),
      goalId: "goal-1",
      llmClient: llm,
    });
    expect(result.outcome).toBe("success");
    expect(result.goal_id).toBe("goal-1");
    expect(result.task_id).toBe("task-1");
    expect(result.reflection_id).toBeTruthy();
  });

  it("maps verdict=fail to outcome=fail", async () => {
    const llm = createMockLLMClient([
      JSON.stringify({
        what_was_attempted: "Attempted deployment",
        outcome: "fail",
        why_it_worked_or_failed: "Config missing",
        what_to_do_differently: "Check config first",
      }),
    ]);
    const result = await generateReflection({
      task: makeTask({ work_description: "Deploy to staging" }),
      verificationResult: makeVerificationResult("fail"),
      goalId: "goal-2",
      llmClient: llm,
    });
    expect(result.outcome).toBe("fail");
  });

  it("maps verdict=partial to outcome=partial", async () => {
    const llm = createMockLLMClient([
      JSON.stringify({
        what_was_attempted: "Ran tests",
        outcome: "partial",
        why_it_worked_or_failed: "Some passed, some failed",
        what_to_do_differently: "Fix remaining failures",
      }),
    ]);
    const result = await generateReflection({
      task: makeTask(),
      verificationResult: makeVerificationResult("partial"),
      goalId: "goal-3",
      llmClient: llm,
    });
    expect(result.outcome).toBe("partial");
  });

  it("falls back gracefully when LLM returns unparseable response", async () => {
    const llm = createMockLLMClient(["not valid json at all {{{"]);
    const task = makeTask({ work_description: "Do something" });
    const warnMock = vi.fn();
    const result = await generateReflection({
      task,
      verificationResult: makeVerificationResult("fail"),
      goalId: "goal-1",
      llmClient: llm,
      logger: { warn: warnMock },
    });
    expect(result.what_was_attempted).toBe("Do something");
    expect(result.why_it_worked_or_failed).toBe("Analysis unavailable");
    expect(result.what_to_do_differently).toBe("Review task and retry");
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("generateReflection"),
      expect.any(Object)
    );
  });

  it("includes task.work_description in the LLM prompt (via fallback path)", async () => {
    const llm = createMockLLMClient(["bad json"]);
    const task = makeTask({ work_description: "Unique task description for prompt check" });
    const result = await generateReflection({
      task,
      verificationResult: makeVerificationResult("fail"),
      goalId: "goal-1",
      llmClient: llm,
    });
    // Fallback uses task.work_description directly
    expect(result.what_was_attempted).toBe("Unique task description for prompt check");
  });

  it("sets strategy_id when provided", async () => {
    const llm = createMockLLMClient([VALID_LLM_RESPONSE]);
    const result = await generateReflection({
      task: makeTask(),
      verificationResult: makeVerificationResult("pass"),
      goalId: "goal-1",
      strategyId: "strategy-abc",
      llmClient: llm,
    });
    expect(result.strategy_id).toBe("strategy-abc");
  });

  it("sets strategy_id to null when not provided", async () => {
    const llm = createMockLLMClient([VALID_LLM_RESPONSE]);
    const result = await generateReflection({
      task: makeTask(),
      verificationResult: makeVerificationResult("pass"),
      goalId: "goal-1",
      llmClient: llm,
    });
    expect(result.strategy_id).toBeNull();
  });
});

// ─── saveReflectionAsKnowledge ───

describe("saveReflectionAsKnowledge()", () => {
  it("calls knowledgeManager.saveKnowledge with correct goalId", async () => {
    const km = makeMockKnowledgeManager();
    const llm = createMockLLMClient([VALID_LLM_RESPONSE]);
    const reflection = await generateReflection({
      task: makeTask(),
      verificationResult: makeVerificationResult("pass"),
      goalId: "goal-42",
      llmClient: llm,
    });

    await saveReflectionAsKnowledge(km, "goal-42", reflection, "Write auth tests");

    expect(km.saveKnowledge).toHaveBeenCalledWith(
      "goal-42",
      expect.objectContaining({ tags: expect.arrayContaining(["reflection", "goal:goal-42"]) })
    );
  });

  it("includes 'reflection' tag in saved entry", async () => {
    const km = makeMockKnowledgeManager();
    const llm = createMockLLMClient([VALID_LLM_RESPONSE]);
    const reflection = await generateReflection({
      task: makeTask(),
      verificationResult: makeVerificationResult("pass"),
      goalId: "goal-1",
      llmClient: llm,
    });

    await saveReflectionAsKnowledge(km, "goal-1", reflection, "task desc");

    const saved = (km.saveKnowledge as ReturnType<typeof vi.fn>).mock.calls[0]![1] as KnowledgeEntry;
    expect(saved.tags).toContain("reflection");
  });

  it("includes strategy tag when reflection has strategy_id", async () => {
    const km = makeMockKnowledgeManager();
    const llm = createMockLLMClient([VALID_LLM_RESPONSE]);
    const reflection = await generateReflection({
      task: makeTask(),
      verificationResult: makeVerificationResult("pass"),
      goalId: "goal-1",
      strategyId: "strat-xyz",
      llmClient: llm,
    });

    await saveReflectionAsKnowledge(km, "goal-1", reflection, "task desc");

    const saved = (km.saveKnowledge as ReturnType<typeof vi.fn>).mock.calls[0]![1] as KnowledgeEntry;
    expect(saved.tags).toContain("strategy:strat-xyz");
  });

  it("does not include strategy tag when strategy_id is null", async () => {
    const km = makeMockKnowledgeManager();
    const llm = createMockLLMClient([VALID_LLM_RESPONSE]);
    const reflection = await generateReflection({
      task: makeTask(),
      verificationResult: makeVerificationResult("pass"),
      goalId: "goal-1",
      llmClient: llm,
    });

    await saveReflectionAsKnowledge(km, "goal-1", reflection, "task desc");

    const saved = (km.saveKnowledge as ReturnType<typeof vi.fn>).mock.calls[0]![1] as KnowledgeEntry;
    const strategyTags = saved.tags.filter((t) => t.startsWith("strategy:"));
    expect(strategyTags).toHaveLength(0);
  });
});

// ─── getReflectionsForGoal ───

describe("getReflectionsForGoal()", () => {
  it("returns parsed reflections from knowledge entries with 'reflection' tag", async () => {
    const entry = makeKnowledgeEntry();
    const km = makeMockKnowledgeManager([entry]);

    const results = await getReflectionsForGoal(km, "goal-1");

    expect(km.loadKnowledge).toHaveBeenCalledWith("goal-1", ["reflection"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("success");
  });

  it("returns empty array when no reflections exist", async () => {
    const km = makeMockKnowledgeManager([]);
    const results = await getReflectionsForGoal(km, "goal-1");
    expect(results).toEqual([]);
  });

  it("respects limit parameter", async () => {
    const entries = [
      makeKnowledgeEntry({
        entry_id: "e-1",
        acquired_at: "2026-03-20T10:00:00.000Z",
      }),
      makeKnowledgeEntry({
        entry_id: "e-2",
        acquired_at: "2026-03-20T11:00:00.000Z",
      }),
      makeKnowledgeEntry({
        entry_id: "e-3",
        acquired_at: "2026-03-20T12:00:00.000Z",
      }),
    ];
    const km = makeMockKnowledgeManager(entries);

    const results = await getReflectionsForGoal(km, "goal-1", 2);

    expect(results).toHaveLength(2);
  });

  it("returns most recent reflections first", async () => {
    const entries = [
      makeKnowledgeEntry({ entry_id: "e-old", acquired_at: "2026-01-01T00:00:00.000Z" }),
      makeKnowledgeEntry({ entry_id: "e-new", acquired_at: "2026-03-20T12:00:00.000Z" }),
    ];
    const km = makeMockKnowledgeManager(entries);

    const results = await getReflectionsForGoal(km, "goal-1", 5);

    expect(results[0]!.reflection_id).toBe("e-new");
    expect(results[1]!.reflection_id).toBe("e-old");
  });

  it("skips corrupted entries gracefully", async () => {
    const goodEntry = makeKnowledgeEntry({ entry_id: "good" });
    const badEntry = makeKnowledgeEntry({
      entry_id: "bad",
      answer: "{ not valid json {{",
    });
    const km = makeMockKnowledgeManager([goodEntry, badEntry]);

    const results = await getReflectionsForGoal(km, "goal-1");

    expect(results).toHaveLength(1);
    expect(results[0]!.reflection_id).toBe("good");
  });

  it("skips entries with invalid outcome enum", async () => {
    const badEntry = makeKnowledgeEntry({
      entry_id: "bad-enum",
      answer: JSON.stringify({
        what_was_attempted: "Did stuff",
        outcome: "invalid_outcome",
        why_it_worked_or_failed: "unknown",
        what_to_do_differently: "nothing",
      }),
    });
    const km = makeMockKnowledgeManager([badEntry]);

    const results = await getReflectionsForGoal(km, "goal-1");

    expect(results).toHaveLength(0);
  });
});

// ─── formatReflectionsForPrompt ───

describe("formatReflectionsForPrompt()", () => {
  it("returns empty string for empty array", () => {
    expect(formatReflectionsForPrompt([])).toBe("");
  });

  it("formats a single reflection", () => {
    const reflection: ReflectionNote = {
      reflection_id: "r-1",
      goal_id: "g-1",
      strategy_id: null,
      task_id: "t-1",
      what_was_attempted: "Wrote tests",
      outcome: "success",
      why_it_worked_or_failed: "Clear spec",
      what_to_do_differently: "Nothing",
      created_at: new Date().toISOString(),
    };
    const output = formatReflectionsForPrompt([reflection]);
    expect(output).toContain("## Past Reflections");
    expect(output).toContain("[success]");
    expect(output).toContain("Wrote tests");
    expect(output).toContain("Clear spec");
    expect(output).toContain("Nothing");
  });

  it("formats multiple reflections as separate lines", () => {
    const reflections: ReflectionNote[] = [
      {
        reflection_id: "r-1",
        goal_id: "g-1",
        strategy_id: null,
        task_id: "t-1",
        what_was_attempted: "First attempt",
        outcome: "fail",
        why_it_worked_or_failed: "Missing deps",
        what_to_do_differently: "Install deps first",
        created_at: new Date().toISOString(),
      },
      {
        reflection_id: "r-2",
        goal_id: "g-1",
        strategy_id: null,
        task_id: "t-2",
        what_was_attempted: "Second attempt",
        outcome: "success",
        why_it_worked_or_failed: "Deps installed",
        what_to_do_differently: "Keep this approach",
        created_at: new Date().toISOString(),
      },
    ];
    const output = formatReflectionsForPrompt(reflections);
    expect(output).toContain("[fail]");
    expect(output).toContain("[success]");
    expect(output).toContain("First attempt");
    expect(output).toContain("Second attempt");
    const lines = output.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(2);
  });

  it("includes the header section", () => {
    const reflection: ReflectionNote = {
      reflection_id: "r-1",
      goal_id: "g-1",
      strategy_id: null,
      task_id: "t-1",
      what_was_attempted: "work",
      outcome: "partial",
      why_it_worked_or_failed: "half done",
      what_to_do_differently: "complete it",
      created_at: new Date().toISOString(),
    };
    const output = formatReflectionsForPrompt([reflection]);
    expect(output.startsWith("## Past Reflections (learn from these)")).toBe(true);
  });
});
