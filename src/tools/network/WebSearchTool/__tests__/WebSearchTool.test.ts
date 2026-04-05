import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSearchTool, TavilySearchClient, createWebSearchClient } from "../WebSearchTool.js";
import type { ISearchClient, SearchResult } from "../WebSearchTool.js";
import type { ToolCallContext } from "../../../types.js";

const ctx: ToolCallContext = {
  cwd: "/tmp",
  goalId: "g1",
  trustBalance: 50,
  preApproved: true,
  approvalFn: async () => false,
};

function makeMockClient(results: SearchResult[] = []): ISearchClient {
  return {
    search: vi.fn().mockResolvedValue(results),
  };
}

const sampleResults: SearchResult[] = [
  { title: "Result 1", url: "https://example.com/1", snippet: "Snippet 1", score: 0.9 },
  { title: "Result 2", url: "https://example.com/2", snippet: "Snippet 2", score: 0.8 },
];

describe("WebSearchTool", () => {
  let client: ISearchClient;
  let tool: WebSearchTool;

  beforeEach(() => {
    client = makeMockClient(sampleResults);
    tool = new WebSearchTool(client);
  });

  it("returns search results on success", async () => {
    const result = await tool.call({ query: "TypeScript tips" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(sampleResults);
    expect(result.summary).toBe(`Found 2 results for "TypeScript tips"`);
    expect(result.durationMs).toBeTypeOf("number");
  });

  it("handles search client errors gracefully", async () => {
    vi.mocked(client.search).mockRejectedValue(new Error("network failure"));
    const result = await tool.call({ query: "test" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("network failure");
    expect(result.summary).toContain("Web search failed");
    expect(result.durationMs).toBeTypeOf("number");
  });

  it("respects maxResults parameter", async () => {
    await tool.call({ query: "test", maxResults: 10 }, ctx);
    expect(vi.mocked(client.search)).toHaveBeenCalledWith("test", 10);
  });

  it("validates input schema — empty query should fail", () => {
    const parsed = tool.inputSchema.safeParse({ query: "" });
    expect(parsed.success).toBe(false);
  });

  it("metadata is correct", () => {
    expect(tool.metadata.name).toBe("web_search");
    expect(tool.metadata.permissionLevel).toBe("read_only");
    expect(tool.metadata.maxConcurrency).toBe(3);
    expect(tool.metadata.isReadOnly).toBe(true);
    expect(tool.metadata.isDestructive).toBe(false);
  });

  it("checkPermissions returns allowed", async () => {
    const result = await tool.checkPermissions({ query: "test" }, ctx);
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", () => {
    expect(tool.isConcurrencySafe({ query: "test" })).toBe(true);
  });
});

describe("createWebSearchClient", () => {
  const originalEnv = process.env["TAVILY_API_KEY"];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["TAVILY_API_KEY"];
    } else {
      process.env["TAVILY_API_KEY"] = originalEnv;
    }
  });

  it("returns null when no API key", () => {
    delete process.env["TAVILY_API_KEY"];
    expect(createWebSearchClient()).toBeNull();
  });

  it("returns client when API key set", () => {
    process.env["TAVILY_API_KEY"] = "test-key-123";
    const client = createWebSearchClient();
    expect(client).not.toBeNull();
    expect(client).toBeInstanceOf(TavilySearchClient);
  });
});

describe("TavilySearchClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("maps response correctly", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: "Test Title", url: "https://example.com", content: "Test snippet", score: 0.95 },
        ],
      }),
    });

    const client = new TavilySearchClient("test-api-key");
    const results = await client.search("test query", 5);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: "Test Title",
      url: "https://example.com",
      snippet: "Test snippet",
      score: 0.95,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Authorization": "Bearer test-api-key",
        }),
        body: JSON.stringify({ query: "test query", max_results: 5, include_answer: false }),
      })
    );
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    const client = new TavilySearchClient("bad-key");
    await expect(client.search("test")).rejects.toThrow("Tavily API error 401");
  });
});

describe("WebSearchTool — edge cases", () => {
  it("handles empty results array", async () => {
    const mockClient: ISearchClient = {
      search: vi.fn().mockResolvedValue([]),
    };
    const tool = new WebSearchTool(mockClient);
    const result = await tool.call({ query: "nonexistent obscure query" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
    expect(result.summary).toContain("Found 0 results");
  });
});
