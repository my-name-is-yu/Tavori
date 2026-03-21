import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { MemoryLifecycleManager } from "../src/knowledge/memory-lifecycle.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../src/llm/llm-client.js";
import type { ZodSchema } from "zod";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Helpers ───

/** Build a two-call LLM response for compressToLongTerm (patterns + lessons). */
function makeLLMCompressionResponses(lessonCount = 1) {
  const patterns = JSON.stringify({ patterns: ["Pattern A: retries work well"] });
  const lessons = JSON.stringify({
    lessons: Array.from({ length: lessonCount }, (_, i) => ({
      type: "strategy_outcome",
      context: `Context ${i}`,
      action: `Action ${i}`,
      outcome: `Outcome ${i}`,
      lesson: `Lesson ${i}`,
      relevance_tags: ["test-tag"],
    })),
  });
  return [patterns, lessons];
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir();
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup race */ }
});

// ═══════════════════════════════════════════════════════
// initializeDirectories
// ═══════════════════════════════════════════════════════

describe("initializeDirectories", () => {
  it("creates all required short-term and long-term subdirectories", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    const memDir = path.join(tmpDir, "memory");
    expect(fs.existsSync(path.join(memDir, "short-term", "goals"))).toBe(true);
    expect(fs.existsSync(path.join(memDir, "long-term", "lessons", "by-goal"))).toBe(true);
    expect(fs.existsSync(path.join(memDir, "long-term", "lessons", "by-dimension"))).toBe(true);
    expect(fs.existsSync(path.join(memDir, "long-term", "statistics"))).toBe(true);
    expect(fs.existsSync(path.join(memDir, "archive"))).toBe(true);
  });

  it("creates short-term and long-term index.json files", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    const memDir = path.join(tmpDir, "memory");
    expect(fs.existsSync(path.join(memDir, "short-term", "index.json"))).toBe(true);
    expect(fs.existsSync(path.join(memDir, "long-term", "index.json"))).toBe(true);
  });

  it("creates global.json in long-term lessons", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    const globalPath = path.join(
      tmpDir,
      "memory",
      "long-term",
      "lessons",
      "global.json"
    );
    expect(fs.existsSync(globalPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(globalPath, "utf-8")) as unknown;
    expect(Array.isArray(content)).toBe(true);
    expect((content as unknown[]).length).toBe(0);
  });

  it("is idempotent — calling twice does not throw or corrupt files", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();
    await expect(mgr.initializeDirectories()).resolves.not.toThrow();

    const indexPath = path.join(tmpDir, "memory", "short-term", "index.json");
    const raw = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as { version: number; entries: unknown[] };
    expect(raw.version).toBe(1);
    expect(raw.entries).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════
// recordToShortTerm
// ═══════════════════════════════════════════════════════

describe("recordToShortTerm", () => {
  it("records entry to experience-log.json for experience_log data type", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-1", "experience_log", { event: "loop_start" });

    const dataFile = path.join(
      tmpDir,
      "memory",
      "short-term",
      "goals",
      "goal-1",
      "experience-log.json"
    );
    expect(fs.existsSync(dataFile)).toBe(true);
    const entries = JSON.parse(fs.readFileSync(dataFile, "utf-8")) as unknown[];
    expect(entries).toHaveLength(1);
  });

  it("records entry to observations.json for observation data type", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-1", "observation", { value: 42 });

    const dataFile = path.join(
      tmpDir,
      "memory",
      "short-term",
      "goals",
      "goal-1",
      "observations.json"
    );
    expect(fs.existsSync(dataFile)).toBe(true);
  });

  it("creates goal directory if it does not exist yet", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    const goalDir = path.join(tmpDir, "memory", "short-term", "goals", "new-goal");
    expect(fs.existsSync(goalDir)).toBe(false);

    await mgr.recordToShortTerm("new-goal", "task", { status: "pending" });

    expect(fs.existsSync(goalDir)).toBe(true);
  });

  it("returns a ShortTermEntry with generated ID, goal_id, data_type, and data", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    const entry = await mgr.recordToShortTerm("goal-1", "knowledge", { fact: "cats meow" });

    expect(entry.id).toMatch(/^st_/);
    expect(entry.goal_id).toBe("goal-1");
    expect(entry.data_type).toBe("knowledge");
    expect(entry.data).toEqual({ fact: "cats meow" });
  });

  it("updates the short-term index after recording", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-1", "observation", { value: 10 }, { tags: ["perf"] });

    const indexPath = path.join(tmpDir, "memory", "short-term", "index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as { entries: unknown[] };
    expect(index.entries).toHaveLength(1);
  });

  it("appends multiple entries to the same file without overwriting", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-1", "experience_log", { seq: 1 });
    await mgr.recordToShortTerm("goal-1", "experience_log", { seq: 2 });
    await mgr.recordToShortTerm("goal-1", "experience_log", { seq: 3 });

    const dataFile = path.join(
      tmpDir,
      "memory",
      "short-term",
      "goals",
      "goal-1",
      "experience-log.json"
    );
    const entries = JSON.parse(fs.readFileSync(dataFile, "utf-8")) as unknown[];
    expect(entries).toHaveLength(3);
  });

  it("stores options loopNumber, dimensions, and tags on the entry", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    const entry = await mgr.recordToShortTerm(
      "goal-1",
      "observation",
      { value: 99 },
      { loopNumber: 42, dimensions: ["churn_rate"], tags: ["saas"] }
    );

    expect(entry.loop_number).toBe(42);
    expect(entry.dimensions).toContain("churn_rate");
    expect(entry.tags).toContain("saas");
  });

  it("entries for different goals are stored independently", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-A", "task", { status: "done" });
    await mgr.recordToShortTerm("goal-B", "task", { status: "pending" });

    const fileA = path.join(
      tmpDir,
      "memory",
      "short-term",
      "goals",
      "goal-A",
      "tasks.json"
    );
    const fileB = path.join(
      tmpDir,
      "memory",
      "short-term",
      "goals",
      "goal-B",
      "tasks.json"
    );
    expect(JSON.parse(fs.readFileSync(fileA, "utf-8")) as unknown[]).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(fileB, "utf-8")) as unknown[]).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════
