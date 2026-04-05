import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
  ToolDescriptionContext,
} from "../../types.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import type { KnowledgeEntry } from "../../../base/types/knowledge.js";

export const KnowledgeQueryInputSchema = z.object({
  query: z.string().min(1),
  goalId: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(5),
  type: z.enum(["semantic", "keyword"]).default("keyword"),
});
export type KnowledgeQueryInput = z.infer<typeof KnowledgeQueryInputSchema>;

export interface KnowledgeQueryResultItem {
  entryId: string;
  content: string;
  confidence: number;
  source: string;
  goalId: string | null;
  relevance?: number;
}

export interface KnowledgeQueryOutput {
  results: KnowledgeQueryResultItem[];
  totalFound: number;
}

function entryToItem(
  entry: KnowledgeEntry,
  goalId: string | null,
  relevance?: number
): KnowledgeQueryResultItem {
  return {
    entryId: entry.entry_id,
    content: `Q: ${entry.question}\nA: ${entry.answer}`,
    confidence: entry.confidence,
    source:
      entry.sources.length > 0
        ? (entry.sources[0]?.reference ?? "unknown")
        : "unknown",
    goalId,
    ...(relevance !== undefined ? { relevance } : {}),
  };
}

function keywordMatch(entry: KnowledgeEntry, query: string): boolean {
  const lower = query.toLowerCase();
  return (
    entry.question.toLowerCase().includes(lower) ||
    entry.answer.toLowerCase().includes(lower) ||
    entry.tags.some((t) => t.toLowerCase().includes(lower))
  );
}

export class KnowledgeQueryTool
  implements ITool<KnowledgeQueryInput, KnowledgeQueryOutput>
{
  readonly metadata: ToolMetadata = {
    name: "knowledge_query",
    aliases: ["query_knowledge", "search_knowledge"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };

  readonly inputSchema = KnowledgeQueryInputSchema;

  constructor(private readonly knowledgeManager: KnowledgeManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(
    input: KnowledgeQueryInput,
    _context: ToolCallContext
  ): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const items = await this._search(input);
      const limited = items.slice(0, input.limit);
      const output: KnowledgeQueryOutput = {
        results: limited,
        totalFound: items.length,
      };

      return {
        success: true,
        data: output,
        summary: `Found ${items.length} knowledge entries for query "${input.query}"${items.length > input.limit ? ` (showing first ${input.limit})` : ""}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: { results: [], totalFound: 0 },
        summary: `Knowledge query failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private async _search(
    input: KnowledgeQueryInput
  ): Promise<KnowledgeQueryResultItem[]> {
    if (input.type === "semantic") {
      return this._semanticSearch(input);
    }
    return this._keywordSearch(input);
  }

  private async _keywordSearch(
    input: KnowledgeQueryInput
  ): Promise<KnowledgeQueryResultItem[]> {
    if (input.goalId) {
      const entries = await this.knowledgeManager.loadKnowledge(input.goalId);
      return entries
        .filter((e) => keywordMatch(e, input.query))
        .map((e) => entryToItem(e, input.goalId ?? null));
    }

    // Cross-goal keyword search via shared KB
    const shared = await this.knowledgeManager.querySharedKnowledge([]);
    return shared
      .filter(
        (e) =>
          keywordMatch(e, input.query)
      )
      .map((e) =>
        entryToItem(e, e.source_goal_ids[0] ?? null)
      );
  }

  private async _semanticSearch(
    input: KnowledgeQueryInput
  ): Promise<KnowledgeQueryResultItem[]> {
    if (input.goalId) {
      // Try semantic via searchKnowledge (VectorIndex), fall back to keyword
      const entries = await this.knowledgeManager.searchKnowledge(
        input.query,
        input.limit
      );
      if (entries.length > 0) {
        return entries.map((e) => entryToItem(e, input.goalId ?? null));
      }
      return this._keywordSearch(input);
    }

    // Cross-goal semantic search
    const results = await this.knowledgeManager.searchByEmbedding(
      input.query,
      input.limit
    );
    if (results.length > 0) {
      return results.map(({ entry, similarity }) =>
        entryToItem(entry, entry.source_goal_ids[0] ?? null, similarity)
      );
    }

    // Fall back to keyword
    return this._keywordSearch(input);
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
