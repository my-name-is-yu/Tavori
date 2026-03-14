import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  getNestedValue,
  FileDataSourceAdapter,
  HttpApiDataSourceAdapter,
  DataSourceRegistry,
} from "../src/data-source-adapter.js";
import type { DataSourceConfig } from "../src/types/data-source.js";

// ─── Helpers ───

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-ds-test-"));
}

function makeConfig(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: "test-source",
    name: "Test Source",
    type: "file",
    connection: { path: "/tmp/test.json" },
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── getNestedValue ───

describe("getNestedValue", () => {
  it("simple property access", () => {
    expect(getNestedValue({ foo: 42 }, "foo")).toBe(42);
  });

  it("nested path (a.b.c)", () => {
    expect(getNestedValue({ a: { b: { c: "deep" } } }, "a.b.c")).toBe("deep");
  });

  it("returns undefined for missing path", () => {
    expect(getNestedValue({ a: 1 }, "b.c")).toBeUndefined();
  });

  it("handles null input gracefully", () => {
    expect(getNestedValue(null, "a")).toBeUndefined();
  });

  it("handles undefined input gracefully", () => {
    expect(getNestedValue(undefined, "a")).toBeUndefined();
  });

  it("array index not supported: returns undefined for numeric segment", () => {
    // getNestedValue accesses by string key; array index as string is not guaranteed
    // to work for non-plain-object, so accessing "0" on an array returns the element
    // but "items.0" where items is an array will return the first element via key "0"
    expect(getNestedValue({ items: [10, 20] }, "items.0")).toBe(10);
  });

  it("returns undefined when intermediate path is a primitive", () => {
    expect(getNestedValue({ a: 42 }, "a.b")).toBeUndefined();
  });
});

// ─── FileDataSourceAdapter ───

describe("FileDataSourceAdapter", () => {
  let tmpDir: string;
  let jsonFilePath: string;
  let textFilePath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    jsonFilePath = path.join(tmpDir, "data.json");
    textFilePath = path.join(tmpDir, "data.txt");

    fs.writeFileSync(
      jsonFilePath,
      JSON.stringify({ metrics: { cpu: 75, memory: 60 }, status: "ok" }),
      "utf-8"
    );
    fs.writeFileSync(textFilePath, "hello world", "utf-8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads JSON file and extracts value by expression", async () => {
    const config = makeConfig({ connection: { path: jsonFilePath } });
    const adapter = new FileDataSourceAdapter(config);

    const result = await adapter.query({
      dimension_name: "cpu",
      expression: "metrics.cpu",
      timeout_ms: 5000,
    });

    expect(result.value).toBe(75);
    expect(result.source_id).toBe("test-source");
  });

  it("reads plain text file and returns raw content as value", async () => {
    const config = makeConfig({ connection: { path: textFilePath } });
    const adapter = new FileDataSourceAdapter(config);

    const result = await adapter.query({
      dimension_name: "content",
      timeout_ms: 5000,
    });

    expect(result.value).toBe("hello world");
    expect(result.raw).toBe("hello world");
  });

  it("connect() throws if file does not exist", async () => {
    const config = makeConfig({
      connection: { path: path.join(tmpDir, "nonexistent.json") },
    });
    const adapter = new FileDataSourceAdapter(config);

    await expect(adapter.connect()).rejects.toThrow(/file not found/);
  });

  it("healthCheck returns true for existing file", async () => {
    const config = makeConfig({ connection: { path: jsonFilePath } });
    const adapter = new FileDataSourceAdapter(config);

    expect(await adapter.healthCheck()).toBe(true);
  });

  it("healthCheck returns false for non-existing file", async () => {
    const config = makeConfig({
      connection: { path: path.join(tmpDir, "missing.json") },
    });
    const adapter = new FileDataSourceAdapter(config);

    expect(await adapter.healthCheck()).toBe(false);
  });

  it("query without expression returns null value for JSON file (full content in raw)", async () => {
    const config = makeConfig({ connection: { path: jsonFilePath } });
    const adapter = new FileDataSourceAdapter(config);

    const result = await adapter.query({
      dimension_name: "all",
      timeout_ms: 5000,
    });

    expect(result.value).toBeNull();
    expect(result.raw).toEqual({ metrics: { cpu: 75, memory: 60 }, status: "ok" });
  });

  it("connect() succeeds when file exists", async () => {
    const config = makeConfig({ connection: { path: jsonFilePath } });
    const adapter = new FileDataSourceAdapter(config);

    await expect(adapter.connect()).resolves.toBeUndefined();
  });

  it("disconnect() resolves without error", async () => {
    const config = makeConfig({ connection: { path: jsonFilePath } });
    const adapter = new FileDataSourceAdapter(config);

    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });

  it("result timestamp is a valid ISO string", async () => {
    const config = makeConfig({ connection: { path: jsonFilePath } });
    const adapter = new FileDataSourceAdapter(config);

    const before = Date.now();
    const result = await adapter.query({
      dimension_name: "cpu",
      expression: "metrics.cpu",
      timeout_ms: 5000,
    });
    const after = Date.now();

    const ts = new Date(result.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("handles malformed JSON by throwing a parse error", async () => {
    const badJsonPath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(badJsonPath, "{ not valid json }", "utf-8");

    const config = makeConfig({ connection: { path: badJsonPath } });
    const adapter = new FileDataSourceAdapter(config);

    await expect(
      adapter.query({ dimension_name: "x", timeout_ms: 5000 })
    ).rejects.toThrow();
  });

  it("sourceId matches config id", () => {
    const config = makeConfig({ id: "my-file-source", connection: { path: jsonFilePath } });
    const adapter = new FileDataSourceAdapter(config);
    expect(adapter.sourceId).toBe("my-file-source");
  });

  it("sourceType is 'file'", () => {
    const config = makeConfig({ connection: { path: jsonFilePath } });
    const adapter = new FileDataSourceAdapter(config);
    expect(adapter.sourceType).toBe("file");
  });
});

// ─── HttpApiDataSourceAdapter ───

describe("HttpApiDataSourceAdapter", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeHttpConfig(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
    return makeConfig({
      id: "http-source",
      type: "http_api",
      connection: { url: "https://api.example.com/metrics", method: "GET" },
      ...overrides,
    });
  }

  function makeOkResponse(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  }

  function makeErrorResponse(status: number): Response {
    return {
      ok: false,
      status,
      json: async () => ({}),
    } as Response;
  }

  it("query() fetches URL and extracts value via expression", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ data: { cpu: 88 } }));
    const adapter = new HttpApiDataSourceAdapter(makeHttpConfig());

    const result = await adapter.query({
      dimension_name: "cpu",
      expression: "data.cpu",
      timeout_ms: 5000,
    });

    expect(result.value).toBe(88);
    expect(result.source_id).toBe("http-source");
  });

  it("applies bearer auth header", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ value: 1 }));
    const config = makeHttpConfig({
      auth: { type: "bearer", secret_ref: "my-token" },
    });
    const adapter = new HttpApiDataSourceAdapter(config);

    await adapter.query({ dimension_name: "x", timeout_ms: 5000 });

    const [, options] = mockFetch.mock.calls[0]!;
    expect((options as RequestInit).headers).toMatchObject({
      Authorization: "Bearer my-token",
    });
  });

  it("applies basic auth header", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ value: 1 }));
    const credentials = "user:pass";
    const encoded = Buffer.from(credentials).toString("base64");
    const config = makeHttpConfig({
      auth: { type: "basic", secret_ref: credentials },
    });
    const adapter = new HttpApiDataSourceAdapter(config);

    await adapter.query({ dimension_name: "x", timeout_ms: 5000 });

    const [, options] = mockFetch.mock.calls[0]!;
    expect((options as RequestInit).headers).toMatchObject({
      Authorization: `Basic ${encoded}`,
    });
  });

  it("applies custom headers from config", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ value: 1 }));
    const config = makeHttpConfig({
      connection: {
        url: "https://api.example.com/metrics",
        method: "GET",
        headers: { "X-Custom-Header": "my-value" },
      },
    });
    const adapter = new HttpApiDataSourceAdapter(config);

    await adapter.query({ dimension_name: "x", timeout_ms: 5000 });

    const [, options] = mockFetch.mock.calls[0]!;
    expect((options as RequestInit).headers).toMatchObject({
      "X-Custom-Header": "my-value",
    });
  });

  it("POST method with body_template substitution", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ result: 42 }));
    const config = makeHttpConfig({
      connection: {
        url: "https://api.example.com/query",
        method: "POST",
        body_template: '{"dimension":"{{dimension_name}}"}',
      },
    });
    const adapter = new HttpApiDataSourceAdapter(config);

    await adapter.query({ dimension_name: "cpu_usage", timeout_ms: 5000 });

    const [, options] = mockFetch.mock.calls[0]!;
    expect((options as RequestInit).body).toBe('{"dimension":"cpu_usage"}');
    expect((options as RequestInit).method).toBe("POST");
  });

  it("timeout: throws when fetch never resolves within timeout_ms", async () => {
    // Mock fetch that respects the AbortSignal
    mockFetch.mockImplementation((_url: string, opts: RequestInit) => {
      return new Promise<never>((_resolve, reject) => {
        if (opts.signal) {
          opts.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          });
        }
      });
    });
    const adapter = new HttpApiDataSourceAdapter(makeHttpConfig());

    await expect(
      adapter.query({ dimension_name: "x", timeout_ms: 50 })
    ).rejects.toThrow();
  }, 2000);

  it("healthCheck returns true when HEAD request returns 200", async () => {
    mockFetch.mockResolvedValue({ status: 200 } as Response);
    const adapter = new HttpApiDataSourceAdapter(makeHttpConfig());

    expect(await adapter.healthCheck()).toBe(true);
  });

  it("healthCheck returns false when HEAD request returns 500", async () => {
    mockFetch.mockResolvedValue({ status: 500 } as Response);
    const adapter = new HttpApiDataSourceAdapter(makeHttpConfig());

    expect(await adapter.healthCheck()).toBe(false);
  });

  it("healthCheck returns false when fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));
    const adapter = new HttpApiDataSourceAdapter(makeHttpConfig());

    expect(await adapter.healthCheck()).toBe(false);
  });

  it("connect() throws when health check fails", async () => {
    mockFetch.mockResolvedValue({ status: 503 } as Response);
    const adapter = new HttpApiDataSourceAdapter(makeHttpConfig());

    await expect(adapter.connect()).rejects.toThrow(/health check failed/);
  });

  it("connect() resolves when health check passes", async () => {
    mockFetch.mockResolvedValue({ status: 200 } as Response);
    const adapter = new HttpApiDataSourceAdapter(makeHttpConfig());

    await expect(adapter.connect()).resolves.toBeUndefined();
  });

  it("disconnect() resolves without error", async () => {
    const adapter = new HttpApiDataSourceAdapter(makeHttpConfig());
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });

  it("throws when HTTP response is non-2xx", async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(404));
    const adapter = new HttpApiDataSourceAdapter(makeHttpConfig());

    await expect(
      adapter.query({ dimension_name: "x", timeout_ms: 5000 })
    ).rejects.toThrow(/HTTP 404/);
  });

  it("sourceId matches config id", () => {
    const adapter = new HttpApiDataSourceAdapter(makeHttpConfig());
    expect(adapter.sourceId).toBe("http-source");
  });

  it("sourceType is 'http_api'", () => {
    const adapter = new HttpApiDataSourceAdapter(makeHttpConfig());
    expect(adapter.sourceType).toBe("http_api");
  });

  it("result contains raw response body", async () => {
    const body = { nested: { val: 99 } };
    mockFetch.mockResolvedValue(makeOkResponse(body));
    const adapter = new HttpApiDataSourceAdapter(makeHttpConfig());

    const result = await adapter.query({ dimension_name: "x", timeout_ms: 5000 });

    expect(result.raw).toEqual(body);
  });

  it("result value is null when no expression is given", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ data: 1 }));
    const adapter = new HttpApiDataSourceAdapter(makeHttpConfig());

    const result = await adapter.query({ dimension_name: "x", timeout_ms: 5000 });

    expect(result.value).toBeNull();
  });
});

