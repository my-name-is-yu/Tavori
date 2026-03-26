// ─── OpenClawDataSourceAdapter ───
//
// IDataSourceAdapter implementation that reads OpenClaw session logs to observe
// goal progress dimensions.
//
// Session logs are JSONL files under ~/.openclaw/sessions/ (configurable).
// Each line is a JSON event with a "type" field.
//
// Supported dimension_name values:
//   "session_count"        — number of JSONL session files found
//   "last_session_status"  — status string from the last event of the most recent file
//   "total_messages"       — total message events across all sessions
//   "tool_call_count"      — total tool_call events across all sessions
//   "error_count"          — total error events across all sessions
//
// dimension_mapping is supported: keys map query dimension names to internal ones.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { IDataSourceAdapter } from "../observation/data-source-adapter.js";
import type {
  DataSourceType,
  DataSourceConfig,
  DataSourceQuery,
  DataSourceResult,
} from "../types/data-source.js";

// ─── Types ───

interface OpenClawEvent {
  type: string;
  role?: string;
  status?: string;
  [key: string]: unknown;
}

export interface OpenClawDataSourceConfig {
  sessionDir?: string;
  dimensionMapping?: Record<string, string>;
}

// Known dimensions this adapter supports
const KNOWN_DIMENSIONS = new Set([
  "session_count",
  "last_session_status",
  "total_messages",
  "tool_call_count",
  "error_count",
]);

// ─── Adapter ───

export class OpenClawDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceType: DataSourceType = "custom";
  readonly config: DataSourceConfig;

  private readonly sessionDir: string;

  constructor(config: DataSourceConfig, opts: OpenClawDataSourceConfig = {}) {
    this.config = config;
    this.sessionDir =
      opts.sessionDir ??
      (config.connection.path || path.join(os.homedir(), ".openclaw", "sessions"));
  }

  get sourceId(): string {
    return this.config.id;
  }

  async connect(): Promise<void> {
    // no persistent connection — directory checked at query time
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  async healthCheck(): Promise<boolean> {
    try {
      await fsp.access(this.sessionDir);
      return true;
    } catch {
      // Directory missing is not fatal — we return zero values instead
      return false;
    }
  }

  getSupportedDimensions(): string[] {
    return Array.from(KNOWN_DIMENSIONS);
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    // Resolve dimension via mapping
    const dimMapping: Record<string, string> =
      (this.config.dimension_mapping as Record<string, string> | undefined) ?? {};
    const rawDim = params.expression ?? params.dimension_name;
    const dimension = dimMapping[rawDim] ?? rawDim;

    if (!KNOWN_DIMENSIONS.has(dimension)) {
      return {
        value: null,
        raw: null,
        timestamp: new Date().toISOString(),
        source_id: this.sourceId,
      };
    }

    // Read session files
    const files = await this.listSessionFiles();

    // Aggregate
    const stats = await this.aggregate(files, dimension);

    const value =
      dimension === "last_session_status"
        ? (stats.lastSessionStatus ?? null)
        : (stats[dimension as keyof typeof stats] as number);

    return {
      value,
      raw: { session_files: files.length, dimension, stats },
      timestamp: new Date().toISOString(),
      source_id: this.sourceId,
      metadata: stats as unknown as Record<string, unknown>,
    };
  }

  // ─── Private helpers ───

  /**
   * List all JSONL files in the session directory.
   * Returns empty array if directory does not exist.
   */
  private async listSessionFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.sessionDir);
    } catch {
      return [];
    }

    return entries
      .filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"))
      .map((f) => path.join(this.sessionDir, f))
      .sort(); // stable order; last file = most recent
  }

  /**
   * Parse events from a JSONL file, skipping malformed lines.
   */
  private async parseFile(filePath: string): Promise<OpenClawEvent[]> {
    let content: string;
    try {
      content = await fsp.readFile(filePath, "utf-8");
    } catch {
      return [];
    }

    const events: OpenClawEvent[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
          events.push(parsed as OpenClawEvent);
        }
      } catch {
        // Skip malformed lines
      }
    }
    return events;
  }

  /**
   * Aggregate stats across all session files.
   * Only parses files needed for the requested dimension.
   */
  private async aggregate(
    files: string[],
    dimension: string
  ): Promise<{
    session_count: number;
    total_messages: number;
    tool_call_count: number;
    error_count: number;
    lastSessionStatus: string | null;
  }> {
    const stats = {
      session_count: files.length,
      total_messages: 0,
      tool_call_count: 0,
      error_count: 0,
      lastSessionStatus: null as string | null,
    };

    // If only session_count is needed, no file parsing required
    if (dimension === "session_count") return stats;

    for (let i = 0; i < files.length; i++) {
      const events = await this.parseFile(files[i]);

      if (
        dimension === "total_messages" ||
        dimension === "tool_call_count" ||
        dimension === "error_count"
      ) {
        for (const ev of events) {
          if (ev.type === "message") stats.total_messages++;
          if (ev.type === "tool_call") stats.tool_call_count++;
          if (ev.type === "error") stats.error_count++;
        }
      }

      // last_session_status: last event of the last file
      if (dimension === "last_session_status" && i === files.length - 1) {
        const lastEvent = events[events.length - 1];
        if (lastEvent) {
          stats.lastSessionStatus =
            (lastEvent.status as string | undefined) ?? lastEvent.type ?? null;
        }
      }
    }

    return stats;
  }
}
