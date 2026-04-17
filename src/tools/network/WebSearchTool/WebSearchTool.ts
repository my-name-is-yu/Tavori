import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../../types.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";

// --- Search types ---

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export interface ISearchClient {
  search(query: string, maxResults?: number): Promise<SearchResult[]>;
}

// --- Tavily implementation ---

export class TavilySearchClient implements ISearchClient {
  constructor(private readonly apiKey: string) {}

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: maxResults ?? 5,
        include_answer: false,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Tavily API error ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string; score?: number }> };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
      score: r.score,
    }));
  }
}

// --- WebSearchTool ---

const WebSearchInputSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(20).optional(),
});
type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export class WebSearchTool implements ITool<WebSearchInput, SearchResult[]> {
  readonly metadata: ToolMetadata = {
    name: "web_search",
    aliases: ["search", "tavily"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 3,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
    requiresNetwork: true,
  };

  readonly inputSchema = WebSearchInputSchema;

  constructor(private readonly client: ISearchClient) {}

  description(): string {
    return DESCRIPTION;
  }

  async call(input: WebSearchInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const results = await this.client.search(input.query, input.maxResults);
      return {
        success: true,
        data: results,
        summary: `Found ${results.length} results for "${input.query}"`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const message = (err as Error).message;
      return {
        success: false,
        data: [],
        summary: `Web search failed: ${message}`,
        error: message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: WebSearchInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: WebSearchInput): boolean {
    return true;
  }
}

// --- Factory ---

export function createWebSearchClient(): ISearchClient | null {
  const apiKey = process.env["TAVILY_API_KEY"];
  if (!apiKey) return null;
  return new TavilySearchClient(apiKey);
}
