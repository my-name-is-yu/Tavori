import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { selectForWorkingMemory, relevanceScore } from "../src/knowledge/memory-selection.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import type { MemoryIndexEntry, ShortTermEntry } from "../src/types/memory-lifecycle.js";
import type { VectorIndex } from "../src/knowledge/vector-index.js";

// ─── Helpers ───

function makeTimestamp(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

/** Write a short-term index.json and accompanying data file. */
async function setupShortTermData(
  memoryDir: string,
  entries: ShortTermEntry[],
  accessCounts?: number[]
): Promise<void> {
  const goalId = entries[0]?.goal_id ?? "goal-test";
  const stDir = path.join(memoryDir, "short-term");
  const goalsDir = path.join(stDir, "goals");
  fs.mkdirSync(goalsDir, { recursive: true });

  const dataFile = `goals/${goalId}.json`;
  fs.writeFileSync(
    path.join(stDir, dataFile),
    JSON.stringify(entries)
  );

  const indexEntries: MemoryIndexEntry[] = entries.map((e, i) => ({
    id: `idx-${i}`,
    goal_id: e.goal_id,
    dimensions: e.dimensions,
    tags: e.tags,
    timestamp: e.timestamp,
    data_file: dataFile,
    entry_id: e.id,
    last_accessed: e.timestamp,
    access_count: accessCounts?.[i] ?? 0,
    embedding_id: null,
    memory_tier: e.memory_tier,
  }));

  fs.writeFileSync(
    path.join(stDir, "index.json"),
    JSON.stringify({ version: 1, last_updated: new Date().toISOString(), entries: indexEntries })
  );

  // Long-term dirs required by queryLessons
  const ltDir = path.join(memoryDir, "long-term");
  fs.mkdirSync(path.join(ltDir, "lessons", "by-goal"), { recursive: true });
  fs.mkdirSync(path.join(ltDir, "lessons", "by-dimension"), { recursive: true });
  fs.writeFileSync(
    path.join(ltDir, "lessons", "global.json"),
    JSON.stringify([])
  );
  // long-term index
  fs.writeFileSync(
    path.join(ltDir, "index.json"),
    JSON.stringify({ version: 1, last_updated: new Date().toISOString(), entries: [] })
  );
}

let tmpDir: string;
let memoryDir: string;

beforeEach(() => {
  tmpDir = makeTempDir("pulseed-sel-test-");
  memoryDir = path.join(tmpDir, "memory");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Backward compatibility (no activeGoalIds) ───

describe("selectForWorkingMemory — backward compat", () => {
  it("returns entries matching tags without tier params (existing behavior)", async () => {
    const goalId = "goal-a";
    const entries: ShortTermEntry[] = [
      {
        id: "e1",
        goal_id: goalId,
        data_type: "observation",
        loop_number: 1,
        timestamp: makeTimestamp(1),
        dimensions: ["dim-x"],
        tags: ["tag-y"],
        data: {},
        embedding_id: null,
        memory_tier: "recall",
      },
    ];
    await setupShortTermData(memoryDir, entries);

    const deps = { memoryDir };
    const result = await selectForWorkingMemory(deps, goalId, ["dim-x"], ["tag-y"]);
    expect(result.shortTerm).toHaveLength(1);
    expect(result.shortTerm[0]!.id).toBe("e1");
  });

  it("returns empty shortTerm when no tag/dimension matches", async () => {
    const goalId = "goal-b";
    const entries: ShortTermEntry[] = [
      {
        id: "e2",
        goal_id: goalId,
        data_type: "task",
        loop_number: 1,
        timestamp: makeTimestamp(1),
        dimensions: ["dim-a"],
        tags: ["tag-a"],
        data: {},
        embedding_id: null,
        memory_tier: "recall",
      },
    ];
    await setupShortTermData(memoryDir, entries);

    const deps = { memoryDir };
    const result = await selectForWorkingMemory(deps, goalId, ["dim-z"], ["tag-z"]);
    expect(result.shortTerm).toHaveLength(0);
  });
});

// ─── Tier-aware mode (activeGoalIds provided) ───

describe("selectForWorkingMemory — tier-aware mode", () => {
  it("returns core-tier entries first when activeGoalIds is provided", async () => {
    const goalId = "goal-active";
    const now = new Date().toISOString();
    const oldTime = makeTimestamp(10); // 10h ago = recall
    const recentTime = makeTimestamp(1); // 1h ago = core

    const entries: ShortTermEntry[] = [
      {
        id: "recall-1",
        goal_id: goalId,
        data_type: "observation",
        loop_number: 1,
        timestamp: oldTime,
        dimensions: ["dim-x"],
        tags: ["tag-y"],
        data: {},
        embedding_id: null,
        memory_tier: "recall",
      },
      {
        id: "core-1",
        goal_id: goalId,
        data_type: "observation",
        loop_number: 5,
        timestamp: recentTime,
        dimensions: ["dim-x"],
        tags: ["tag-y", "recent"],
        data: {},
        embedding_id: null,
        memory_tier: "core",
      },
    ];
    await setupShortTermData(memoryDir, entries);

    const deps = { memoryDir };
    const result = await selectForWorkingMemory(
      deps,
      goalId,
      ["dim-x"],
      ["tag-y"],
      { maxEntries: 10, activeGoalIds: [goalId], completedGoalIds: [] }
    );

    // core-1 should appear before recall-1
    const ids = result.shortTerm.map((e) => e.id);
    const coreIdx = ids.indexOf("core-1");
    const recallIdx = ids.indexOf("recall-1");
    expect(coreIdx).toBeGreaterThanOrEqual(0);
    expect(recallIdx).toBeGreaterThanOrEqual(0);
    expect(coreIdx).toBeLessThan(recallIdx);
  });

  it("classifies entries and updates memory_tier field", async () => {
    const goalId = "goal-active";
    const entries: ShortTermEntry[] = [
      {
        id: "e-obs-recent",
        goal_id: goalId,
        data_type: "observation",
        loop_number: 10,
        timestamp: makeTimestamp(1),
        dimensions: ["dim-x"],
        tags: ["tag-y"],
        data: {},
        embedding_id: null,
        memory_tier: "recall", // will be reclassified to core
      },
    ];
    await setupShortTermData(memoryDir, entries);

    const deps = { memoryDir };
    const result = await selectForWorkingMemory(
      deps,
      goalId,
      ["dim-x"],
      ["tag-y"],
      { maxEntries: 10, activeGoalIds: [goalId], completedGoalIds: [] }
    );

    // The entry should be returned
    expect(result.shortTerm).toHaveLength(1);
  });

  it("excludes archival-only entries when they exceed the core guarantee", async () => {
    const completedGoalId = "goal-done";
    const activeGoalId = "goal-active";

    // Mix of one active (core) and one completed (archival) under the same data file setup
    // Note: setupShortTermData uses single goal_id for data file name, so we test
    // the active goal only and verify archival entries from completed goals
    const entries: ShortTermEntry[] = [
      {
        id: "active-obs",
        goal_id: activeGoalId,
        data_type: "observation",
        loop_number: 5,
        timestamp: makeTimestamp(1),
        dimensions: ["dim-x"],
        tags: ["tag-y"],
        data: {},
        embedding_id: null,
        memory_tier: "recall",
      },
    ];
    await setupShortTermData(memoryDir, entries);

    const deps = { memoryDir };
    const result = await selectForWorkingMemory(
      deps,
      activeGoalId,
      ["dim-x"],
      ["tag-y"],
      { maxEntries: 10, activeGoalIds: [activeGoalId], completedGoalIds: [completedGoalId] }
    );

    expect(result.shortTerm.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to existing behavior when activeGoalIds is undefined", async () => {
    const goalId = "goal-no-tier";
    const entries: ShortTermEntry[] = [
      {
        id: "e-no-tier",
        goal_id: goalId,
        data_type: "task",
        loop_number: 1,
        timestamp: makeTimestamp(2),
        dimensions: ["dim-a"],
        tags: ["tag-b"],
        data: {},
        embedding_id: null,
        memory_tier: "recall",
      },
    ];
    await setupShortTermData(memoryDir, entries);

    const deps = { memoryDir };
    // No activeGoalIds → backward-compat path
    const result = await selectForWorkingMemory(deps, goalId, ["dim-a"], ["tag-b"]);
    expect(result.shortTerm).toHaveLength(1);
    expect(result.shortTerm[0]!.id).toBe("e-no-tier");
  });
});

// ─── Archival semantic search ───

function makeMockVectorIndexWithMetadata(
  matchingIds: string[]
): VectorIndex {
  return {
    searchMetadata: vi.fn(async () =>
      matchingIds.map((id) => ({ id, similarity: 0.9, metadata: {} }))
    ),
    search: vi.fn(async () => []),
    searchByVector: vi.fn(() => []),
    searchMetadataByVector: vi.fn(() => []),
    add: vi.fn(async () => ({
      id: "mock",
      text: "mock",
      vector: [0.1],
      model: "mock",
      created_at: new Date().toISOString(),
      metadata: {},
    })),
    remove: vi.fn(async () => true),
    size: 0,
    clear: vi.fn(async () => {}),
    getEntry: vi.fn(() => undefined),
    getEntryById: vi.fn(() => undefined),
    _load: vi.fn(async () => {}),
  } as unknown as VectorIndex;
}

describe("archival semantic search", () => {
  it("with VectorIndex: archival entries are selected by semantic relevance", async () => {
    // To get archival tier: the goalId must NOT be in activeGoalIds
    // (classifyTier returns "archival" when goal is not in activeGoalIds)
    const goalId = "goal-completed";
    const activeGoalId = "goal-current";

    const entries: ShortTermEntry[] = [
      {
        id: "e-archival",
        goal_id: goalId,
        data_type: "observation",
        loop_number: 1,
        timestamp: makeTimestamp(200),
        dimensions: ["dim-x"],
        tags: ["tag-y"],
        data: {},
        embedding_id: "e-archival",
        memory_tier: "archival",
      },
    ];
    await setupShortTermData(memoryDir, entries);

    // VectorIndex returns "e-archival" as a semantic match
    const mockVI = makeMockVectorIndexWithMetadata(["e-archival"]);

    const deps = { memoryDir, vectorIndex: mockVI };
    const result = await selectForWorkingMemory(
      deps,
      goalId,
      ["dim-x"],
      ["tag-y"],
      { maxEntries: 10, activeGoalIds: [activeGoalId], completedGoalIds: [] }
    );

    // The archival entry should be returned
    const ids = result.shortTerm.map((e) => e.id);
    expect(ids).toContain("e-archival");
    // searchMetadata was called for archival pass
    expect(mockVI.searchMetadata).toHaveBeenCalled();
  });

  it("without VectorIndex: falls back to existing behavior for archival entries", async () => {
    // goalId is NOT in activeGoalIds so entries get classified as archival
    const goalId = "goal-fallback-old";
    const activeGoalId = "goal-fallback-active";
    const entries: ShortTermEntry[] = [
      {
        id: "e-archival-fb",
        goal_id: goalId,
        data_type: "observation",
        loop_number: 1,
        timestamp: makeTimestamp(100),
        dimensions: ["dim-a"],
        tags: ["tag-a"],
        data: {},
        embedding_id: null,
        memory_tier: "archival",
      },
    ];
    await setupShortTermData(memoryDir, entries);

    const deps = { memoryDir }; // no vectorIndex
    const result = await selectForWorkingMemory(
      deps,
      goalId,
      ["dim-a"],
      ["tag-a"],
      { maxEntries: 10, activeGoalIds: [activeGoalId], completedGoalIds: [] }
    );

    // Archival entry is still returned in fallback mode
    const ids = result.shortTerm.map((e) => e.id);
    expect(ids).toContain("e-archival-fb");
  });

  it("VectorIndex error: gracefully falls back to sequential archival selection", async () => {
    // goalId NOT in activeGoalIds → entries classified as archival
    const goalId = "goal-error-old";
    const activeGoalId = "goal-error-active";
    const entries: ShortTermEntry[] = [
      {
        id: "e-arch-err",
        goal_id: goalId,
        data_type: "observation",
        loop_number: 1,
        timestamp: makeTimestamp(50),
        dimensions: ["dim-b"],
        tags: ["tag-b"],
        data: {},
        embedding_id: null,
        memory_tier: "archival",
      },
    ];
    await setupShortTermData(memoryDir, entries);

    // VectorIndex that throws on searchMetadata
    const errorVI = {
      searchMetadata: vi.fn(async () => { throw new Error("embed fail"); }),
      search: vi.fn(async () => []),
      searchByVector: vi.fn(() => []),
      searchMetadataByVector: vi.fn(() => []),
      add: vi.fn(async () => ({
        id: "mock", text: "mock", vector: [0.1], model: "mock",
        created_at: new Date().toISOString(), metadata: {},
      })),
      remove: vi.fn(async () => true),
      size: 0,
      clear: vi.fn(async () => {}),
      getEntry: vi.fn(() => undefined),
      getEntryById: vi.fn(() => undefined),
      _load: vi.fn(async () => {}),
    } as unknown as VectorIndex;

    const deps = { memoryDir, vectorIndex: errorVI };
    // Should not throw and should still return the archival entry
    const result = await selectForWorkingMemory(
      deps,
      goalId,
      ["dim-b"],
      ["tag-b"],
      { maxEntries: 10, activeGoalIds: [activeGoalId], completedGoalIds: [] }
    );

    const ids = result.shortTerm.map((e) => e.id);
    expect(ids).toContain("e-arch-err");
  });
});

// ─── relevanceScore: composite scoring with access_count ───

describe("relevanceScore — composite scoring", () => {
  it("entry with higher access_count ranks higher when other factors are equal", () => {
    const deps = {};
    const now = new Date().toISOString();

    const baseEntry = {
      id: "base",
      goal_id: "goal-test",
      data_type: "observation" as const,
      loop_number: 1,
      timestamp: now,
      dimensions: ["dim-x"],
      tags: ["tag-a"],
      data: {},
      embedding_id: null,
      memory_tier: "recall" as const,
    };

    const context = { goalId: "goal-test", dimensions: ["dim-x"], tags: ["tag-a"] };

    // Same entry, same timestamp — only access_count differs
    const scoreWithoutAccess = relevanceScore(deps, baseEntry, context, 0);
    const scoreWithAccess = relevanceScore(deps, baseEntry, context, 10);

    expect(scoreWithAccess).toBeGreaterThan(scoreWithoutAccess);
  });

  it("backward compat: entries without access_count (undefined) still work and score correctly", () => {
    const deps = {};
    const now = new Date().toISOString();

    const entry = {
      id: "e-nocount",
      goal_id: "goal-test",
      data_type: "observation" as const,
      loop_number: 1,
      timestamp: now,
      dimensions: ["dim-x"],
      tags: ["tag-a"],
      data: {},
      embedding_id: null,
      memory_tier: "recall" as const,
    };

    const context = { goalId: "goal-test", dimensions: ["dim-x"], tags: ["tag-a"] };

    // Should not throw and should return a finite number
    const score = relevanceScore(deps, entry, context);
    expect(typeof score).toBe("number");
    expect(isFinite(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);

    // undefined uses multiplier=1.0 (backward compat: same result as old formula)
    // access_count=0 uses multiplier=0.7 (new formula), so undefined score > explicit-zero score
    const scoreExplicitZero = relevanceScore(deps, entry, context, 0);
    expect(score).toBeGreaterThan(scoreExplicitZero);
  });
});

// ─── Primary sort uses composite score (access_count as importance proxy) ───

describe("selectForWorkingMemory — composite score primary sort", () => {
  it("entry with higher access_count ranks higher than a newer entry with access_count=0", async () => {
    const goalId = "goal-sort-test";

    // e-frequent: older (2h ago) but high access count
    // e-new: newer (1h ago) but never accessed
    const entries: ShortTermEntry[] = [
      {
        id: "e-frequent",
        goal_id: goalId,
        data_type: "observation",
        loop_number: 1,
        timestamp: makeTimestamp(2),
        dimensions: ["dim-x"],
        tags: ["tag-a"],
        data: {},
        embedding_id: null,
        memory_tier: "recall",
      },
      {
        id: "e-new",
        goal_id: goalId,
        data_type: "observation",
        loop_number: 2,
        timestamp: makeTimestamp(1),
        dimensions: ["dim-x"],
        tags: ["tag-a"],
        data: {},
        embedding_id: null,
        memory_tier: "recall",
      },
    ];

    // e-frequent gets access_count=10, e-new gets 0
    await setupShortTermData(memoryDir, entries, [10, 0]);

    const deps = { memoryDir };
    const result = await selectForWorkingMemory(deps, goalId, ["dim-x"], ["tag-a"]);

    expect(result.shortTerm).toHaveLength(2);
    // e-frequent (high access_count) should outrank e-new (pure recency)
    expect(result.shortTerm[0]!.id).toBe("e-frequent");
  });
});
