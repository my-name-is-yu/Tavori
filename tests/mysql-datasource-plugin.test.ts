// ─── MysqlDataSourceAdapter tests ───
//
// Uses vi.mock to replace mysql2/promise so the test runs from the project root
// without requiring a local npm install in the plugin directory.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoist mock definitions so they are available in the vi.mock factory ───

const { mockConn, mockPool, mockCreatePool } = vi.hoisted(() => {
  const mockConn = {
    release: vi.fn(),
  };
  const mockPool = {
    getConnection: vi.fn().mockResolvedValue(mockConn),
    query: vi.fn().mockResolvedValue([[],  []]),
    end: vi.fn().mockResolvedValue(undefined),
  };
  const mockCreatePool = vi.fn().mockReturnValue(mockPool);
  return { mockConn, mockPool, mockCreatePool };
});

vi.mock("mysql2/promise", () => ({
  default: { createPool: mockCreatePool },
}));

// ─── Import after mock ───

import { MysqlDataSourceAdapter } from "../examples/plugins/mysql-datasource/src/index.js";
import type { DataSourceConfig } from "../src/types/data-source.js";

// ─── Helpers ───

function makeConfig(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: "test-mysql",
    name: "Test MySQL",
    type: "database",
    connection: {},
    enabled: true,
    created_at: new Date().toISOString(),
    connection_string: "mysql://localhost:3306/testdb",
    ...overrides,
  };
}

// ─── Tests ───

describe("MysqlDataSourceAdapter", () => {
  let adapter: MysqlDataSourceAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.getConnection.mockResolvedValue(mockConn);
    mockPool.query.mockResolvedValue([[], []]);
    mockPool.end.mockResolvedValue(undefined);
    mockCreatePool.mockReturnValue(mockPool);
    adapter = new MysqlDataSourceAdapter(makeConfig());
  });

  it("connect → creates pool and verifies connectivity", async () => {
    await adapter.connect();
    expect(mockCreatePool).toHaveBeenCalledWith("mysql://localhost:3306/testdb");
    expect(mockPool.getConnection).toHaveBeenCalledOnce();
    expect(mockConn.release).toHaveBeenCalledOnce();
  });

  it("healthCheck returns true when connected", async () => {
    mockPool.query.mockResolvedValue([[{ "1": 1 }], []]);
    await adapter.connect();
    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(true);
    expect(mockPool.query).toHaveBeenCalledWith("SELECT 1");
  });

  it("healthCheck returns false before connect", async () => {
    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(false);
  });

  it("query returns DataSourceResult with correct shape", async () => {
    mockPool.query.mockResolvedValue([[{ count: 42 }], []]);

    await adapter.connect();
    const result = await adapter.query({
      dimension_name: "row_count",
      expression: "SELECT count FROM metrics WHERE id = ?",
      timeout_ms: 5000,
    });

    expect(result.source_id).toBe("test-mysql");
    expect(result.value).toBe(42);
    expect(result.raw).toEqual([{ count: 42 }]);
    expect(typeof result.timestamp).toBe("string");
  });

  it("query returns null value when result set is empty", async () => {
    mockPool.query.mockResolvedValue([[], []]);

    await adapter.connect();
    const result = await adapter.query({
      dimension_name: "empty",
      expression: "SELECT score FROM results WHERE 1=0",
      timeout_ms: 5000,
    });

    expect(result.value).toBeNull();
    expect(result.raw).toEqual([]);
  });

  it("query passes parameter bindings to pool.query", async () => {
    mockPool.query.mockResolvedValue([[{ score: 99 }], []]);

    await adapter.connect();
    const result = await adapter.query({
      dimension_name: "score",
      expression: "SELECT score FROM results WHERE id = ?",
      timeout_ms: 5000,
      parameters: { id: 7 },
    });

    expect(mockPool.query).toHaveBeenCalledWith(
      "SELECT score FROM results WHERE id = ?",
      [7]
    );
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

  it("rejects UPDATE statements", async () => {
    await adapter.connect();
    await expect(
      adapter.query({
        dimension_name: "test",
        expression: "UPDATE users SET name = 'bob' WHERE id = 1",
        timeout_ms: 5000,
      })
    ).rejects.toThrow("only SELECT statements are permitted");
  });

  it("rejects CREATE statements", async () => {
    await adapter.connect();
    await expect(
      adapter.query({
        dimension_name: "test",
        expression: "CREATE TABLE new_table (id INT)",
        timeout_ms: 5000,
      })
    ).rejects.toThrow("only SELECT statements are permitted");
  });

  it("disconnect → pool.end() called and healthCheck returns false", async () => {
    await adapter.connect();
    await adapter.disconnect();

    expect(mockPool.end).toHaveBeenCalledOnce();

    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(false);
  });

  it("disconnect is a no-op when not connected", async () => {
    await adapter.disconnect();
    expect(mockPool.end).not.toHaveBeenCalled();
  });

  it("healthCheck returns false when pool.query throws", async () => {
    mockPool.query.mockRejectedValue(new Error("connection error"));
    await adapter.connect();
    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(false);
  });
});
