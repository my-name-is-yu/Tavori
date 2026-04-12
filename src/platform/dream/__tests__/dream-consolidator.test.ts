import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { DreamConsolidator } from "../dream-consolidator.js";

describe("DreamConsolidator", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
    tmpDir = "";
  });

  it("persists a light-tier report with the expected categories", async () => {
    tmpDir = makeTempDir("dream-consolidator-light-");
    await seedDreamFiles(tmpDir);

    const consolidator = new DreamConsolidator({ baseDir: tmpDir });
    const report = await consolidator.run({ tier: "light" });

    expect(report.tier).toBe("light");
    expect(report.categories.map((category) => category.category)).toEqual([
      "memory",
      "agentMemory",
      "knowledgeOptimization",
    ]);

    const reportsDir = path.join(tmpDir, "dream", "reports");
    const persisted = await fs.readdir(reportsDir);
    expect(persisted).toHaveLength(1);
  });

  it("includes deep-tier categories and scans dream artifacts", async () => {
    tmpDir = makeTempDir("dream-consolidator-deep-");
    await seedDreamFiles(tmpDir);

    const consolidator = new DreamConsolidator({ baseDir: tmpDir });
    const report = await consolidator.run({ tier: "deep" });
    const iterationLogs = report.categories.find((category) => category.category === "iterationLogs");
    const stallHistory = report.categories.find((category) => category.category === "stallHistory");

    expect(report.categories.some((category) => category.category === "archive")).toBe(true);
    expect(report.categories.some((category) => category.category === "legacyReflectionCompatibility")).toBe(true);
    expect(iterationLogs?.metrics.iterationLogsScanned).toBe(1);
    expect(stallHistory?.metrics.stallEventsScanned).toBe(1);
    expect(report.operational?.backlog.iteration_lines_pending).toBeGreaterThanOrEqual(0);
  });

  it("runs optional Dream Soil sync through the sync service", async () => {
    tmpDir = makeTempDir("dream-consolidator-sync-");
    await seedDreamFiles(tmpDir);
    const syncService = {
      syncFromCurrentDreamState: vi.fn().mockResolvedValue({
        agentMemoryEntries: 1,
        learnedPatterns: 0,
        workflowRecords: 0,
        previousRecords: 0,
        recordsWritten: 1,
        recordsSuperseded: 0,
        chunksWritten: 1,
        tombstonesWritten: 0,
        recordsWithChangedSearchMaterial: 1,
        queueReindexRecordIds: 0,
      }),
    };

    const consolidator = new DreamConsolidator({ baseDir: tmpDir, syncService });
    const report = await consolidator.run({ tier: "light" });
    const agentMemory = report.categories.find((category) => category.category === "agentMemory");

    expect(syncService.syncFromCurrentDreamState).toHaveBeenCalledWith({ baseDir: tmpDir });
    expect(agentMemory?.metrics.soilSyncRecordsWritten).toBe(1);
    expect(agentMemory?.metrics.soilSyncQueueReindexRecordIds).toBe(0);
  });

  it("keeps consolidation non-fatal when optional Dream Soil sync fails", async () => {
    tmpDir = makeTempDir("dream-consolidator-sync-failure-");
    await seedDreamFiles(tmpDir);
    const syncService = {
      syncFromCurrentDreamState: vi.fn().mockRejectedValue(new Error("sync unavailable")),
    };

    const consolidator = new DreamConsolidator({ baseDir: tmpDir, syncService });
    const report = await consolidator.run({ tier: "light" });
    const agentMemory = report.categories.find((category) => category.category === "agentMemory");

    expect(report.status).toBe("completed");
    expect(agentMemory?.status).toBe("completed");
    expect(agentMemory?.metrics.soilSyncFailures).toBe(1);
  });

  it("runs legacy reflection compatibility inside platform consolidation", async () => {
    tmpDir = makeTempDir("dream-consolidator-legacy-");
    await seedDreamFiles(tmpDir);
    const legacyConsolidationService = {
      run: vi.fn().mockResolvedValue({
        goals_consolidated: 2,
        entries_compressed: 3,
        stale_entries_found: 4,
        revalidation_tasks_created: 5,
      }),
    };

    const consolidator = new DreamConsolidator({ baseDir: tmpDir, legacyConsolidationService });
    const report = await consolidator.run({ tier: "deep" });
    const legacy = report.categories.find((category) => category.category === "legacyReflectionCompatibility");

    expect(legacyConsolidationService.run).toHaveBeenCalledWith({ baseDir: tmpDir });
    expect(legacy?.metrics.legacyEntriesCompressed).toBe(3);
    expect(report.operational?.legacy_reflection).toEqual({
      goals_consolidated: 2,
      entries_compressed: 3,
      stale_entries_found: 4,
      revalidation_tasks_created: 5,
    });
  });

  it("skips disabled categories without running their collector", async () => {
    tmpDir = makeTempDir("dream-consolidator-disabled-");
    await seedDreamFiles(tmpDir);
    const memoryQualityService = {
      run: vi.fn().mockResolvedValue({
        findings: 1,
        contradictionsFound: 0,
        stalenessFound: 1,
        redundancyFound: 0,
        repairsApplied: 0,
        entriesFlagged: 1,
      }),
    };

    const consolidator = new DreamConsolidator({
      baseDir: tmpDir,
      memoryQualityService,
      config: {
        knowledgeOptimization: {
          enabled: false,
          redundancySimilarityThreshold: 0.95,
          autoRepairAgentMemory: true,
          minAutoRepairConfidence: 0.8,
        },
      },
    });
    const report = await consolidator.run({ tier: "light" });
    const knowledgeOptimization = report.categories.find((category) => category.category === "knowledgeOptimization");

    expect(memoryQualityService.run).not.toHaveBeenCalled();
    expect(knowledgeOptimization).toMatchObject({
      status: "skipped",
      metrics: {},
      warnings: ["category disabled"],
      errors: [],
    });
  });

  it("surfaces optional service unavailable warnings as completed category results", async () => {
    tmpDir = makeTempDir("dream-consolidator-service-unavailable-");
    await seedDreamFiles(tmpDir);

    const consolidator = new DreamConsolidator({ baseDir: tmpDir });
    const report = await consolidator.run({ tier: "deep" });
    const legacy = report.categories.find((category) => category.category === "legacyReflectionCompatibility");
    const knowledgeOptimization = report.categories.find((category) => category.category === "knowledgeOptimization");

    expect(legacy).toMatchObject({
      status: "completed",
      warnings: ["legacy compatibility service unavailable"],
    });
    expect(knowledgeOptimization).toMatchObject({
      status: "completed",
      warnings: ["memory quality service unavailable"],
    });
  });

  it("logs the category failure contract and records the error", async () => {
    tmpDir = makeTempDir("dream-consolidator-category-failure-");
    await seedDreamFiles(tmpDir);
    const warn = vi.fn();
    const legacyConsolidationService = {
      run: vi.fn().mockRejectedValue(new Error("legacy exploded")),
    };

    const consolidator = new DreamConsolidator({
      baseDir: tmpDir,
      legacyConsolidationService,
      logger: { warn } as never,
    });
    const report = await consolidator.run({ tier: "deep" });
    const legacy = report.categories.find((category) => category.category === "legacyReflectionCompatibility");

    expect(warn).toHaveBeenCalledWith("Dream consolidation category failed", {
      category: "legacyReflectionCompatibility",
      error: "legacy exploded",
    });
    expect(legacy).toMatchObject({
      status: "failed",
      errors: ["legacy exploded"],
      warnings: [],
    });
    expect(report.operational?.failures).toEqual(expect.arrayContaining([
      {
        category: "legacyReflectionCompatibility",
        source_ref: null,
        reason: "legacy exploded",
      },
    ]));
  });

  it("emits bounded activation artifacts from workflow-backed passes", async () => {
    tmpDir = makeTempDir("dream-consolidator-artifacts-");
    await seedDreamFiles(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, "dream", "workflows.json"),
      JSON.stringify({
        version: "dream-workflows-v1",
        generated_at: "2026-04-12T00:00:00.000Z",
        workflows: [
          {
            workflow_id: "dream-workflow:stall",
            type: "stall_recovery",
            title: "Stall recovery: confidence stall",
            description: "Change strategy when confidence stalls.",
            applicability: {
              goal_ids: ["goal-1"],
              task_ids: [],
              event_types: ["StallDetected"],
              signals: ["confidence_stall"],
              scopes: [{ goal_id: "goal-1", task_id: null }],
            },
            preconditions: ["A stall was detected."],
            steps: ["Inspect stall."],
            failure_modes: ["confidence_stall"],
            recovery_steps: ["Re-plan."],
            evidence_refs: ["dream/events/goal-1.jsonl#L1"],
            evidence_count: 1,
            success_count: 0,
            failure_count: 1,
            confidence: 0.72,
            created_at: "2026-04-12T00:00:00.000Z",
            updated_at: "2026-04-12T00:00:00.000Z",
          },
        ],
      }),
      "utf8"
    );

    const consolidator = new DreamConsolidator({ baseDir: tmpDir });
    const report = await consolidator.run({ tier: "deep" });
    const artifacts = JSON.parse(
      await fs.readFile(path.join(tmpDir, "dream", "activation-artifacts.json"), "utf8")
    ) as { artifacts?: Array<{ type?: string; source?: string }> };

    expect(report.operational?.consolidation.artifacts_created).toBeGreaterThan(0);
    expect(artifacts.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "workflow_hint_pack",
        source: "stallHistory",
      }),
    ]));
  });

  it("runs memory quality optimization with confidence-gated repair metrics", async () => {
    tmpDir = makeTempDir("dream-consolidator-memory-quality-");
    await seedDreamFiles(tmpDir);
    const memoryQualityService = {
      run: vi.fn().mockResolvedValue({
        findings: 3,
        contradictionsFound: 1,
        stalenessFound: 1,
        redundancyFound: 1,
        repairsApplied: 2,
        entriesFlagged: 1,
      }),
    };

    const consolidator = new DreamConsolidator({ baseDir: tmpDir, memoryQualityService });
    const report = await consolidator.run({ tier: "light" });
    const knowledgeOptimization = report.categories.find((category) => category.category === "knowledgeOptimization");

    expect(memoryQualityService.run).toHaveBeenCalledWith({
      baseDir: tmpDir,
      autoRepair: true,
      minAutoRepairConfidence: 0.8,
    });
    expect(knowledgeOptimization?.metrics).toMatchObject({
      contradictionsFound: 1,
      stalenessFound: 1,
      redundantEntriesFound: 1,
      revalidationTasksGenerated: 1,
      memoryQualityRepairsApplied: 2,
      memoryQualityEntriesFlagged: 1,
    });
    expect(report.operational?.consolidation.artifacts_created).toBe(1);
  });
});

