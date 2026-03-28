// ─── SqliteDataSourceAdapter ───
//
// A PulSeed data source plugin that queries a SQLite database.
// Only SELECT statements are permitted; mutating SQL is rejected.

import Database from "better-sqlite3";
import type {
  DataSourceConfig,
  DataSourceQuery,
  DataSourceResult,
} from "../../../../src/types/data-source.js";
import type { IDataSourceAdapter } from "../../../../src/observation/data-source-adapter.js";

// ─── Security ───

const BLOCKED_PATTERNS = /^\s*(DROP|ALTER|DELETE|INSERT|UPDATE|CREATE)\b/i;

function assertSelectOnly(sql: string): void {
  if (BLOCKED_PATTERNS.test(sql)) {
    throw new Error(
      `SqliteDataSourceAdapter: only SELECT statements are permitted. Blocked SQL: "${sql.slice(0, 80)}"`
    );
  }
}

// ─── Adapter ───

export class SqliteDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType = "database" as const;
  readonly config: DataSourceConfig;

  private db: Database.Database | null = null;

  constructor(config: DataSourceConfig) {
    this.config = config;
    this.sourceId = config.id;
  }

  async connect(): Promise<void> {
    const dbPath =
      this.config.connection_string ??
      this.config.connection.path ??
      ":memory:";
    this.db = new Database(dbPath);
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    if (!this.db) {
      throw new Error(
        `SqliteDataSourceAdapter [${this.sourceId}]: not connected — call connect() first`
      );
    }

    const sql = params.expression;
    if (!sql) {
      throw new Error(
        `SqliteDataSourceAdapter [${this.sourceId}]: query.expression (SQL) is required`
      );
    }

    assertSelectOnly(sql);

    const bindParams = params.parameters
      ? Object.values(params.parameters)
      : [];

    const rows = this.db.prepare(sql).all(...bindParams);
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
    if (!this.db) return false;
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
