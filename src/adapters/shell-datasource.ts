// ─── ShellDataSourceAdapter ───
//
// IDataSourceAdapter implementation that runs shell commands to observe
// count-based dimensions like todo_count, fixme_count, test_pass_count.
//
// Uses execFile (NOT exec/execSync) to prevent shell injection.
//
// Each dimension maps to a ShellCommandSpec with a pre-split argv array.
// The command's stdout is parsed according to output_type:
//   "number"  — sums all trailing integers found on each line (handles grep -c multi-file output)
//   "boolean" — "1" or "true" → 1, otherwise → 0
//   "raw"     — parseFloat of the trimmed stdout
//
// grep exit code 1 (zero matches) is treated as 0, not an error.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IDataSourceAdapter } from "../data-source-adapter.js";
import type {
  DataSourceType,
  DataSourceConfig,
  DataSourceQuery,
  DataSourceResult,
} from "../types/data-source.js";

const execFileAsync = promisify(execFile);

export interface ShellCommandSpec {
  argv: string[];          // e.g. ["grep", "-rc", "TODO", "src/"]
  output_type: "number" | "boolean" | "raw";
  cwd?: string;            // default: process.cwd()
  timeout_ms?: number;     // default: 15000
}

export class ShellDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType: DataSourceType = "file";
  readonly config: DataSourceConfig;

  private readonly commands: Record<string, ShellCommandSpec>;
  private readonly defaultCwd: string;

  constructor(sourceId: string, commands: Record<string, ShellCommandSpec>, cwd?: string) {
    this.sourceId = sourceId;
    this.commands = commands;
    this.defaultCwd = cwd ?? process.cwd();

    // Synthesize a minimal DataSourceConfig to satisfy the interface
    this.config = {
      id: sourceId,
      name: `ShellDataSource(${sourceId})`,
      type: "file",
      connection: {},
      enabled: true,
      created_at: new Date().toISOString(),
    };
  }

  async connect(): Promise<void> {
    // no persistent connection required
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  getSupportedDimensions(): string[] {
    return Object.keys(this.commands);
  }

  /**
   * Observe a set of dimensions by running their configured shell commands.
   * Returns a map of dimensionName → numeric value.
   * Dimensions without a configured command are silently skipped.
   */
  async observe(dimensionNames: string[]): Promise<Record<string, number>> {
    const results: Record<string, number> = {};

    for (const dimName of dimensionNames) {
      const spec = this.commands[dimName];
      if (!spec) continue;  // skip dimensions we don't handle

      try {
        const { stdout } = await execFileAsync(
          spec.argv[0],
          spec.argv.slice(1),
          {
            cwd: spec.cwd ?? this.defaultCwd,
            timeout: spec.timeout_ms ?? 15000,
          }
        );
        results[dimName] = this.parseOutput(stdout, spec.output_type);
      } catch (err: unknown) {
        // grep returns exit code 1 for zero matches — treat as 0, not an error
        if (this.isExecError(err) && err.code === 1 && spec.argv[0] === "grep") {
          results[dimName] = 0;
        } else if (this.isExecError(err) && err.code === 1 && spec.output_type === "boolean") {
          results[dimName] = 0;  // false
        } else {
          console.warn(`[ShellDataSource] command failed for "${dimName}": ${String(err)}`);
          // Don't include in results — let ObservationEngine fallback handle it
        }
      }
    }

    return results;
  }

  /**
   * IDataSourceAdapter.query() — wraps observe() for single-dimension queries.
   * Called by ObservationEngine when this adapter is used as a generic DataSource.
   */
  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    const observed = await this.observe([params.dimension_name]);
    const value = params.dimension_name in observed ? observed[params.dimension_name] : null;

    return {
      value,
      raw: { argv: this.commands[params.dimension_name]?.argv, result: value },
      timestamp: new Date().toISOString(),
      source_id: this.sourceId,
    };
  }

  // ─── Private helpers ───

  private parseOutput(stdout: string, outputType: "number" | "boolean" | "raw"): number {
    const trimmed = stdout.trim();

    switch (outputType) {
      case "number": {
        // Handle multi-line grep -c output (e.g. "src/a.ts:2\nsrc/b.ts:1") — sum all lines
        const lines = trimmed.split("\n");
        let total = 0;
        for (const line of lines) {
          const match = line.match(/(\d+)\s*$/);
          if (match) total += parseInt(match[1], 10);
        }
        return total;
      }
      case "boolean":
        return trimmed === "1" || trimmed.toLowerCase() === "true" ? 1 : 0;
      case "raw":
        return parseFloat(trimmed) || 0;
    }
  }

  private isExecError(err: unknown): err is { code: number; stdout: string; stderr: string } {
    return typeof err === "object" && err !== null && "code" in err;
  }
}
