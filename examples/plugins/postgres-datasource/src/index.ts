// ─── PostgresDataSourceAdapter ───
//
// A PulSeed data source plugin that queries a PostgreSQL database.
// Only SELECT statements are permitted; mutating SQL is rejected.

import pg from "pg";
import type {
  DataSourceConfig,
  DataSourceQuery,
  DataSourceResult,
} from "../../../../src/types/data-source.js";
import type { IDataSourceAdapter } from "../../../../src/observation/data-source-adapter.js";

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

// ─── Security ───

const BLOCKED_PATTERNS = /^\s*(DROP|ALTER|DELETE|INSERT|UPDATE|CREATE)\b/i;

function assertSelectOnly(sql: string): void {
  if (BLOCKED_PATTERNS.test(sql)) {
    throw new Error(
      `PostgresDataSourceAdapter: only SELECT statements are permitted. Blocked SQL: "${sql.slice(0, 80)}"`
    );
  }
}

// ─── Adapter ───

export class PostgresDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType = "database" as const;
  readonly config: DataSourceConfig;

  private pool: PgPool | null = null;

  constructor(config: DataSourceConfig) {
    this.config = config;
    this.sourceId = config.id;
  }

  async connect(): Promise<void> {
    const connectionString =
      this.config.connection_string ?? this.config.connection.url;
    this.pool = new Pool({ connectionString });
    // Verify connectivity
    const client = await this.pool.connect();
    client.release();
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    if (!this.pool) {
      throw new Error(
        `PostgresDataSourceAdapter [${this.sourceId}]: not connected — call connect() first`
      );
    }

    const sql = params.expression;
    if (!sql) {
      throw new Error(
        `PostgresDataSourceAdapter [${this.sourceId}]: query.expression (SQL) is required`
      );
    }

    assertSelectOnly(sql);

    const bindValues = params.parameters
      ? Object.values(params.parameters)
      : [];

    const result = await this.pool.query(sql, bindValues as unknown[]);
    const rows = result.rows;
    const raw: unknown = rows;

    // Extract a scalar value: use the first column of the first row when possible
    let value: number | string | boolean | null = null;
    if (rows.length > 0) {
      const firstRow = rows[0] as Record<string, unknown>;
      const firstCol = Object.values(firstRow)[0];
      if (
        typeof firstCol === "number" ||
        typeof firstCol === "string" ||
        typeof firstCol === "boolean"
      ) {
        value = firstCol;
      }
    }

    return {
      value,
      raw,
      timestamp: new Date().toISOString(),
      source_id: this.sourceId,
    };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