async function seedDreamFiles(baseDir: string): Promise<void> {
  await fs.mkdir(path.join(baseDir, "goals", "goal-1"), { recursive: true });
  await fs.mkdir(path.join(baseDir, "dream", "events"), { recursive: true });
  await fs.mkdir(path.join(baseDir, "archive", "goal-1"), { recursive: true });
  await fs.mkdir(path.join(baseDir, "verification", "task-1"), { recursive: true });
  await fs.mkdir(path.join(baseDir, "memory", "agent-memory"), { recursive: true });
  await fs.mkdir(path.join(baseDir, "trust"), { recursive: true });

  await fs.writeFile(
    path.join(baseDir, "goals", "goal-1", "iteration-logs.jsonl"),
    `${JSON.stringify({ goalId: "goal-1", iteration: 0 })}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(baseDir, "dream", "session-logs.jsonl"),
    `${JSON.stringify({ goalId: "goal-1", sessionId: "s-1" })}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(baseDir, "dream", "events", "goal-1.jsonl"),
    `${JSON.stringify({ eventType: "StallDetected" })}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(baseDir, "archive", "goal-1", "bundle.json"), "{}", "utf8");
  await fs.writeFile(path.join(baseDir, "verification", "task-1", "report.json"), "{}", "utf8");
  await fs.writeFile(
    path.join(baseDir, "memory", "agent-memory", "entries.json"),
    JSON.stringify({ entries: [{ id: "am-1" }], last_consolidated_at: null }),
    "utf8"
  );
  await fs.writeFile(
    path.join(baseDir, "trust", "trust-store.json"),
    JSON.stringify({
      balances: {
        github: { domain: "github", balance: 10, success_delta: 3, failure_delta: -10 },
      },
      permanent_gates: {},
      override_log: [],
    }),
    "utf8"
  );
}
