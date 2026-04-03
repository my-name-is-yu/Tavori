import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { writeJsonFileAtomic } from "../utils/json-io.js";
import type { StateManager } from "../state/state-manager.js";
import type { MemoryLifecycleManager } from "../knowledge/memory/memory-lifecycle.js";
import type { KnowledgeManager } from "../knowledge/knowledge-manager.js";
import type { ConsolidationReport } from "./types.js";
import { ConsolidationReportSchema } from "./types.js";

// ─── Helpers ───

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Main ───

export async function runDreamConsolidation(deps: {
  stateManager: StateManager;
  memoryLifecycle?: MemoryLifecycleManager;
  knowledgeManager?: KnowledgeManager;
  baseDir: string;
}): Promise<ConsolidationReport> {
  const { stateManager, memoryLifecycle, knowledgeManager, baseDir } = deps;
  const date = todayISO();
  const now = new Date().toISOString();

  const goalIds = await stateManager.listGoalIds();
  let entriesCompressed = 0;
  let staleEntriesFound = 0;
  let revalidationTasksCreated = 0;

  // Compress short-term memory to long-term for each goal
  const dataTypes = ["experience_log", "observation", "strategy", "task", "knowledge"] as const;
  if (memoryLifecycle) {
    for (const goalId of goalIds) {
      for (const dataType of dataTypes) {
        try {
          const result = await memoryLifecycle.compressToLongTerm(goalId, dataType);
          entriesCompressed += result.entries_compressed ?? 0;
        } catch {
          // Continue with other goals/types if one fails
        }
      }
    }
  }

  // Check for stale knowledge entries and generate revalidation tasks
  if (knowledgeManager) {
    try {
      const staleEntries = await knowledgeManager.getStaleEntries();
      staleEntriesFound = staleEntries.length;

      if (staleEntries.length > 0) {
        const tasks = await knowledgeManager.generateRevalidationTasks(staleEntries);
        revalidationTasksCreated = tasks.length;
      }
    } catch {
      // Non-fatal — continue
    }
  }

  const report = ConsolidationReportSchema.parse({
    date,
    created_at: now,
    goals_consolidated: goalIds.length,
    entries_compressed: entriesCompressed,
    stale_entries_found: staleEntriesFound,
    revalidation_tasks_created: revalidationTasksCreated,
  });

  // Persist report
  const reflectionsDir = path.join(baseDir, "reflections");
  await fsp.mkdir(reflectionsDir, { recursive: true });
  await writeJsonFileAtomic(path.join(reflectionsDir, `dream-${date}.json`), report);

  return report;
}
