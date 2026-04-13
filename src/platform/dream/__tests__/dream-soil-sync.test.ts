import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import type { LearnedPattern } from "../../knowledge/types/learning.js";
import { readSoilMarkdownFile } from "../../soil/io.js";
import { buildDreamSoilMutationIntent } from "../dream-soil-mutation.js";
import { syncDreamOutputsToSoil, type DreamSoilSyncRepository } from "../dream-soil-sync.js";

describe("dream soil sync", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
    tmpDir = "";
  });

  it("loads previous records by source metadata and applies a Soil mutation", async () => {
    tmpDir = makeTempDir("dream-soil-sync-");
    await fs.mkdir(path.join(tmpDir, "memory", "agent-memory"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "learning"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "memory", "agent-memory", "entries.json"),
      JSON.stringify({
        entries: [
          {
            id: "mem-1",
            key: "procedure.deploy",
            value: "Deploy after CI passes.",
            tags: ["deploy"],
            memory_type: "procedure",
            status: "compiled",
            created_at: "2026-04-12T00:00:00.000Z",
            updated_at: "2026-04-12T00:00:00.000Z",
          },
        ],
        last_consolidated_at: null,
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(tmpDir, "learning", "goal-a_patterns.json"),
      JSON.stringify([
        {
          pattern_id: "pat-1",
          type: "strategy_selection",
          description: "Prefer small checkpoints.",
          confidence: 0.8,
          evidence_count: 3,
          source_goal_ids: ["goal-a"],
          applicable_domains: ["strategy"],
          embedding_id: null,
          created_at: "2026-04-12T01:00:00.000Z",
          last_applied_at: null,
        },
      ]),
      "utf8"
    );

    const repository: DreamSoilSyncRepository = {
      loadRecords: vi.fn().mockResolvedValue([]),
      applyMutation: vi.fn().mockResolvedValue(undefined),
    };

    const report = await syncDreamOutputsToSoil({ baseDir: tmpDir, repository });

    expect(repository.loadRecords).toHaveBeenCalledWith({
      active_only: false,
      source_types: ["agent_memory", "learned_pattern", "dream_workflow"],
    });
    expect(repository.applyMutation).toHaveBeenCalledOnce();
    const mutation = vi.mocked(repository.applyMutation).mock.calls[0]?.[0];
    expect((mutation?.records ?? []).map((record) => record.record_id).sort()).toEqual([
      "agent-memory:procedure.deploy:v1",
      "learned-pattern:pat-1:goal-a:v1",
    ]);
    expect(report).toMatchObject({
      agentMemoryEntries: 1,
      learnedPatterns: 1,
      workflowRecords: 0,
      previousRecords: 0,
      recordsWritten: 2,
      chunksWritten: 2,
      tombstonesWritten: 0,
      queueReindexRecordIds: 0,
    });

    const learnedPage = await readSoilMarkdownFile(path.join(tmpDir, "soil", "learning", "learned-patterns", "index.md"));
    expect(learnedPage?.frontmatter.soil_id).toBe("learning/learned-patterns/index");
    expect(learnedPage?.frontmatter.compiled_memory_schema).toBe("soil-compiled-memory-v1");
    expect(learnedPage?.frontmatter.rendered_from).toBe("dream-consolidator");
    expect(learnedPage?.body).toContain("Prefer small checkpoints.");

    const feedbackPage = await readSoilMarkdownFile(path.join(tmpDir, "soil", "feedback", "context.md"));
    expect(feedbackPage?.frontmatter.soil_id).toBe("feedback/context");
    expect(feedbackPage?.frontmatter.rendered_from).toBe("soil-feedback");
    expect(feedbackPage?.body).toContain("Soil context feedback");
  });

  it("does not apply an empty mutation", async () => {
    tmpDir = makeTempDir("dream-soil-sync-empty-");
    const repository: DreamSoilSyncRepository = {
      loadRecords: vi.fn().mockResolvedValue([]),
      applyMutation: vi.fn().mockResolvedValue(undefined),
    };

    const report = await syncDreamOutputsToSoil({ baseDir: tmpDir, repository });

    expect(repository.loadRecords).toHaveBeenCalledWith({
      active_only: false,
      source_types: ["agent_memory", "learned_pattern", "dream_workflow"],
    });
    expect(repository.applyMutation).not.toHaveBeenCalled();
    expect(report.recordsWritten).toBe(0);
  });

  it("tombstones previous Dream-origin records when current files are gone", async () => {
    tmpDir = makeTempDir("dream-soil-sync-removed-");
    const pattern: LearnedPattern = {
      pattern_id: "pat-removed",
      type: "strategy_selection",
      description: "Prefer small checkpoints.",
      confidence: 0.8,
      evidence_count: 3,
      source_goal_ids: ["goal-a"],
      applicable_domains: ["strategy"],
      embedding_id: null,
      created_at: "2026-04-12T01:00:00.000Z",
      last_applied_at: null,
    };
    const previousRecords = buildDreamSoilMutationIntent({ learnedPatterns: [pattern] }).mutation.records;
    const repository: DreamSoilSyncRepository = {
      loadRecords: vi.fn().mockResolvedValue(previousRecords),
      applyMutation: vi.fn().mockResolvedValue(undefined),
    };

    const report = await syncDreamOutputsToSoil({ baseDir: tmpDir, repository });

    expect(repository.loadRecords).toHaveBeenCalledWith({
      active_only: false,
      source_types: ["agent_memory", "learned_pattern", "dream_workflow"],
    });
    expect(repository.applyMutation).toHaveBeenCalledOnce();
    const mutation = vi.mocked(repository.applyMutation).mock.calls[0]?.[0];
    expect(mutation?.records).toHaveLength(0);
    expect(mutation?.tombstones).toEqual([
      expect.objectContaining({
        record_id: "learned-pattern:pat-removed:goal-a:v1",
        record_key: "learned-pattern:pat-removed:goal-a",
        reason: "learned pattern no longer exists",
      }),
    ]);
    expect(report).toMatchObject({
      agentMemoryEntries: 0,
      learnedPatterns: 0,
      workflowRecords: 0,
      previousRecords: 1,
      recordsWritten: 0,
      chunksWritten: 0,
      tombstonesWritten: 1,
    });
  });

  it("loads Dream workflow artifacts and applies them to Soil", async () => {
    tmpDir = makeTempDir("dream-soil-sync-workflow-");
    await fs.mkdir(path.join(tmpDir, "dream"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "dream", "workflows.json"),
      JSON.stringify({
        version: "dream-workflows-v1",
        generated_at: "2026-04-12T05:00:00.000Z",
        workflows: [
          {
            workflow_id: "dream-workflow:abc",
            type: "stall_recovery",
            title: "Stall recovery: confidence stall",
            description: "Change strategy when confidence stalls.",
            applicability: {
              goal_ids: ["goal-a"],
              task_ids: [],
              event_types: ["StallDetected"],
              signals: ["confidence_stall"],
            },
            preconditions: ["A stall was detected."],
            steps: ["Inspect the stall.", "Change strategy."],
            failure_modes: ["confidence_stall"],
            recovery_steps: ["Re-plan before retrying."],
            evidence_refs: ["dream/events/goal-a.jsonl#L1"],
            evidence_count: 1,
            success_count: 0,
            failure_count: 1,
            confidence: 0.72,
            created_at: "2026-04-12T03:00:00.000Z",
            updated_at: "2026-04-12T04:00:00.000Z",
          },
        ],
      }),
      "utf8"
    );
    const repository: DreamSoilSyncRepository = {
      loadRecords: vi.fn().mockResolvedValue([]),
      applyMutation: vi.fn().mockResolvedValue(undefined),
    };

    const report = await syncDreamOutputsToSoil({ baseDir: tmpDir, repository });

    expect(repository.applyMutation).toHaveBeenCalledOnce();
    const mutation = vi.mocked(repository.applyMutation).mock.calls[0]?.[0];
    expect(mutation?.records).toEqual([
      expect.objectContaining({
        record_id: "dream-workflow:abc:v1",
        record_type: "workflow",
        source_type: "dream_workflow",
        source_id: "dream-workflow:abc",
      }),
    ]);
    expect(report).toMatchObject({
      agentMemoryEntries: 0,
      learnedPatterns: 0,
      workflowRecords: 1,
      recordsWritten: 1,
      chunksWritten: 1,
    });

    const workflowPage = await readSoilMarkdownFile(path.join(tmpDir, "soil", "dream", "workflows", "index.md"));
    expect(workflowPage?.frontmatter.soil_id).toBe("dream/workflows/index");
    expect(workflowPage?.frontmatter.compiled_memory_schema).toBe("soil-compiled-memory-v1");
    expect(workflowPage?.body).toContain("Change strategy when confidence stalls.");
    expect(workflowPage?.body).toContain("dream/events/goal-a.jsonl#L1");
  });
});