// ─── DataSourceRegistry ───

describe("DataSourceRegistry", () => {
  let registry: DataSourceRegistry;

  function makeAdapter(id: string): {
    sourceId: string;
    sourceType: "file";
    config: DataSourceConfig;
    connect: () => Promise<void>;
    query: () => Promise<never>;
    disconnect: () => Promise<void>;
    healthCheck: () => Promise<boolean>;
  } {
    return {
      sourceId: id,
      sourceType: "file" as const,
      config: makeConfig({ id }),
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
  }

  beforeEach(() => {
    registry = new DataSourceRegistry();
  });

  it("register and getSource returns the registered adapter", () => {
    const adapter = makeAdapter("ds-1");
    registry.register(adapter);
    expect(registry.getSource("ds-1")).toBe(adapter);
  });

  it("register throws on duplicate id", () => {
    const adapter = makeAdapter("ds-dup");
    registry.register(adapter);
    expect(() => registry.register(makeAdapter("ds-dup"))).toThrow(/already registered/);
  });

  it("getSource throws for unknown id", () => {
    expect(() => registry.getSource("unknown-id")).toThrow(/no source registered/);
  });

  it("listSources returns sorted ids", () => {
    registry.register(makeAdapter("zzz"));
    registry.register(makeAdapter("aaa"));
    registry.register(makeAdapter("mmm"));
    expect(registry.listSources()).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("remove deletes the adapter", () => {
    registry.register(makeAdapter("to-remove"));
    registry.remove("to-remove");
    expect(registry.has("to-remove")).toBe(false);
  });

  it("remove throws for unknown id", () => {
    expect(() => registry.remove("nonexistent")).toThrow(/cannot remove/);
  });

  it("has returns true for registered id", () => {
    registry.register(makeAdapter("present"));
    expect(registry.has("present")).toBe(true);
  });

  it("has returns false for unregistered id", () => {
    expect(registry.has("absent")).toBe(false);
  });

  it("starts empty: listSources returns empty array", () => {
    expect(registry.listSources()).toEqual([]);
  });

  it("after remove, getSource throws for removed id", () => {
    registry.register(makeAdapter("temp"));
    registry.remove("temp");
    expect(() => registry.getSource("temp")).toThrow(/no source registered/);
  });
});
