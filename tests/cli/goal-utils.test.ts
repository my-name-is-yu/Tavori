import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { buildThreshold, autoRegisterFileExistenceDataSources, loadExistingDatasources, findShellPattern } from "../../src/cli/commands/goal-utils.js";

// ─── fileExistenceDatasourceExists dedup tests ───
// Tested indirectly via autoRegisterFileExistenceDataSources

describe("autoRegisterFileExistenceDataSources — dedup by path and scope_goal_id", () => {
  let tmpDir: string;
  let datasourcesDir: string;
  let fakeStateManager: { getBaseDir: () => string };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-goal-utils-test-"));
    datasourcesDir = path.join(tmpDir, "datasources");
    fs.mkdirSync(datasourcesDir, { recursive: true });
    fakeStateManager = { getBaseDir: () => tmpDir };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeDatasource(filename: string, cfg: Record<string, unknown>): void {
    fs.writeFileSync(path.join(datasourcesDir, filename), JSON.stringify(cfg));
  }

  it("skips registration when identical datasource (same dims, same path, same goalId) already exists", async () => {
    writeDatasource("existing.json", {
      id: "existing",
      type: "file_existence",
      connection: { path: "/workspace/proj" },
      dimension_mapping: { readme_exists: "README.md" },
      scope_goal_id: "goal-1",
    });

    await autoRegisterFileExistenceDataSources(
      fakeStateManager as never,
      [{ name: "readme_exists", label: "README.md must exist" }],
      "Ensure README.md is present",
      "goal-1",
      ["workspace_path:/workspace/proj"]
    );

    const files = fs.readdirSync(datasourcesDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1); // no new file added
  });

  it("registers new datasource when same dims but different workspace path", async () => {
    writeDatasource("existing.json", {
      id: "existing",
      type: "file_existence",
      connection: { path: "/workspace/old-proj" },
      dimension_mapping: { readme_exists: "README.md" },
      scope_goal_id: "goal-1",
    });

    await autoRegisterFileExistenceDataSources(
      fakeStateManager as never,
      [{ name: "readme_exists", label: "README.md must exist" }],
      "Ensure README.md is present",
      "goal-1",
      ["workspace_path:/workspace/new-proj"]
    );

    const configs = await loadExistingDatasources(datasourcesDir);
    const newEntry = configs.find(
      (c) => c.connection?.path === "/workspace/new-proj"
    );
    expect(newEntry).toBeDefined();
  });

  it("registers new datasource when same dims and path but different goalId", async () => {
    writeDatasource("existing.json", {
      id: "existing",
      type: "file_existence",
      connection: { path: "/workspace/proj" },
      dimension_mapping: { readme_exists: "README.md" },
      scope_goal_id: "goal-1",
    });

    await autoRegisterFileExistenceDataSources(
      fakeStateManager as never,
      [{ name: "readme_exists", label: "README.md must exist" }],
      "Ensure README.md is present",
      "goal-2",
      ["workspace_path:/workspace/proj"]
    );

    const configs = await loadExistingDatasources(datasourcesDir);
    const newEntry = configs.find((c) => c.scope_goal_id === "goal-2");
    expect(newEntry).toBeDefined();
  });
});

describe("buildThreshold", () => {
  describe("range type", () => {
    it("parses comma-separated range", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "7,9" })).toEqual({
        type: "range",
        low: 7,
        high: 9,
      });
    });

    it("parses hyphen-separated range", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "7-9" })).toEqual({
        type: "range",
        low: 7,
        high: 9,
      });
    });

    it("parses negative range with hyphen fallback", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "-5-5" })).toEqual({
        type: "range",
        low: -5,
        high: 5,
      });
    });

    it("parses both-negative range with hyphen fallback", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "-10--5" })).toEqual({
        type: "range",
        low: -10,
        high: -5,
      });
    });

    it("parses negative decimal range with hyphen fallback", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "-5.5-10.5" })).toEqual({
        type: "range",
        low: -5.5,
        high: 10.5,
      });
    });

    it("parses decimal comma-separated range", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "10.5,20.5" })).toEqual({
        type: "range",
        low: 10.5,
        high: 20.5,
      });
    });

    it("returns null when value is missing", () => {
      expect(buildThreshold({ name: "x", type: "range", value: undefined })).toBeNull();
    });

    it("returns null when value is not parseable", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "abc" })).toBeNull();
    });
  });
});

describe("findShellPattern", () => {
  it("returns defined pattern for test_pass_count with output_type raw and timeout_ms", () => {
    const pattern = findShellPattern("test_pass_count");
    expect(pattern).toBeDefined();
    expect(pattern!.output_type).toBe("raw");
    expect(pattern!.timeout_ms).toBe(120000);
  });
});
