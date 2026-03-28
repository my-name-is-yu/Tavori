// ─── MysqlDataSourceAdapter ───
//
// A PulSeed data source plugin that queries a MySQL database.
// Only SELECT statements are permitted; mutating SQL is rejected.

import mysql from "mysql2/promise";
import type {
  DataSourceConfig,
  DataSourceQuery,
  DataSourceResult,
} from "../../../../src/types/data-source.js";
import type { IDataSourceAdapter } from "../../../../src/observation/data-source-adapter.js";

type MySQLPool = mysql.Pool;

// ─── Security ───

const BLOCKED_PATTERNS = /^\s*(DROP|ALTER|DELETE|INSERT|UPDATE|CREATE)\b/i;

function assertSelectOnly(sql: string): void {
  if (BLOCKED_PATTERNS.test(sql)) {
    throw new Error(
      `MysqlDataSourceAdapter: only SELECT statements are permitted. Blocked SQL: "${sql.slice(0, 80)}"`
    );
  }
}

// ─── Adapter ───

export class MysqlDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType = "database" as const;
  readonly config: DataSourceConfig;

  private pool: MySQLPool | null = null;

  constructor(config: DataSourceConfig) {
    this.config = config;
    this.sourceId = config.id;
  }

  async connect(): Promise<void> {
    const uri =
      this.config.connection_string ?? this.config.connection.url;
    this.pool = mysql.createPool(uri ?? "");
    // Verify connectivity
    const conn = await this.pool.getConnection();
    conn.release();
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    if (!this.pool) {
      throw new Error(
        `MysqlDataSourceAdapter [${this.sourceId}]: not connected — call connect() first`
      );
    }

    const sql = params.expression;
    if (!sql) {
      throw new Error(
        `MysqlDataSourceAdapter [${this.sourceId}]: query.expression (SQL) is required`
      );
    }

    assertSelectOnly(sql);

    const bindValues = params.parameters
      ? Object.values(params.parameters)
      : [];

    const [rows] = await this.pool.query(sql, bindValues);
    const rowArray = rows as Record<string, unknown>[];
    const raw: unknown = rowArray;

    // Extract a scalar value: use the first column of the first row when possible
    let value: number | string | boolean | null = null;
    if (rowArray.length > 0) {
      const firstRow = rowArray[0];
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
