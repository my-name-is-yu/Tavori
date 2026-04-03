import { SharedKnowledgeEntrySchema } from "../types/knowledge.js";
import type {
  KnowledgeEntry,
  SharedKnowledgeEntry,
} from "../types/knowledge.js";
import type { StateManager } from "../state/state-manager.js";
import type { VectorIndex } from "./vector-index.js";
import type { DomainKnowledge } from "../types/knowledge.js";
import { DomainKnowledgeSchema } from "../types/knowledge.js";

// ─── Shared KB path (mirrored from knowledge-manager) ───
const SHARED_KB_PATH = "memory/shared-knowledge/entries.json";

// ─── Deps interfaces ───

export interface SearchDeps {
  stateManager: StateManager;
  vectorIndex?: VectorIndex;
}

// ─── Standalone helpers ───

/** Load all SharedKnowledgeEntries from the shared KB file. */
export async function loadSharedEntries(stateManager: StateManager): Promise<SharedKnowledgeEntry[]> {
  const raw = await stateManager.readRaw(SHARED_KB_PATH);
  if (!raw || !Array.isArray(raw)) {
    return [];
  }
  try {
    return (raw as unknown[]).map((item) =>
      SharedKnowledgeEntrySchema.parse(item)
    );
  } catch {
    return [];
  }
}

/** Load DomainKnowledge for a goal from state. */
export async function loadDomainKnowledge(
  stateManager: StateManager,
  goalId: string
): Promise<DomainKnowledge> {
  const raw = await stateManager.readRaw(`goals/${goalId}/domain_knowledge.json`);

  if (raw === null) {
    return DomainKnowledgeSchema.parse({
      goal_id: goalId,
      domain: goalId,
      entries: [],
      last_updated: new Date().toISOString(),
    });
  }

  return DomainKnowledgeSchema.parse(raw);
}

// ─── Search functions ───

export type MetadataSearchResult = {
  id: string;
  similarity: number;
  metadata: Record<string, unknown>;
};

/**
 * Semantic search within a single goal's knowledge entries via VectorIndex.
 * Falls back to an empty array when no VectorIndex is configured.
 */
export async function searchKnowledge(
  deps: SearchDeps,
  query: string,
  topK: number = 5
): Promise<KnowledgeEntry[]> {
  if (!deps.vectorIndex) {
    return [];
  }

  const results = await deps.vectorIndex.search(query, topK);
  const entries: KnowledgeEntry[] = [];

  for (const result of results) {
    const goalId = result.metadata["goal_id"] as string | undefined;
    if (!goalId) continue;

    const domainKnowledge = await loadDomainKnowledge(deps.stateManager, goalId);
    const entry = domainKnowledge.entries.find((e) => e.entry_id === result.id);
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

/**
 * Cross-goal semantic search. Leverages the VectorIndex which is global
 * across all goals. Returns entries from any goal ordered by similarity.
 * Falls back to an empty array when no VectorIndex is configured.
 */
export async function searchAcrossGoals(
  deps: SearchDeps,
  query: string,
  topK: number = 5
): Promise<KnowledgeEntry[]> {
  // The VectorIndex is goal-agnostic — entries from all goals are indexed
  // together, so this is semantically equivalent to searchKnowledge but
  // explicitly documents cross-goal intent.
  return searchKnowledge(deps, query, topK);
}

/**
 * Query the shared knowledge base by tags (AND logic).
 * Optionally filter to entries contributed by a specific goal.
 */
export async function querySharedKnowledge(
  stateManager: StateManager,
  tags: string[],
  goalId?: string
): Promise<SharedKnowledgeEntry[]> {
  const all = await loadSharedEntries(stateManager);

  return all.filter((entry) => {
    const tagsMatch =
      tags.length === 0 || tags.every((t) => entry.tags.includes(t));
    const goalMatch =
      goalId === undefined || entry.source_goal_ids.includes(goalId);
    return tagsMatch && goalMatch;
  });
}

/**
 * Semantic search across the shared knowledge base using VectorIndex.
 * Falls back to an empty array when no VectorIndex is configured.
 */
export async function searchByEmbedding(
  deps: SearchDeps,
  query: string,
  topK: number = 5
): Promise<{ entry: SharedKnowledgeEntry; similarity: number }[]> {
  if (!deps.vectorIndex) {
    return [];
  }

  const results = await deps.vectorIndex.search(query, topK);
  const all = await loadSharedEntries(deps.stateManager);
  const output: { entry: SharedKnowledgeEntry; similarity: number }[] = [];

  for (const result of results) {
    const entry = all.find((e) => e.entry_id === result.id);
    if (entry) {
      output.push({ entry, similarity: result.similarity });
    }
  }

  return output;
}