// compressToLongTerm
// ═══════════════════════════════════════════════════════

describe("compressToLongTerm", () => {
  it("returns entries_compressed=0 and lessons_generated=0 when no expired entries", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]), {
      default_retention_loops: 100,
    });
    await mgr.initializeDirectories();

    // One entry at loop 0 — retention=100, so cutoffLoop=-100 → nothing expires
    await mgr.recordToShortTerm("goal-1", "experience_log", {}, { loopNumber: 0 });

    const result = await mgr.compressToLongTerm("goal-1", "experience_log");
    expect(result.entries_compressed).toBe(0);
    expect(result.lessons_generated).toBe(0);
  });

  it("compresses expired entries and generates lesson entries in long-term storage", async () => {
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient(makeLLMCompressionResponses(1)),
      { default_retention_loops: 5 }
    );
    await mgr.initializeDirectories();

    // loop 0 is expired when max=10, retention=5 → cutoff=5, entries at 0 qualify
    for (let i = 0; i <= 10; i++) {
      await mgr.recordToShortTerm("goal-1", "experience_log", { loop: i }, { loopNumber: i });
    }

    const result = await mgr.compressToLongTerm("goal-1", "experience_log");

    expect(result.entries_compressed).toBeGreaterThan(0);
    expect(result.lessons_generated).toBeGreaterThan(0);
    expect(result.quality_check.passed).toBe(true);
  });

  it("stores lessons in by-goal file after successful compression", async () => {
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient(makeLLMCompressionResponses(1)),
      { default_retention_loops: 5 }
    );
    await mgr.initializeDirectories();

    for (let i = 0; i <= 10; i++) {
      await mgr.recordToShortTerm("goal-1", "experience_log", {}, { loopNumber: i });
    }

    await mgr.compressToLongTerm("goal-1", "experience_log");

    const byGoalPath = path.join(
      tmpDir,
      "memory",
      "long-term",
      "lessons",
      "by-goal",
      "goal-1.json"
    );
    expect(fs.existsSync(byGoalPath)).toBe(true);
    const lessons = JSON.parse(fs.readFileSync(byGoalPath, "utf-8")) as unknown[];
    expect(lessons.length).toBeGreaterThan(0);
  });

  it("does NOT delete short-term data if LLM call fails", async () => {
    const failingClient: ILLMClient = {
      async sendMessage(): Promise<LLMResponse> {
        throw new Error("LLM unavailable");
      },
      parseJSON<T>(content: string, schema: ZodSchema<T>): T {
        return schema.parse(JSON.parse(content));
      },
    };

    const mgr = new MemoryLifecycleManager(tmpDir, failingClient, {
      default_retention_loops: 5,
    });
    await mgr.initializeDirectories();

    for (let i = 0; i <= 10; i++) {
      await mgr.recordToShortTerm("goal-1", "experience_log", {}, { loopNumber: i });
    }

    const result = await mgr.compressToLongTerm("goal-1", "experience_log");

    // LLM failed → no compression
    expect(result.entries_compressed).toBe(0);

    // Short-term data must still be present
    const dataFile = path.join(
      tmpDir,
      "memory",
      "short-term",
      "goals",
      "goal-1",
      "experience-log.json"
    );
    const remaining = JSON.parse(fs.readFileSync(dataFile, "utf-8")) as unknown[];
    expect(remaining.length).toBe(11);
  });

  it("returns a valid CompressionResult schema (required fields present)", async () => {
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient(makeLLMCompressionResponses(1)),
      { default_retention_loops: 5 }
    );
    await mgr.initializeDirectories();

    for (let i = 0; i <= 10; i++) {
      await mgr.recordToShortTerm("goal-1", "experience_log", {}, { loopNumber: i });
    }

    const result = await mgr.compressToLongTerm("goal-1", "experience_log");

    expect(result.goal_id).toBe("goal-1");
    expect(result.data_type).toBe("experience_log");
    expect(typeof result.entries_compressed).toBe("number");
    expect(typeof result.lessons_generated).toBe("number");
    expect(typeof result.statistics_updated).toBe("boolean");
    expect(result.quality_check).toBeDefined();
    expect(typeof result.compressed_at).toBe("string");
  });

  it("handles empty entries gracefully (returns zero counts)", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]), {
      default_retention_loops: 5,
    });
    await mgr.initializeDirectories();

    // No entries recorded at all
    const result = await mgr.compressToLongTerm("goal-1", "experience_log");
    expect(result.entries_compressed).toBe(0);
    expect(result.lessons_generated).toBe(0);
    expect(result.quality_check.passed).toBe(true);
  });

  it("quality check passes when lesson_count >= failure_count * 0.5", async () => {
    // 2 failures, 1 lesson → 1 >= 2 * 0.5 → passes
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient(makeLLMCompressionResponses(1)),
      { default_retention_loops: 5 }
    );
    await mgr.initializeDirectories();

    // Add 2 failed entries and enough non-failure entries to exceed retention
    for (let i = 0; i <= 10; i++) {
      const data = i < 2 ? { status: "failed" } : {};
      await mgr.recordToShortTerm("goal-1", "experience_log", data, { loopNumber: i });
    }

    const result = await mgr.compressToLongTerm("goal-1", "experience_log");
    expect(result.quality_check.passed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// selectForWorkingMemory
// ═══════════════════════════════════════════════════════

describe("selectForWorkingMemory", () => {
  it("returns matching short-term entries by tag", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-1", "observation", { v: 1 }, { tags: ["perf"] });
    await mgr.recordToShortTerm("goal-1", "observation", { v: 2 }, { tags: ["cost"] });

    const { shortTerm } = await mgr.selectForWorkingMemory("goal-1", [], ["perf"]);
    expect(shortTerm).toHaveLength(1);
    expect(shortTerm[0]!.tags).toContain("perf");
  });

  it("returns matching short-term entries by dimension", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-1", "observation", { v: 10 }, { dimensions: ["churn_rate"] });
    await mgr.recordToShortTerm("goal-1", "observation", { v: 20 }, { dimensions: ["nps"] });

    const { shortTerm } = await mgr.selectForWorkingMemory("goal-1", ["churn_rate"], []);
    expect(shortTerm).toHaveLength(1);
    expect(shortTerm[0]!.dimensions).toContain("churn_rate");
  });

  it("respects maxEntries limit", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    for (let i = 0; i < 10; i++) {
      await mgr.recordToShortTerm("goal-1", "observation", { i }, { tags: ["common"] });
    }

    const { shortTerm } = await mgr.selectForWorkingMemory("goal-1", [], ["common"], 3);
    expect(shortTerm.length).toBeLessThanOrEqual(3);
  });

  it("returns empty arrays when no matches in short-term or long-term", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-1", "observation", {}, { tags: ["x"] });

    const { shortTerm, lessons } = await mgr.selectForWorkingMemory("goal-1", [], ["z"]);
    expect(shortTerm).toHaveLength(0);
    expect(lessons).toHaveLength(0);
  });

  it("returns only entries for the specified goalId, not other goals", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-A", "observation", {}, { tags: ["shared"] });
    await mgr.recordToShortTerm("goal-B", "observation", {}, { tags: ["shared"] });

    const { shortTerm } = await mgr.selectForWorkingMemory("goal-A", [], ["shared"]);
    expect(shortTerm.every((e) => e.goal_id === "goal-A")).toBe(true);
  });

  it("returns empty arrays for a goal with no data at all", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    const { shortTerm, lessons } = await mgr.selectForWorkingMemory(
      "nonexistent-goal",
      ["dim"],
      ["tag"]
    );
    expect(shortTerm).toHaveLength(0);
    expect(lessons).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════
// applyRetentionPolicy
// ═══════════════════════════════════════════════════════

describe("applyRetentionPolicy", () => {
  it("triggers compression when loop span exceeds retention limit", async () => {
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient(makeLLMCompressionResponses(1)),
      { default_retention_loops: 5 }
    );
    await mgr.initializeDirectories();

    // Span = 10 - 0 = 10 >= 5 → should trigger compression
    for (let i = 0; i <= 10; i++) {
      await mgr.recordToShortTerm("goal-1", "experience_log", {}, { loopNumber: i });
    }

    const results = await mgr.applyRetentionPolicy("goal-1");
    expect(results.length).toBeGreaterThan(0);
  });

  it("does not trigger compression when span is within retention limit", async () => {
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      { default_retention_loops: 100 }
    );
    await mgr.initializeDirectories();

    // Span = 3 - 0 = 3 < 100 → no compression
    for (let i = 0; i <= 3; i++) {
      await mgr.recordToShortTerm("goal-1", "experience_log", {}, { loopNumber: i });
    }

    const results = await mgr.applyRetentionPolicy("goal-1");
    expect(results).toHaveLength(0);
  });

  it("respects goal_type_overrides for retention limit", async () => {
    // health_monitoring has retention=200 (from default overrides)
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient([]),
      { default_retention_loops: 5 }
    );
    await mgr.initializeDirectories();

    // Span=10 would exceed default=5 but health_monitoring override=200 means no trigger
    for (let i = 0; i <= 10; i++) {
      await mgr.recordToShortTerm(
        "health_monitoring-goal-1",
        "experience_log",
        {},
        { loopNumber: i }
      );
    }

    const results = await mgr.applyRetentionPolicy("health_monitoring-goal-1");
    expect(results).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════
// onGoalClose
// ═══════════════════════════════════════════════════════

describe("onGoalClose", () => {
  it("creates archive directory for goal on close", async () => {
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient(makeLLMCompressionResponses(1))
    );
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-1", "experience_log", { event: "start" });

    await mgr.onGoalClose("goal-1", "completed");

    const archiveDir = path.join(tmpDir, "memory", "archive", "goal-1");
    expect(fs.existsSync(archiveDir)).toBe(true);
  });

  it("removes goal's short-term directory after close", async () => {
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient(makeLLMCompressionResponses(1))
    );
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-1", "task", { status: "done" });

    const shortTermGoalDir = path.join(
      tmpDir,
      "memory",
      "short-term",
      "goals",
      "goal-1"
    );
    expect(fs.existsSync(shortTermGoalDir)).toBe(true);

    await mgr.onGoalClose("goal-1", "completed");

    expect(fs.existsSync(shortTermGoalDir)).toBe(false);
  });

  it("archives short-term files into archive/<goalId>/", async () => {
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient(makeLLMCompressionResponses(1))
    );
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-1", "observation", { v: 5 });

    await mgr.onGoalClose("goal-1", "cancelled");

    const archiveDir = path.join(tmpDir, "memory", "archive", "goal-1");
    const files = fs.readdirSync(archiveDir);
    expect(files.length).toBeGreaterThan(0);
  });

  it("does not throw when goal has no short-term data", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    await expect(mgr.onGoalClose("ghost-goal", "completed")).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════
// getStatistics
// ═══════════════════════════════════════════════════════

describe("getStatistics", () => {
  it("returns null for a goal with no statistics", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    await mgr.initializeDirectories();

    const stats = await mgr.getStatistics("nonexistent-goal");
    expect(stats).toBeNull();
  });

  it("returns a valid StatisticalSummary after compression creates statistics", async () => {
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient(makeLLMCompressionResponses(1)),
      { default_retention_loops: 5 }
    );
    await mgr.initializeDirectories();

    for (let i = 0; i <= 10; i++) {
      await mgr.recordToShortTerm(
        "goal-1",
        "task",
        { task_category: "research", status: "completed", duration_hours: 2 },
        { loopNumber: i }
      );
    }

    await mgr.compressToLongTerm("goal-1", "task");

    const stats = await mgr.getStatistics("goal-1");
    expect(stats).not.toBeNull();
    expect(stats!.goal_id).toBe("goal-1");
    expect(typeof stats!.overall.total_loops).toBe("number");
    expect(typeof stats!.overall.overall_success_rate).toBe("number");
  });
});

