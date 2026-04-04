import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  autoRegisterShellDataSources,
  autoRegisterFileExistenceDataSources,
  SHELL_DIMENSION_PATTERNS,
} from "../../../interface/cli/commands/goal-utils.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

// ─── Minimal StateManager stub ───

function makeFakeStateManager(baseDir: string) {
  return {
    getBaseDir: () => baseDir,
  };
}

// ─── Helpers ───

function readDsConfigs(datasourcesDir: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(datasourcesDir)) return [];
  return fs
    .readdirSync(datasourcesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(datasourcesDir, f), "utf-8")));
}

// ─── Tests ───

describe("autoRegisterShellDataSources", () => {
  let tmpDir: string;
  let datasourcesDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    datasourcesDir = path.join(tmpDir, "datasources");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
  });

  it("creates a shell datasource config for todo_count dimension", async () => {
    const sm = makeFakeStateManager(tmpDir);
    await autoRegisterShellDataSources(
      sm as never,
      [{ name: "todo_count" }],
      "goal_abc"
    );

    const configs = readDsConfigs(datasourcesDir);
    expect(configs).toHaveLength(1);
    const cfg = configs[0];
    expect(cfg.type).toBe("shell");
    expect(cfg.scope_goal_id).toBe("goal_abc");
    expect(cfg.enabled).toBe(true);
    const conn = cfg.connection as { path: string; commands: Record<string, { argv: string[]; output_type: string }> };
    const commands = conn.commands;
    expect(commands).toHaveProperty("todo_count");
    expect(commands.todo_count.argv).toContain("grep");
    expect(commands.todo_count.output_type).toBe("number");
  });

  it("creates a shell datasource config for fixme_count dimension", async () => {
    const sm = makeFakeStateManager(tmpDir);
    await autoRegisterShellDataSources(
      sm as never,
      [{ name: "fixme_count" }],
      "goal_xyz"
    );

    const configs = readDsConfigs(datasourcesDir);
    expect(configs).toHaveLength(1);
    const conn74 = configs[0].connection as { path: string; commands: Record<string, { argv: string[]; output_type: string }> };
    const commands = conn74.commands;
    expect(commands).toHaveProperty("fixme_count");
    expect(commands.fixme_count.argv.some((a: string) => a.includes("FIXME"))).toBe(true);
    expect(commands.fixme_count.output_type).toBe("number");
  });

  it("skips dimensions with no matching pattern", async () => {
    const sm = makeFakeStateManager(tmpDir);
    await autoRegisterShellDataSources(
      sm as never,
      [{ name: "readme_quality" }, { name: "some_unknown_metric" }],
      "goal_skip"
    );

    const configs = readDsConfigs(datasourcesDir);
    expect(configs).toHaveLength(0);
  });

  it("produces valid JSON with the correct structure", async () => {
    const sm = makeFakeStateManager(tmpDir);
    await autoRegisterShellDataSources(
      sm as never,
      [{ name: "todo_count" }],
      "goal_json"
    );

    const configs = readDsConfigs(datasourcesDir);
    expect(configs).toHaveLength(1);
    const cfg = configs[0];

    // Required top-level fields
    expect(typeof cfg.id).toBe("string");
    expect(typeof cfg.name).toBe("string");
    expect(cfg.type).toBe("shell");
    expect(typeof cfg.created_at).toBe("string");
    expect(cfg.enabled).toBe(true);

    // connection must have path
    const conn = cfg.connection as { path: string };
    expect(typeof conn.path).toBe("string");

    // commands must be an object with at least one key (stored under connection.commands)
    const connCmds = (cfg.connection as { path: string; commands: Record<string, unknown> }).commands;
    expect(Object.keys(connCmds).length).toBeGreaterThan(0);
  });

  it("creates a single datasource with multiple commands for multiple matching dimensions", async () => {
    const sm = makeFakeStateManager(tmpDir);
    await autoRegisterShellDataSources(
      sm as never,
      [{ name: "todo_count" }, { name: "fixme_count" }],
      "goal_multi"
    );

    const configs = readDsConfigs(datasourcesDir);
    // Both dimensions should be packed into ONE datasource file
    expect(configs).toHaveLength(1);
    const connMulti = configs[0].connection as { path: string; commands: Record<string, unknown> };
    const commands = connMulti.commands;
    expect(commands).toHaveProperty("todo_count");
    expect(commands).toHaveProperty("fixme_count");
  });

  it("does not create a datasource when dimensions array is empty", async () => {
    const sm = makeFakeStateManager(tmpDir);
    await autoRegisterShellDataSources(sm as never, [], "goal_empty");

    const configs = readDsConfigs(datasourcesDir);
    expect(configs).toHaveLength(0);
  });

  it("creates the datasources directory if it does not exist", async () => {
    const sm = makeFakeStateManager(tmpDir);
    expect(fs.existsSync(datasourcesDir)).toBe(false);

    await autoRegisterShellDataSources(
      sm as never,
      [{ name: "todo_count" }],
      "goal_mkdir"
    );

    expect(fs.existsSync(datasourcesDir)).toBe(true);
  });

  it("does not create a duplicate shell datasource for the same goal, dimensions, and path", async () => {
    const sm = makeFakeStateManager(tmpDir);

    // First registration
    await autoRegisterShellDataSources(
      sm as never,
      [{ name: "todo_count" }],
      "goal_first"
    );

    // Second registration with same goal ID, dimension, and path — exact duplicate
    await autoRegisterShellDataSources(
      sm as never,
      [{ name: "todo_count" }],
      "goal_first"
    );

    const configs = readDsConfigs(datasourcesDir);
    // Should still be exactly 1 — the second call was a no-op
    expect(configs).toHaveLength(1);
  });

  it("creates separate shell datasources for different goalIds with same dimensions", async () => {
    const sm = makeFakeStateManager(tmpDir);

    // First registration
    await autoRegisterShellDataSources(
      sm as never,
      [{ name: "todo_count" }],
      "goal_first"
    );

    // Second registration with same dimension but different goalId — should create a new entry
    await autoRegisterShellDataSources(
      sm as never,
      [{ name: "todo_count" }],
      "goal_second"
    );

    const configs = readDsConfigs(datasourcesDir);
    // Two separate datasources — one per goal
    expect(configs).toHaveLength(2);
  });

  it("does not create a duplicate when dimensions are same, same goalId, same path but different order", async () => {
    const sm = makeFakeStateManager(tmpDir);

    await autoRegisterShellDataSources(
      sm as never,
      [{ name: "todo_count" }, { name: "fixme_count" }],
      "goal_order_a"
    );

    // Same dimensions, reversed order, same goalId — exact duplicate
    await autoRegisterShellDataSources(
      sm as never,
      [{ name: "fixme_count" }, { name: "todo_count" }],
      "goal_order_a"
    );

    const configs = readDsConfigs(datasourcesDir);
    expect(configs).toHaveLength(1);
  });

  it("creates a new datasource when the dimension set differs from existing ones", async () => {
    const sm = makeFakeStateManager(tmpDir);

    await autoRegisterShellDataSources(
      sm as never,
      [{ name: "todo_count" }],
      "goal_a"
    );

    // Different dimension set — should create a second entry
    await autoRegisterShellDataSources(
      sm as never,
      [{ name: "fixme_count" }],
      "goal_b"
    );

    const configs = readDsConfigs(datasourcesDir);
    expect(configs).toHaveLength(2);
  });
});

