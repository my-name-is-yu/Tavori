// ─── PostgresDataSourceAdapter tests ───
//
// Uses vi.mock to replace pg so the test runs from the project root
// without requiring a local npm install in the plugin directory.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoist mock definitions so they are available in the vi.mock factory ───

const { mockClient, mockPool, mockPoolConstructor } = vi.hoisted(() => {
  const mockClient = {
    release: vi.fn(),
  };
  const mockPool = {
    connect: vi.fn().mockResolvedValue(mockClient),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn().mockResolvedValue(undefined),
  };
  const mockPoolConstructor = vi.fn().mockReturnValue(mockPool);
  return { mockClient, mockPool, mockPoolConstructor };
});

vi.mock("pg", () => ({
  default: { Pool: mockPoolConstructor },
}));

// ─── Import after mock ───

import { PostgresDataSourceAdapter } from "../examples/plugins/postgres-datasource/src/index.js";
import type { DataSourceConfig } from "../src/types/data-source.js";

// ─── Helpers ───

function makeConfig(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: "test-postgres",
    name: "Test Postgres",
    type: "database",
    connection: {},
    enabled: true,
    created_at: new Date().toISOString(),
    connection_string: "postgresql://localhost:5432/testdb",
    ...overrides,
  };
}

// ─── Tests ───

describe("PostgresDataSourceAdapter", () => {
  let adapter: PostgresDataSourceAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.connect.mockResolvedValue(mockClient);
    mockPool.query.mockResolvedValue({ rows: [] });
    mockPool.end.mockResolvedValue(undefined);
    mockPoolConstructor.mockReturnValue(mockPool);
    adapter = new PostgresDataSourceAdapter(makeConfig());
  });

  it("connect → creates pool and verifies connectivity", async () => {
    await adapter.connect();
    expect(mockPoolConstructor).toHaveBeenCalledWith({
      connectionString: "postgresql://localhost:5432/testdb",
    });
    expect(mockPool.connect).toHaveBeenCalledOnce();
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it("healthCheck returns true when connected", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ "?column?": 1 }] });
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
    mockPool.query.mockResolvedValue({ rows: [{ count: 42 }] });

    await adapter.connect();
    const result = await adapter.query({
      dimension_name: "row_count",
      expression: "SELECT count FROM metrics WHERE id = $1",
      timeout_ms: 5000,
    });

    expect(result.source_id).toBe("test-postgres");
    expect(result.value).toBe(42);
    expect(result.raw).toEqual([{ count: 42 }]);
    expect(typeof result.timestamp).toBe("string");
  });

  it("query returns null value when result set is empty", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

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
    mockPool.query.mockResolvedValue({ rows: [{ score: 99 }] });

    await adapter.connect();
    const result = await adapter.query({
      dimension_name: "score",
      expression: "SELECT score FROM results WHERE id = $1",
      timeout_ms: 5000,
      parameters: { id: 7 },
    });

    expect(mockPool.query).toHaveBeenCalledWith(
      "SELECT score FROM results WHERE id = $1",
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
