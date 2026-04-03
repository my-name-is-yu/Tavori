// ─── goal-utils.ts: shared types, patterns, and data-source auto-registration ───

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getDatasourcesDir } from "../../utils/paths.js";
import { writeJsonFile } from "../../utils/json-io.js";
import { StateManager } from "../../state/state-manager.js";
import { getCliLogger } from "../cli-logger.js";
import { formatOperationError } from "../utils.js";

// ─── Shell Dimension Patterns ───
//
// Maps known count-based dimension names to grep commands that can mechanically
// observe them. argv uses pre-split arrays (passed to execFile, not shell).
// output_type "number" sums trailing integers across multi-line grep -rc output.

export interface ShellCommandConfig {
  argv: string[];
  output_type: "number" | "boolean" | "raw";
  timeout_ms?: number;
}

export interface TodoLikeMarkerInventory {
  grouped_counts: {
    TODO: number;
    FIXME: number;
  };
  raw_total_count: number;
}

export function buildTodoLikeMarkerInventory(todoCount: number, fixmeCount: number): TodoLikeMarkerInventory {
  const normalizedTodoCount = Number.isFinite(todoCount) && todoCount > 0 ? Math.floor(todoCount) : 0;
  const normalizedFixmeCount = Number.isFinite(fixmeCount) && fixmeCount > 0 ? Math.floor(fixmeCount) : 0;

  return {
    grouped_counts: {
      TODO: normalizedTodoCount,
      FIXME: normalizedFixmeCount,
    },
    raw_total_count: normalizedTodoCount + normalizedFixmeCount,
  };
}

export function formatTodoLikeMarkerInventory(inventory: TodoLikeMarkerInventory): string {
  return [
    "Tracked marker inventory:",
    `  grouped_counts: ${JSON.stringify(inventory.grouped_counts)}`,
    `  raw_total_count: ${inventory.raw_total_count}`,
  ].join("\n");
}

export const SHELL_DIMENSION_PATTERNS: Record<string, ShellCommandConfig> = {
  todo_count:        { argv: ["grep", "-rc", "TODO", "src/"], output_type: "number" },
  fixme_count:       { argv: ["grep", "-rc", "FIXME", "src/"], output_type: "number" },
  todo_like_marker_inventory: { argv: ["grep", "-rn", "--include=*.ts", "-E", "TODO|FIXME", "src/"], output_type: "raw" },
  test_count:        { argv: ["grep", "-rEc", "--include=*.ts", "--include=*.js", "it\\(|test\\(|describe\\(", "."], output_type: "number" },
  test_pass_count:   { argv: ["npx", "vitest", "run", "--reporter=verbose"], output_type: "raw", timeout_ms: 120000 },
  lint_errors:       { argv: ["npx", "eslint", "src/", "--format", "compact", "--max-warnings", "9999"], output_type: "number" },
  tsc_error_count:   { argv: ["npx", "tsc", "--noEmit", "--pretty", "false"], output_type: "number" },
  test_coverage:     { argv: ["node", "scripts/measure-coverage.cjs"], output_type: "raw", timeout_ms: 180000 },
};

// ─── Raw Dimension Spec ───

export interface RawDimensionSpec {
  name: string;
  type: "min" | "max" | "range" | "present" | "match";
  value?: string;
}

type Threshold =
  | { type: "min"; value: number }
  | { type: "max"; value: number }
  | { type: "range"; low: number; high: number }
  | { type: "present" }
  | { type: "match"; value: string | number | boolean };

/** Parse a "name:type:value" string into a RawDimensionSpec. Returns null on error. */
export function parseRawDim(raw: string): RawDimensionSpec | null {
  const parts = raw.split(":");
  if (parts.length < 2) return null;
  const name = parts[0].trim();
  const type = parts[1].trim() as RawDimensionSpec["type"];
  if (!["min", "max", "range", "present", "match"].includes(type)) return null;
  if (!name) return null;
  const value = parts.slice(2).join(":").trim() || undefined;
  return { name, type, value };
}

/** Build a Threshold object from a RawDimensionSpec. Returns null if value is invalid. */
export function buildThreshold(spec: RawDimensionSpec): Threshold | null {
  if (spec.type === "present") return { type: "present" };

  if (spec.type === "range") {
    if (!spec.value) return null;
    let low: number;
    let high: number;
    const commaParts = spec.value.split(",");
    if (commaParts.length === 2) {
      low = parseFloat(commaParts[0] ?? "");
      high = parseFloat(commaParts[1] ?? "");
    } else {
      // Hyphen fallback: "10-20", "-5-5", "-10--5"
      const rangeMatch = spec.value.match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/);
      if (rangeMatch) {
        low = parseFloat(rangeMatch[1]);
        high = parseFloat(rangeMatch[2]);
      } else {
        return null;
      }
    }
    if (isNaN(low) || isNaN(high)) return null;
    return { type: "range", low, high };
  }

  if (spec.type === "min" || spec.type === "max") {
    if (!spec.value) return null;
    const num = parseFloat(spec.value);
    if (isNaN(num)) return null;
    return { type: spec.type, value: num };
  }

  if (spec.type === "match") {
    if (spec.value === undefined) return null;
    const num = parseFloat(spec.value);
    if (!isNaN(num)) return { type: "match", value: num };
    if (spec.value === "true") return { type: "match", value: true };
    if (spec.value === "false") return { type: "match", value: false };
    return { type: "match", value: spec.value };
  }

  return null;
}

