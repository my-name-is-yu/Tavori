// ─── SqliteDataSourceAdapter tests ───
//
// Uses vi.mock to replace better-sqlite3 so the test runs from the project root
// without requiring a local npm install in the plugin directory.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoist mock definitions so they are available in the vi.mock factory ───

const { mockStatement, mockDb, mockDatabaseConstructor } = vi.hoisted(() => {
  const mockStatement = {
    all: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue({ "1": 1 }),
  };
  const mockDb = {
    prepare: vi.fn().mockReturnValue(mockStatement),
    close: vi.fn(),
  };
  const mockDatabaseConstructor = vi.fn().mockReturnValue(mockDb);
  return { mockStatement, mockDb, mockDatabaseConstructor };
});

vi.mock("better-sqlite3", () => ({
  default: mockDatabaseConstructor,
}));

// ─── Import after mock ───

import { SqliteDataSourceAdapter } from "../examples/plugins/sqlite-datasource/src/index.js";
import type { DataSourceConfig } from "../src/types/data-source.js";

// ─── Helpers ───

function makeConfig(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: "test-sqlite",
    name: "Test SQLite",
    type: "database",
    connection: {},
    enabled: true,
    created_at: new Date().toISOString(),
    connection_string: ":memory:",
    ...overrides,
  };
}

// ─── Tests ───

describe("SqliteDataSourceAdapter", () => {
  let adapter: SqliteDataSourceAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReturnValue(mockStatement);
    mockStatement.all.mockReturnValue([]);
    mockStatement.get.mockReturnValue({ "1": 1 });
    mockDatabaseConstructor.mockReturnValue(mockDb);
    adapter = new SqliteDataSourceAdapter(makeConfig());
  });

  it("connect → healthCheck returns true", async () => {
    await adapter.connect();
    expect(mockDatabaseConstructor).toHaveBeenCalledWith(":memory:");

    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(true);
    expect(mockDb.prepare).toHaveBeenCalledWith("SELECT 1");
  });

  it("query returns DataSourceResult with correct shape", async () => {
    mockStatement.all.mockReturnValue([{ count: 42 }]);

    await adapter.connect();
    const result = await adapter.query({
      dimension_name: "row_count",
      expression: "SELECT count FROM metrics WHERE id = 1",
      timeout_ms: 5000,
    });

    expect(result.source_id).toBe("test-sqlite");
    expect(result.value).toBe(42);
    expect(result.raw).toEqual([{ count: 42 }]);
    expect(typeof result.timestamp).toBe("string");
  });

  it("disconnect → healthCheck returns false", async () => {
    await adapter.connect();
    await adapter.disconnect();

    expect(mockDb.close).toHaveBeenCalledOnce();

    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(false);
  });

  it("rejects DROP statements", async () => {
    await adapter.connect();
    await expect(
      adapter.query({
        dimension_name: "test",
        expression: "DROP TABLE users",
        timeout_ms: 5000,
      })
    ).rejects.toThrow("only SELECT statements are permitted");
  });

  it("rejects ALTER statements", async () => {
    await adapter.connect();
    await expect(
      adapter.query({
        dimension_name: "test",
        expression: "ALTER TABLE users ADD COLUMN email TEXT",
        timeout_ms: 5000,
      })
    ).rejects.toThrow("only SELECT statements are permitted");
  });

  it("rejects DELETE statements", async () => {
    await adapter.connect();
    await expect(
      adapter.query({
        dimension_name: "test",
        expression: "DELETE FROM users WHERE id = 1",
        timeout_ms: 5000,
      })
    ).rejects.toThrow("only SELECT statements are permitted");
  });

  it("rejects INSERT statements", async () => {
    await adapter.connect();
    await expect(
      adapter.query({
        dimension_name: "test",
        expression: "INSERT INTO users VALUES (1, 'alice')",
        timeout_ms: 5000,
      })
    ).rejects.toThrow("only SELECT statements are permitted");
  });

  it("parameter binding passes values to prepared statement", async () => {
    mockStatement.all.mockReturnValue([{ score: 99 }]);

    await adapter.connect();
    const result = await adapter.query({
      dimension_name: "score",
      expression: "SELECT score FROM results WHERE id = ?",
      timeout_ms: 5000,
      parameters: { id: 7 },
    });

    expect(mockStatement.all).toHaveBeenCalledWith(7);
    expect(result.value).toBe(99);
  });

  it("throws if query called before connect", async () => {
    await expect(
      adapter.query({
        dimension_name: "test",
        expression: "SELECT 1",
        timeout_ms: 5000,
      })
    ).rejects.toThrow("not connected");
  });

  it("healthCheck returns false before connect", async () => {
    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(false);
  });

  it("uses connection.path when connection_string is absent", async () => {
    const config = makeConfig({ connection_string: undefined, connection: { path: "/tmp/test.db" } });
    const adapterWithPath = new SqliteDataSourceAdapter(config);
    await adapterWithPath.connect();
    expect(mockDatabaseConstructor).toHaveBeenCalledWith("/tmp/test.db");
  });

  it("query returns null value when result set is empty", async () => {
    mockStatement.all.mockReturnValue([]);

    await adapter.connect();
    const result = await adapter.query({
      dimension_name: "empty",
      expression: "SELECT score FROM results WHERE 1=0",
      timeout_ms: 5000,
    });

    expect(result.value).toBeNull();
    expect(result.raw).toEqual([]);
  });
});