// ─── Dedup: autoRegisterFileExistenceDataSources ───

describe("autoRegisterFileExistenceDataSources — dedup", () => {
  let tmpDir: string;
  let datasourcesDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    datasourcesDir = path.join(tmpDir, "datasources");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
  });

  it("does not create a duplicate file_existence datasource for the same dimension, path, and goalId", async () => {
    const sm = makeFakeStateManager(tmpDir);
    const dims = [{ name: "readme_md_exists", label: "README.md Exists" }];

    // First registration
    await autoRegisterFileExistenceDataSources(
      sm as never,
      dims,
      "Ensure README.md exists",
      "goal_first"
    );

    // Second registration — same dimension, same goalId, same path (process.cwd() default)
    await autoRegisterFileExistenceDataSources(
      sm as never,
      dims,
      "Ensure README.md exists",
      "goal_first"
    );

    const configs = readDsConfigs(datasourcesDir);
    const feConfigs = configs.filter((c) => c["type"] === "file_existence");
    // Only one file_existence datasource should exist (exact duplicate)
    expect(feConfigs).toHaveLength(1);
  });

  it("creates separate file_existence datasources for different goalIds", async () => {
    const sm = makeFakeStateManager(tmpDir);
    const dims = [{ name: "readme_md_exists", label: "README.md Exists" }];

    // First registration for goal_first
    await autoRegisterFileExistenceDataSources(
      sm as never,
      dims,
      "Ensure README.md exists",
      "goal_first"
    );

    // Second registration for goal_second — different goalId should produce a new entry
    await autoRegisterFileExistenceDataSources(
      sm as never,
      dims,
      "Ensure README.md exists",
      "goal_second"
    );

    const configs = readDsConfigs(datasourcesDir);
    const feConfigs = configs.filter((c) => c["type"] === "file_existence");
    // Two separate datasources — one per goal
    expect(feConfigs).toHaveLength(2);
  });
});

