// ─── FileExistenceDataSourceAdapter ───
//
// IDataSourceAdapter implementation that checks if files exist in a directory.
//
// Supported dimension values:
//   Any key defined in config.dimension_mapping — maps to a filename relative to baseDir.
//   Returns 1 if the file exists, 0 if it does not.
//   Returns null for unknown dimensions (not in dimension_mapping).
//
// Config fields used from DataSourceConfig:
//   connection.path       — base directory to resolve filenames against (defaults to cwd)
//   dimension_mapping     — map of dimension_name → filename (relative to baseDir)

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { IDataSourceAdapter } from "../../platform/observation/data-source-adapter.js";
import type {
  DataSourceType,
  DataSourceConfig,
  DataSourceQuery,
  DataSourceResult,
} from "../../base/types/data-source.js";

export class FileExistenceDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceType: DataSourceType = "file_existence";
  readonly config: DataSourceConfig;

  private readonly baseDir: string;
  private readonly dimensionMap: Record<string, string>;

  constructor(config: DataSourceConfig) {
    this.config = config;
    this.baseDir = config.connection.path ?? process.cwd();
    this.dimensionMap = (config.dimension_mapping as Record<string, string>) ?? {};
  }

  get sourceId(): string {
    return this.config.id;
  }

  async connect(): Promise<void> {
    // no-op: no persistent connection required
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  getSupportedDimensions(): string[] {
    return Object.keys(this.dimensionMap);
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    // ObservationEngine may pass `expression` = the mapped value (e.g. "README.md")
    // from config.dimension_mapping. In that case, use it directly as the filename.
    // Otherwise, look up the dimension_name in our local map.
    const filename = params.expression ?? this.dimensionMap[params.dimension_name];

    if (filename === undefined) {
      // Unknown dimension — return null so caller can handle gracefully
      return {
        value: null,
        raw: {},
        timestamp: new Date().toISOString(),
        source_id: this.sourceId,
      };
    }

    const fullPath = path.join(this.baseDir, filename);
    let exists = true;
    try { await fsp.access(fullPath); } catch { exists = false; }

    // For "present" threshold: 1 = exists, 0 = missing
    return {
      value: exists ? 1 : 0,
      raw: { path: fullPath, exists },
      timestamp: new Date().toISOString(),
      source_id: this.sourceId,
    };
  }
}