// ─── Auto DataSource Registration ───

// ─── Dedup helpers ───

interface DatasourceConfig {
  type?: string;
  connection?: { commands?: Record<string, unknown>; path?: string };
  dimension_mapping?: Record<string, unknown>;
  scope_goal_id?: string;
}

/**
 * Load all existing datasource configs from the datasources directory.
 * Returns an empty array if the directory does not exist or cannot be read.
 */
export async function loadExistingDatasources(datasourcesDir: string): Promise<DatasourceConfig[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(datasourcesDir);
  } catch {
    return [];
  }
  const results: DatasourceConfig[] = [];
  for (const file of entries.filter((f) => f.endsWith(".json"))) {
    try {
      const raw = await fsp.readFile(path.join(datasourcesDir, file), "utf-8");
      results.push(JSON.parse(raw) as DatasourceConfig);
    } catch {
      // Skip unreadable files
    }
  }
  return results;
}

/**
 * Returns true if an existing shell datasource already covers the exact same
 * set of dimension names, path, and scope_goal_id.
 * Dedup requires all three to match to avoid reusing a datasource from a
 * different goal or workspace path.
 */
function shellDatasourceExists(
  existing: DatasourceConfig[],
  dimensionNames: string[],
  workspacePath: string,
  goalId: string
): boolean {
  const sorted = [...dimensionNames].sort().join(",");
  return existing.some((cfg) => {
    if (cfg.type !== "shell") return false;
    const commands = cfg.connection?.commands ?? {};
    const existingDims = Object.keys(commands).sort().join(",");
    if (existingDims !== sorted) return false;
    if (cfg.connection?.path !== workspacePath) return false;
    if (cfg.scope_goal_id !== goalId) return false;
    return true;
  });
}

/**
 * Returns true if an existing file_existence datasource already covers the
 * exact same set of dimension names, path, and scope_goal_id.
 * Dedup requires all three to match to avoid reusing a datasource from a
 * different goal or workspace path.
 */
function fileExistenceDatasourceExists(
  existing: DatasourceConfig[],
  dimensionNames: string[],
  workspacePath: string,
  goalId: string
): boolean {
  const sorted = [...dimensionNames].sort().join(",");
  return existing.some((cfg) => {
    if (cfg.type !== "file_existence") return false;
    const dimMapping = cfg.dimension_mapping ?? {};
    const existingDims = Object.keys(dimMapping).sort().join(",");
    if (existingDims !== sorted) return false;
    if (cfg.connection?.path !== workspacePath) return false;
    if (cfg.scope_goal_id !== goalId) return false;
    return true;
  });
}

