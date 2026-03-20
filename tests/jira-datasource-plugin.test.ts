import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JiraDataSourceAdapter } from "../examples/plugins/jira-datasource/src/index.js";
import type { DataSourceConfig } from "../src/types/data-source.js";

// ─── Helpers ───

function makeConfig(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: "test-jira",
    name: "Test Jira",
    type: "http_api",
    connection: {
      url: "https://myorg.atlassian.net",
      headers: {
        "X-Jira-Email": "user@example.com",
        "X-Jira-Token": "test-api-token",
      },
    },
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ───

describe("JiraDataSourceAdapter — connect()", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accountId: "user-123", displayName: "Test User" }),
      text: async () => "ok",
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("connects successfully with valid config", async () => {
    const adapter = new JiraDataSourceAdapter(makeConfig());
    await expect(adapter.connect()).resolves.not.toThrow();
  });

  it("throws when connection.url is missing", async () => {
    const adapter = new JiraDataSourceAdapter(
      makeConfig({ connection: { headers: { "X-Jira-Email": "u@e.com", "X-Jira-Token": "tok" } } })
    );
    await expect(adapter.connect()).rejects.toThrow("connection.url");
  });

  it("throws when email is missing", async () => {
    const adapter = new JiraDataSourceAdapter(
      makeConfig({
        connection: {
          url: "https://myorg.atlassian.net",
          headers: { "X-Jira-Token": "tok" },
        },
      })
    );
    await expect(adapter.connect()).rejects.toThrow("email and API token");
  });

  it("throws when API token is missing", async () => {
    const adapter = new JiraDataSourceAdapter(
      makeConfig({
        connection: {
          url: "https://myorg.atlassian.net",
          headers: { "X-Jira-Email": "user@example.com" },
        },
      })
    );
    await expect(adapter.connect()).rejects.toThrow("email and API token");
  });
});

describe("JiraDataSourceAdapter — query()", () => {
  let adapter: JiraDataSourceAdapter;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ total: 42, issues: [] }),
      text: async () => "ok",
    });
    vi.stubGlobal("fetch", fetchMock);

    adapter = new JiraDataSourceAdapter(makeConfig());
    await adapter.connect();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws if called before connect()", async () => {
    const freshAdapter = new JiraDataSourceAdapter(makeConfig());
    await expect(
      freshAdapter.query({ dimension_name: "open_bugs", expression: "project = BUG" })
    ).rejects.toThrow("not connected");
  });

  it("throws when expression (JQL) is missing", async () => {
    await expect(
      adapter.query({ dimension_name: "test" })
    ).rejects.toThrow("query.expression");
  });

  it("calls the Jira search API with the JQL expression", async () => {
    await adapter.query({
      dimension_name: "open_bugs",
      expression: "project = BUG AND status = Open",
    });

    const [url] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
    expect(url).toContain("/rest/api/2/search");
    expect(url).toContain(encodeURIComponent("project = BUG AND status = Open"));
  });

  it("returns the total issue count as value", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ total: 17, issues: [] }),
    });

    const result = await adapter.query({
      dimension_name: "open_bugs",
      expression: "project = BUG",
    });

    expect(result.value).toBe(17);
    expect(result.source_id).toBe("test-jira");
    expect(typeof result.timestamp).toBe("string");
  });

  it("includes raw API response in result.raw", async () => {
    const apiResponse = { total: 5, issues: [], maxResults: 0 };
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => apiResponse,
    });

    const result = await adapter.query({
      dimension_name: "open_bugs",
      expression: "project = BUG",
    });

    expect(result.raw).toEqual(apiResponse);
  });

  it("returns null value when total is not a number", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ issues: [] }),
    });

    const result = await adapter.query({
      dimension_name: "open_bugs",
      expression: "project = BUG",
    });

    expect(result.value).toBeNull();
  });

  it("throws when Jira API returns non-OK status", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    await expect(
      adapter.query({ dimension_name: "open_bugs", expression: "project = BUG" })
    ).rejects.toThrow("401");
  });

  it("sends Basic Auth header", async () => {
    await adapter.query({
      dimension_name: "open_bugs",
      expression: "project = BUG",
    });

    const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
    const authHeader = (init.headers as Record<string, string>)["Authorization"];
    expect(authHeader).toMatch(/^Basic /);
  });
});

describe("JiraDataSourceAdapter — healthCheck()", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accountId: "user-123" }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false before connect()", async () => {
    const adapter = new JiraDataSourceAdapter(makeConfig());
    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(false);
  });

  it("returns true when /myself endpoint responds OK", async () => {
    const adapter = new JiraDataSourceAdapter(makeConfig());
    await adapter.connect();
    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(true);

    const [url] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string];
    expect(url).toContain("/rest/api/2/myself");
  });

  it("returns false when /myself endpoint returns non-OK", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    const adapter = new JiraDataSourceAdapter(makeConfig());
    await adapter.connect();
    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("Network error"));
    const adapter = new JiraDataSourceAdapter(makeConfig());
    await adapter.connect();
    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(false);
  });
});

describe("JiraDataSourceAdapter — disconnect()", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ total: 10 }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears connection state and healthCheck returns false after disconnect", async () => {
    const adapter = new JiraDataSourceAdapter(makeConfig());
    await adapter.connect();
    await adapter.disconnect();

    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(false);
  });

  it("query throws after disconnect", async () => {
    const adapter = new JiraDataSourceAdapter(makeConfig());
    await adapter.connect();
    await adapter.disconnect();

    await expect(
      adapter.query({ dimension_name: "open_bugs", expression: "project = BUG" })
    ).rejects.toThrow("not connected");
  });

  it("disconnect is safe to call when not connected", async () => {
    const adapter = new JiraDataSourceAdapter(makeConfig());
    await expect(adapter.disconnect()).resolves.not.toThrow();
  });
});