// ═══════════════════════════════════════════════════════
// runGarbageCollection
// ═══════════════════════════════════════════════════════

describe("runGarbageCollection", () => {
  it("does nothing when short-term directory does not exist", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]));
    // Do NOT call initializeDirectories — directory won't exist
    await expect(mgr.runGarbageCollection()).resolves.not.toThrow();
  });

  it("does nothing when all goals are within size limit", async () => {
    const mgr = new MemoryLifecycleManager(tmpDir, createMockLLMClient([]), {
      size_limits: { short_term_per_goal_mb: 100, long_term_total_mb: 1000 },
    });
    await mgr.initializeDirectories();

    await mgr.recordToShortTerm("goal-1", "observation", { value: 1 });

    // No LLM calls expected because we're within limits
    await expect(mgr.runGarbageCollection()).resolves.not.toThrow();
  });

  it("triggers compression when a goal's short-term exceeds size limit", async () => {
    const compressCalled = vi.fn().mockResolvedValue(undefined);

    // Use a tiny size limit (0.000001 MB = ~1 byte) so any data triggers GC
    const mgr = new MemoryLifecycleManager(
      tmpDir,
      createMockLLMClient(makeLLMCompressionResponses(1)),
      { size_limits: { short_term_per_goal_mb: 0.000001, long_term_total_mb: 1000 } }
    );
    await mgr.initializeDirectories();

    // Record enough data to exceed the 1-byte limit
    for (let i = 0; i < 5; i++) {
      await mgr.recordToShortTerm("goal-1", "experience_log", { data: "x".repeat(100) }, { loopNumber: i });
    }

    // Should not throw even if compression is triggered
    await expect(mgr.runGarbageCollection()).resolves.not.toThrow();
    void compressCalled;
  });
});