export async function autoRegisterFileExistenceDataSources(
  stateManager: StateManager,
  dimensions: Array<{ name: string; label?: string }>,
  goalDescription: string,
  goalId: string,
  constraints?: string[]
): Promise<void> {
  try {
    const fileExistenceDims = dimensions.filter((d) =>
      /_exists$|_file$|_present$|file_existence/.test(d.name)
    );
    if (fileExistenceDims.length === 0) return;

    const filePathPattern = /\b([\w.\-/]+\.\w{1,10})\b/g;
    const candidateFiles: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = filePathPattern.exec(goalDescription)) !== null) {
      candidateFiles.push(m[1]);
    }

    for (const dim of fileExistenceDims) {
      if (dim.label) {
        const labelPattern = /\b([\w.\-/]+\.\w{1,10})\b/g;
        let m2: RegExpExecArray | null;
        while ((m2 = labelPattern.exec(dim.label)) !== null) {
          if (!candidateFiles.includes(m2[1])) {
            candidateFiles.push(m2[1]);
          }
        }
      }
    }

    const dimensionMapping: Record<string, string> = {};
    for (const dim of fileExistenceDims) {
      const dimBase = dim.name
        .replace(/_exists$/, "")
        .replace(/_file$/, "")
        .replace(/_/g, "")
        .toLowerCase();
      let matched = candidateFiles.find((f) => {
        const fBase = path.basename(f).replace(/[._-]/g, "").toLowerCase();
        return fBase.includes(dimBase) || dimBase.includes(fBase);
      });
      if (!matched && dim.label) {
        const labelFilePattern = /\b([\w.\-/]+\.\w{1,10})\b/g;
        let lm: RegExpExecArray | null;
        while ((lm = labelFilePattern.exec(dim.label)) !== null) {
          const labelFile = lm[1];
          if (candidateFiles.includes(labelFile)) {
            matched = labelFile;
            break;
          }
        }
      }
      if (matched) {
        dimensionMapping[dim.name] = matched;
      } else if (candidateFiles.length === 1) {
        dimensionMapping[dim.name] = candidateFiles[0];
      }
    }

    if (Object.keys(dimensionMapping).length === 0) return;

    const datasourcesDir = getDatasourcesDir(stateManager.getBaseDir());
    await fsp.mkdir(datasourcesDir, { recursive: true });

    const workspacePath = constraints
      ?.find((c) => c.startsWith("workspace_path:"))
      ?.slice("workspace_path:".length) ?? process.cwd();

    const existing = await loadExistingDatasources(datasourcesDir);
    if (fileExistenceDatasourceExists(existing, Object.keys(dimensionMapping), workspacePath, goalId)) {
      getCliLogger().info(
        `[auto] Skipping FileExistenceDataSource registration — duplicate already exists for: ${Object.keys(dimensionMapping).join(", ")}`
      );
      return;
    }

    const dimKeys = Object.keys(dimensionMapping).sort().join("_");
    const id = `ds_auto_${goalId}_${dimKeys}`;
    const config = {
      id,
      name: `auto:file_existence (${Object.values(dimensionMapping).join(", ")})`,
      type: "file_existence",
      connection: { path: workspacePath },
      dimension_mapping: dimensionMapping,
      scope_goal_id: goalId,
      enabled: true,
      created_at: new Date().toISOString(),
    };

    const configPath = path.join(datasourcesDir, `${id}.json`);
    await writeJsonFile(configPath, config);

    getCliLogger().info(
      `[auto] Registered FileExistenceDataSource for: ${Object.keys(dimensionMapping).join(", ")}`
    );
  } catch (err) {
    getCliLogger().error(formatOperationError("auto-register file existence data sources", err));
  }
}

/**
 * Find a shell pattern for a dimension name.
 * Tries exact match first, then fuzzy (dimName contains key or key contains dimName).
 * Returns undefined if no match found.
 */
export function findShellPattern(dimName: string): ShellCommandConfig | undefined {
  if (SHELL_DIMENSION_PATTERNS[dimName]) return SHELL_DIMENSION_PATTERNS[dimName];
  for (const [key, pattern] of Object.entries(SHELL_DIMENSION_PATTERNS)) {
    if (dimName.includes(key)) return pattern;
  }
  return undefined;
}

export async function autoRegisterShellDataSources(
  stateManager: StateManager,
  dimensions: Array<{ name: string }>,
  goalId: string,
  constraints?: string[]
): Promise<void> {
  try {
    // Collect dimensions that match known shell patterns
    const matchedCommands: Record<string, ShellCommandConfig> = {};
    for (const dim of dimensions) {
      const pattern = findShellPattern(dim.name);
      if (pattern) {
        matchedCommands[dim.name] = pattern;
      }
    }

    if (Object.keys(matchedCommands).length === 0) return;

    const datasourcesDir = getDatasourcesDir(stateManager.getBaseDir());
    await fsp.mkdir(datasourcesDir, { recursive: true });

    const wsConstraint = constraints?.find((c) => c.startsWith("workspace_path:"));
    const workspacePath = wsConstraint ? wsConstraint.slice("workspace_path:".length) : process.cwd();

    const existing = await loadExistingDatasources(datasourcesDir);
    if (shellDatasourceExists(existing, Object.keys(matchedCommands), workspacePath, goalId)) {
      getCliLogger().info(
        `[auto] Skipping ShellDataSource registration — duplicate already exists for: ${Object.keys(matchedCommands).join(", ")}`
      );
      return;
    }

    const id = `ds_auto_shell_${goalId}_${Object.keys(matchedCommands).sort().join("_")}`;

    // Serialize commands in the format ShellDataSourceAdapter expects:
    // Record<dimensionName, ShellCommandSpec>
    const commandsConfig: Record<string, { argv: string[]; output_type: string; timeout_ms?: number }> = {};
    for (const [dimName, spec] of Object.entries(matchedCommands)) {
      commandsConfig[dimName] = { argv: spec.argv, output_type: spec.output_type, ...(spec.timeout_ms ? { timeout_ms: spec.timeout_ms } : {}) };
    }

    const config = {
      id,
      name: `auto:shell (${Object.keys(matchedCommands).join(", ")})`,
      type: "shell",
      connection: { path: workspacePath, commands: commandsConfig },
      scope_goal_id: goalId,
      enabled: true,
      created_at: new Date().toISOString(),
    };

    const configPath = path.join(datasourcesDir, `${id}.json`);
    await writeJsonFile(configPath, config);

    getCliLogger().info(
      `[auto] Registered ShellDataSource for: ${Object.keys(matchedCommands).join(", ")}`
    );
  } catch (err) {
    getCliLogger().error(formatOperationError("auto-register shell data sources", err));
  }
}