// ─── SHELL_DIMENSION_PATTERNS sanity checks ───

describe("SHELL_DIMENSION_PATTERNS", () => {
  it("contains entries for todo_count and fixme_count", () => {
    expect(SHELL_DIMENSION_PATTERNS).toHaveProperty("todo_count");
    expect(SHELL_DIMENSION_PATTERNS).toHaveProperty("fixme_count");
  });

  it("contains entry for tsc_error_count", () => {
    expect(SHELL_DIMENSION_PATTERNS).toHaveProperty("tsc_error_count");
    const spec = SHELL_DIMENSION_PATTERNS.tsc_error_count;
    expect(spec.output_type).toBe("number");
    expect(spec.argv).toContain("tsc");
  });

  it("contains entry for test_coverage", () => {
    expect(SHELL_DIMENSION_PATTERNS).toHaveProperty("test_coverage");
    const spec = SHELL_DIMENSION_PATTERNS.test_coverage;
    expect(spec.output_type).toBe("raw");
    expect(spec.argv.some((a: string) => a.includes("node") || a.includes("coverage"))).toBe(true);
  });

  it("all entries have an argv array and valid output_type", () => {
    for (const [name, spec] of Object.entries(SHELL_DIMENSION_PATTERNS)) {
      expect(Array.isArray(spec.argv), `${name}.argv should be array`).toBe(true);
      expect(spec.argv.length, `${name}.argv should be non-empty`).toBeGreaterThan(0);
      expect(["number", "boolean", "raw"]).toContain(spec.output_type);
    }
  });

  it("todo_count uses grep with simple pattern", () => {
    const spec = SHELL_DIMENSION_PATTERNS.todo_count;
    expect(spec.argv[0]).toBe("grep");
    expect(spec.argv).toContain("-rc");
    expect(spec.argv.some(a => a.includes("TODO"))).toBe(true);
  });

  it("fixme_count uses grep with simple pattern", () => {
    const spec = SHELL_DIMENSION_PATTERNS.fixme_count;
    expect(spec.argv[0]).toBe("grep");
    expect(spec.argv).toContain("-rc");
    expect(spec.argv.some(a => a.includes("FIXME"))).toBe(true);
  });
});
