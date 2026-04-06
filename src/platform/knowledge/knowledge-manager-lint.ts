import { z } from "zod";
import type { KnowledgeManager } from "./knowledge-manager.js";
import {
  LintFindingSchema,
  LintResponseSchema,
  type LintResult,
  type AgentMemoryEntry,
} from "./types/agent-memory.js";

const LINT_SYSTEM_PROMPT = `You are a memory quality auditor. Analyze the provided compiled memory entries and identify:
1. CONTRADICTIONS: entries that conflict with each other (e.g., different values for the same preference/fact)
2. STALENESS: entries that appear outdated based on timestamps or content suggesting superseded information
3. REDUNDANCY: entries with significantly overlapping content that should be merged

Return a JSON object with a "findings" array. Each finding has:
- type: "contradiction" | "staleness" | "redundancy"
- entry_ids: array of entry IDs involved
- description: brief explanation of the issue
- confidence: 0-1 confidence score
- suggested_action: "flag_review" | "auto_resolve_newest" | "mark_stale" | "merge"

If no issues found, return {"findings": []}.
Return ONLY valid JSON, no markdown fences.`;

function buildUserPrompt(entries: AgentMemoryEntry[]): string {
  const formatted = entries.map((e) => ({
    id: e.id,
    key: e.key,
    value: e.value,
    summary: e.summary,
    tags: e.tags,
    category: e.category,
    memory_type: e.memory_type,
    updated_at: e.updated_at,
  }));
  return `Analyze these ${entries.length} compiled memory entries for contradictions, staleness, and redundancy:\n\n${JSON.stringify(formatted, null, 2)}`;
}

export async function lintAgentMemory(opts: {
  km: KnowledgeManager;
  llmCall: (systemPrompt: string, userPrompt: string) => Promise<string>;
  autoRepair?: boolean;
  categories?: string[];
}): Promise<LintResult> {
  const { km, llmCall, autoRepair = false, categories } = opts;

  // 1. Load compiled entries (listAgentMemory has no status filter — filter manually)
  const allEntries = await km.listAgentMemory({ limit: 10000, include_archived: false });
  let entries = allEntries.filter((e) => e.status === "compiled");

  if (categories && categories.length > 0) {
    entries = entries.filter((e) => e.category && categories.includes(e.category));
  }

  if (entries.length < 2) {
    return { findings: [], repairs_applied: 0, entries_flagged: 0 };
  }

  // 2. Chunk if needed (max 30 per call)
  const CHUNK_SIZE = 30;
  const allFindings: z.infer<typeof LintFindingSchema>[] = [];

  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    const userPrompt = buildUserPrompt(chunk);
    const raw = await llmCall(LINT_SYSTEM_PROMPT, userPrompt);

    // Sanitize: strip markdown fences
    const cleaned = raw
      .replace(/```(?:json)?\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    try {
      const parsed = LintResponseSchema.parse(JSON.parse(cleaned));
      allFindings.push(...parsed.findings);
    } catch (err) {
      // Log but don't fail — partial results are acceptable
      console.warn("Failed to parse lint LLM response:", err);
    }
  }

  // 3. Apply repairs if autoRepair is enabled
  let repairsApplied = 0;
  let entriesFlagged = 0;

  for (const finding of allFindings) {
    if (!autoRepair) {
      entriesFlagged += finding.entry_ids.length;
      continue;
    }

    switch (finding.type) {
      case "contradiction": {
        // Keep the most recently updated entry, archive others
        const involved = entries.filter((e) => finding.entry_ids.includes(e.id));
        if (involved.length < 2) break;
        involved.sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
        const toArchive = involved.slice(1);
        const archiveIds = toArchive.map((e) => e.id);
        const archived = await km.archiveAgentMemory(archiveIds);
        repairsApplied += archived;
        break;
      }
      case "staleness": {
        // Mark stale entries as raw so they re-enter consolidation pipeline:
        // delete existing entry + re-save with "needs-reverification" tag (new entries default to "raw")
        for (const id of finding.entry_ids) {
          const entry = entries.find((e) => e.id === id);
          if (entry) {
            await km.deleteAgentMemory(entry.key);
            await km.saveAgentMemory({
              key: entry.key,
              value: entry.value,
              tags: [...entry.tags, "needs-reverification"],
              category: entry.category,
              memory_type: entry.memory_type,
            });
            repairsApplied++;
          }
        }
        break;
      }
      case "redundancy": {
        // Keep the first (richest by value length), archive others
        const involved = entries.filter((e) => finding.entry_ids.includes(e.id));
        if (involved.length < 2) break;
        involved.sort((a, b) => b.value.length - a.value.length);
        const toArchive = involved.slice(1);
        const archiveIds = toArchive.map((e) => e.id);
        const archived = await km.archiveAgentMemory(archiveIds);
        repairsApplied += archived;
        break;
      }
    }
  }

  return {
    findings: allFindings,
    repairs_applied: repairsApplied,
    entries_flagged: entriesFlagged,
  };
}
