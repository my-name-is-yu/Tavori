import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { cmdDatasourceDedup } from "../commands/config.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

// ─── Minimal StateManager stub ───

function makeFakeStateManager(baseDir: string) {
  return { getBaseDir: () => baseDir };
}

// ─── Helpers ───

function writeDatasource(datasourcesDir: string, filename: string, cfg: Record<string, unknown>): void {
  fs.mkdirSync(datasourcesDir, { recursive: true });
  fs.writeFileSync(path.join(datasourcesDir, filename), JSON.stringify(cfg));
}

function listFiles(datasourcesDir: string): string[] {
  if (!fs.existsSync(datasourcesDir)) return [];
  return fs.readdirSync(datasourcesDir).filter((f) => f.endsWith(".json")).sort();
}

// ─── Tests ───

describe("cmdDatasourceDedup", () => {
  let tmpDir: string;
  let datasourcesDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    datasourcesDir = path.join(tmpDir, "datasources");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("returns 0 and prints no-op message when datasources dir does not exist", async () => {
    const sm = makeFakeStateManager(tmpDir);
    const result = await cmdDatasourceDedup(sm as never);
    expect(result).toBe(0);
    // Dir was never created
    expect(fs.existsSync(datasourcesDir)).toBe(false);
  });

  it("returns 0 when no duplicate datasources exist", async () => {
    writeDatasource(datasourcesDir, "ds_shell_a.json", {
      id: "ds_shell_a",
      type: "shell",
      connection: { commands: { todo_count: {}, test_count: {} } },
    });
    writeDatasource(datasourcesDir, "ds_file_b.json", {
      id: "ds_file_b",
      type: "file_existence",
      dimension_mapping: { readme_exists: "README.md" },
    });

    const sm = makeFakeStateManager(tmpDir);
    const result = await cmdDatasourceDedup(sm as never);
    expect(result).toBe(0);
    expect(listFiles(datasourcesDir)).toHaveLength(2);
  });

  it("removes duplicate shell datasources and keeps the first (alphabetically sorted)", async () => {
    // ds_a comes first alphabetically — should be kept
    writeDatasource(datasourcesDir, "ds_a_shell.json", {
      id: "ds_a_shell",
      type: "shell",
      connection: { commands: { todo_count: {}, test_count: {} } },
    });
    writeDatasource(datasourcesDir, "ds_b_shell.json", {
      id: "ds_b_shell",
      type: "shell",
      connection: { commands: { test_count: {}, todo_count: {} } }, // same dims, different order
    });

    const sm = makeFakeStateManager(tmpDir);
    const result = await cmdDatasourceDedup(sm as never);
    expect(result).toBe(0);

    const remaining = listFiles(datasourcesDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe("ds_a_shell.json");
  });

  it("removes duplicate file_existence datasources and keeps the first", async () => {
    writeDatasource(datasourcesDir, "ds_1_fe.json", {
      id: "ds_1_fe",
      type: "file_existence",
      dimension_mapping: { src_exists: "src/", readme_exists: "README.md" },
    });
    writeDatasource(datasourcesDir, "ds_2_fe.json", {
      id: "ds_2_fe",
      type: "file_existence",
      dimension_mapping: { readme_exists: "README.md", src_exists: "src/" }, // same dims
    });

    const sm = makeFakeStateManager(tmpDir);
    const result = await cmdDatasourceDedup(sm as never);
    expect(result).toBe(0);

    const remaining = listFiles(datasourcesDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe("ds_1_fe.json");
  });

  it("only removes duplicates within same type — does not cross types", async () => {
    // A shell and a file_existence datasource that happen to have same dim names
    // should NOT be treated as duplicates of each other
    writeDatasource(datasourcesDir, "ds_shell.json", {
      id: "ds_shell",
      type: "shell",
      connection: { commands: { test_count: {} } },
    });
    writeDatasource(datasourcesDir, "ds_fe.json", {
      id: "ds_fe",
      type: "file_existence",
      dimension_mapping: { test_count: "tests/" },
    });

    const sm = makeFakeStateManager(tmpDir);
    const result = await cmdDatasourceDedup(sm as never);
    expect(result).toBe(0);

    // Both should remain — different types
    expect(listFiles(datasourcesDir)).toHaveLength(2);
  });

  it("handles multiple duplicates in the same group correctly", async () => {
    for (let i = 1; i <= 4; i++) {
      writeDatasource(datasourcesDir, `ds_shell_${i}.json`, {
        id: `ds_shell_${i}`,
        type: "shell",
        connection: { commands: { todo_count: {} } },
      });
    }

    const sm = makeFakeStateManager(tmpDir);
    const result = await cmdDatasourceDedup(sm as never);
    expect(result).toBe(0);

    const remaining = listFiles(datasourcesDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe("ds_shell_1.json");
  });

  it("returns 0 when datasources directory is empty", async () => {
    fs.mkdirSync(datasourcesDir, { recursive: true });
    const sm = makeFakeStateManager(tmpDir);
    const result = await cmdDatasourceDedup(sm as never);
    expect(result).toBe(0);
    expect(listFiles(datasourcesDir)).toHaveLength(0);
  });
});
