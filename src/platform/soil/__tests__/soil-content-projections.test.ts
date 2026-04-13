import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import type {
  DecisionRecord,
  DomainKnowledge,
  SharedKnowledgeEntry,
} from "../../../base/types/knowledge.js";
import type { AgentMemoryStore } from "../../knowledge/types/agent-memory.js";
import { readSoilMarkdownFile } from "../io.js";
import {
  projectAgentMemoryToSoil,
  projectDecisionsToSoil,
  projectDomainKnowledgeToSoil,
  projectIdentityToSoil,
  projectSharedKnowledgeToSoil,
  projectSoilSystemPages,
} from "../content-projections.js";

function fixedClock(): Date {
  return new Date("2026-04-11T10:00:00.000Z");
}

describe("Soil content projections", () => {
  it("projects knowledge and shared knowledge pages", async () => {
    const baseDir = makeTempDir("soil-knowledge-projection-");
    try {
      const domainKnowledge: DomainKnowledge = {
        goal_id: "goal-knowledge",
        domain: "research",
        last_updated: "2026-04-11T09:30:00.000Z",
        entries: [
          {
            entry_id: "entry-1",
            question: "What should we remember?",
            answer: "Keep the source of truth small and readable.",
            sources: [{ type: "web", reference: "note-1", reliability: "high" }],
            confidence: 0.94,
            acquired_at: "2026-04-11T09:00:00.000Z",
            acquisition_task_id: "task-1",
            superseded_by: null,
            tags: ["soil", "projection"],
            embedding_id: null,
          },
        ],
      };

      const sharedEntries: SharedKnowledgeEntry[] = [
        {
          entry_id: "shared-1",
          question: "How should the shared base be kept?",
          answer: "Readable and reviewable.",
          sources: [{ type: "document", reference: "doc-1", reliability: "medium" }],
          confidence: 0.8,
          acquired_at: "2026-04-11T08:00:00.000Z",
          acquisition_task_id: "task-2",
          superseded_by: null,
          tags: ["shared"],
          embedding_id: null,
          source_goal_ids: ["goal-knowledge"],
          domain_stability: "stable",
          revalidation_due_at: "2027-04-11T00:00:00.000Z",
        },
      ];

      await projectDomainKnowledgeToSoil({
        baseDir,
        goalId: "goal-knowledge",
        domainKnowledge,
        clock: fixedClock,
      });
      await projectSharedKnowledgeToSoil({ baseDir, entries: sharedEntries, clock: fixedClock });

      const domainPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "knowledge", "domain", "goal-knowledge.md"));
      expect(domainPage?.frontmatter.soil_id).toBe("knowledge/domain/goal-knowledge");
      expect(domainPage?.frontmatter.source_truth).toBe("runtime_json");
      expect(domainPage?.frontmatter.source_refs[0]?.source_path).toBe(
        path.join(baseDir, "goals", "goal-knowledge", "domain_knowledge.json")
      );
      expect(domainPage?.body).toContain("Keep the source of truth small and readable.");

      const sharedPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "knowledge", "shared", "index.md"));
      expect(sharedPage?.frontmatter.soil_id).toBe("knowledge/shared/index");
      expect(sharedPage?.frontmatter.summary).toBe("1 shared entries");
      expect(sharedPage?.body).toContain("goal-knowledge");
      expect(sharedPage?.body).toContain("stable");
    } finally {
      cleanupTempDir(baseDir);
    }
  });

  it("projects memory, decision, and soil system pages", async () => {
    const baseDir = makeTempDir("soil-memory-projection-");
    try {
      const store: AgentMemoryStore = {
        entries: [
          {
            id: "mem-1",
            key: "tone",
            value: "Be concise and direct.",
            summary: "Preference for direct tone.",
            tags: ["tone"],
            category: "writing",
            memory_type: "preference",
            status: "compiled",
            compiled_from: ["seed"],
            created_at: "2026-04-11T07:00:00.000Z",
            updated_at: "2026-04-11T09:00:00.000Z",
          },
          {
            id: "mem-2",
            key: "runbooks",
            value: "Use short runbooks for recurring tasks.",
            tags: ["pattern"],
            memory_type: "observation",
            status: "raw",
            created_at: "2026-04-11T08:00:00.000Z",
            updated_at: "2026-04-11T08:30:00.000Z",
          },
        ],
        last_consolidated_at: "2026-04-11T09:15:00.000Z",
      };

      const decisions: DecisionRecord[] = [
        {
          id: "decision-1",
          goal_id: "goal-1",
          goal_type: "research",
          strategy_id: "strategy-a",
          hypothesis: "Start narrow.",
          decision: "proceed",
          context: { gap_value: 0.3, stall_count: 1, cycle_count: 2, trust_score: 0.7 },
          outcome: "success",
          timestamp: "2026-04-11T09:10:00.000Z",
          what_worked: ["clear source selection"],
          what_failed: ["too much breadth"],
          suggested_next: ["keep scope narrow"],
        },
      ];

      await projectAgentMemoryToSoil({ baseDir, store, clock: fixedClock });
      await projectDecisionsToSoil({ baseDir, records: decisions, clock: fixedClock });
      await projectSoilSystemPages({ baseDir, clock: fixedClock });

      const memoryPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "memory", "index.md"));
      expect(memoryPage?.frontmatter.soil_id).toBe("memory/index");
      expect(memoryPage?.body).toContain("Last consolidated at: 2026-04-11T09:15:00.000Z");

      const preferencesPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "memory", "preferences.md"));
      expect(preferencesPage?.body).toContain("Be concise and direct.");

      const lessonsPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "memory", "lessons.md"));
      expect(lessonsPage?.body).toContain("Preference for direct tone.");

      const decisionPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "decision", "recent.md"));
      expect(decisionPage?.frontmatter.soil_id).toBe("decision/recent");
      expect(decisionPage?.body).toContain("strategy-a");

      const indexPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "index.md"));
      const statusPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "status.md"));
      const systemPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "system.md"));
      const logPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "log.md"));
      const healthPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "health.md"));
      const contextRoutesPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "context-routes.md"));
      const lifecycleArchivePage = await readSoilMarkdownFile(path.join(baseDir, "soil", "lifecycle", "archive.md"));
      expect(indexPage?.body).toContain("Soil is the readable surface");
      expect(statusPage?.body).toContain("Projection pages are written atomically.");
      expect(systemPage?.body).toContain("read-time truth surface");
      expect(logPage?.frontmatter.compiled_memory_schema).toBe("soil-compiled-memory-v1");
      expect(logPage?.body).toContain("Chronological record of important compiled Soil changes.");
      expect(healthPage?.body).toContain("Health checks for the compiled Soil memory layer.");
      expect(contextRoutesPage?.body).toContain("Fallback search is secondary");
      expect(lifecycleArchivePage?.frontmatter.soil_id).toBe("lifecycle/archive");
      expect(lifecycleArchivePage?.body).toContain("Summary of long-lived memory lifecycle states.");
    } finally {
      cleanupTempDir(baseDir);
    }
  });

  it("mirrors identity markdown into soil pages", async () => {
    const baseDir = makeTempDir("soil-identity-projection-");
    try {
      await fsp.writeFile(path.join(baseDir, "SEED.md"), "# Seed Identity\n\nKeep growing.\n", "utf-8");
      await fsp.writeFile(path.join(baseDir, "ROOT.md"), "# Root Rules\n\nBe clear.\n", "utf-8");
      await fsp.writeFile(path.join(baseDir, "USER.md"), "# User Notes\n\nPrefer short answers.\n", "utf-8");

      await projectIdentityToSoil({ baseDir, clock: fixedClock });

      const seedPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "identity", "seed.md"));
      const rootPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "identity", "root.md"));
      const userPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "identity", "user.md"));

      expect(seedPage?.frontmatter.source_truth).toBe("soil");
      expect(seedPage?.frontmatter.source_refs[0]?.source_type).toBe("controlled_md");
      expect(seedPage?.body).toContain("Keep growing.");
      expect(rootPage?.body).toContain("Be clear.");
      expect(userPage?.body).toContain("Prefer short answers.");
    } finally {
      cleanupTempDir(baseDir);
    }
  });
});
