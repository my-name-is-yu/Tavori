import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { cmdCleanup } from "../src/cli/commands/goal-write.js";
import { makeTempDir, cleanupTempDir } from "./helpers/temp-dir.js";

// ─── Minimal StateManager stub ───

function makeFakeStateManager(baseDir: string, goalIds: string[] = []) {
  return {
    getBaseDir: () => baseDir,
    listGoalIds: async () => goalIds,
    loadGoal: async (_id: string) => null,
    archiveGoal: async (_id: string) => true,
  };
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

describe("cmdCleanup — orphaned datasource removal", () => {
  let tmpDir: string;
  let datasourcesDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    datasourcesDir = path.join(tmpDir, "datasources");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("removes orphaned datasource when scope_goal_id points to non-existent goal", async () => {
    writeDatasource(datasourcesDir, "ds_orphan.json", {
      id: "ds_orphan",
      type: "shell",
      scope_goal_id: "goal-deleted-123",
      connection: { commands: { test_count: {} } },
    });

    const sm = makeFakeStateManager(tmpDir, []); // no active goals
    const result = await cmdCleanup(sm as never);
    expect(result).toBe(0);
    expect(listFiles(datasourcesDir)).toHaveLength(0);
  });

  it("keeps datasource when scope_goal_id points to an existing active goal", async () => {
    writeDatasource(datasourcesDir, "ds_valid.json", {
      id: "ds_valid",
      type: "shell",
      scope_goal_id: "goal-active-456",
      connection: { commands: { test_count: {} } },
    });

    const sm = makeFakeStateManager(tmpDir, ["goal-active-456"]);
    const result = await cmdCleanup(sm as never);
    expect(result).toBe(0);
    expect(listFiles(datasourcesDir)).toHaveLength(1);
    expect(listFiles(datasourcesDir)[0]).toBe("ds_valid.json");
  });

  it("keeps manual datasource that has no scope_goal_id", async () => {
    writeDatasource(datasourcesDir, "ds_manual.json", {
      id: "ds_manual",
      type: "file_existence",
      dimension_mapping: { readme_exists: "README.md" },
    });

    const sm = makeFakeStateManager(tmpDir, []); // no active goals
    const result = await cmdCleanup(sm as never);
    expect(result).toBe(0);
    expect(listFiles(datasourcesDir)).toHaveLength(1);
    expect(listFiles(datasourcesDir)[0]).toBe("ds_manual.json");
  });

  it("does not crash when datasources directory does not exist", async () => {
    // datasourcesDir is never created
    const sm = makeFakeStateManager(tmpDir, []);
    const result = await cmdCleanup(sm as never);
    expect(result).toBe(0);
    expect(fs.existsSync(datasourcesDir)).toBe(false);
  });

  it("handles mix: removes only orphaned scoped datasources, keeps valid and manual ones", async () => {
    writeDatasource(datasourcesDir, "ds_orphan.json", {
      id: "ds_orphan",
      type: "shell",
      scope_goal_id: "goal-gone",
      connection: { commands: { test_count: {} } },
    });
    writeDatasource(datasourcesDir, "ds_valid.json", {
      id: "ds_valid",
      type: "shell",
      scope_goal_id: "goal-alive",
      connection: { commands: { test_count: {} } },
    });
    writeDatasource(datasourcesDir, "ds_manual.json", {
      id: "ds_manual",
      type: "file_existence",
      dimension_mapping: { readme_exists: "README.md" },
    });

    const sm = makeFakeStateManager(tmpDir, ["goal-alive"]);
    const result = await cmdCleanup(sm as never);
    expect(result).toBe(0);

    const remaining = listFiles(datasourcesDir);
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain("ds_valid.json");
    expect(remaining).toContain("ds_manual.json");
    expect(remaining).not.toContain("ds_orphan.json");
  });
});
