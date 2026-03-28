import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { FileExistenceDataSourceAdapter } from "../src/adapters/file-existence-datasource.js";
import type { DataSourceConfig } from "../src/types/data-source.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Helpers ───

function makeConfig(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: "ds_file_existence_test",
    name: "File Existence Test",
    type: "file_existence",
    connection: {},
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ───

describe("FileExistenceDataSourceAdapter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns value=1 when the mapped file exists", async () => {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test");
    const adapter = new FileExistenceDataSourceAdapter(
      makeConfig({
        connection: { path: tmpDir },
        dimension_mapping: { readme_created: "README.md" },
      })
    );

    const result = await adapter.query({ dimension_name: "readme_created", timeout_ms: 5000 });
    expect(result.value).toBe(1);
    expect((result.raw as { exists: boolean }).exists).toBe(true);
  });

  it("returns value=0 when the mapped file does not exist", async () => {
    const adapter = new FileExistenceDataSourceAdapter(
      makeConfig({
        connection: { path: tmpDir },
        dimension_mapping: { guide_created: "GUIDE.md" },
      })
    );

    const result = await adapter.query({ dimension_name: "guide_created", timeout_ms: 5000 });
    expect(result.value).toBe(0);
    expect((result.raw as { exists: boolean }).exists).toBe(false);
  });

  it("returns value=null for unknown dimensions not in dimension_mapping", async () => {
    const adapter = new FileExistenceDataSourceAdapter(
      makeConfig({
        connection: { path: tmpDir },
        dimension_mapping: { readme_created: "README.md" },
      })
    );

    const result = await adapter.query({ dimension_name: "nonexistent_dimension", timeout_ms: 5000 });
    expect(result.value).toBeNull();
  });

  it("getSupportedDimensions returns the configured dimension names", () => {
    const adapter = new FileExistenceDataSourceAdapter(
      makeConfig({
        connection: { path: tmpDir },
        dimension_mapping: {
          readme_created: "README.md",
          getting_started_guide_created: "GETTING_STARTED.md",
        },
      })
    );

    const dims = adapter.getSupportedDimensions();
    expect(dims).toContain("readme_created");
    expect(dims).toContain("getting_started_guide_created");
    expect(dims).toHaveLength(2);
  });

  it("getSupportedDimensions returns empty array when no dimension_mapping configured", () => {
    const adapter = new FileExistenceDataSourceAdapter(
      makeConfig({ connection: { path: tmpDir } })
    );

    expect(adapter.getSupportedDimensions()).toEqual([]);
  });

  it("connect() resolves without throwing", async () => {
    const adapter = new FileExistenceDataSourceAdapter(makeConfig({ connection: { path: tmpDir } }));
    await expect(adapter.connect()).resolves.toBeUndefined();
  });

  it("disconnect() resolves without throwing", async () => {
    const adapter = new FileExistenceDataSourceAdapter(makeConfig({ connection: { path: tmpDir } }));
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });

  it("healthCheck() returns true", async () => {
    const adapter = new FileExistenceDataSourceAdapter(makeConfig({ connection: { path: tmpDir } }));
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it("uses process.cwd() as default baseDir when connection.path is not configured", async () => {
    const adapter = new FileExistenceDataSourceAdapter(
      makeConfig({
        connection: {},
        // Map to a filename unlikely to exist in cwd so we get 0 (not an error)
        dimension_mapping: { some_file: "__pulseed_unlikely_file_xyz__.txt" },
      })
    );

    // Should not throw — just returns 0 since file doesn't exist in cwd
    const result = await adapter.query({ dimension_name: "some_file", timeout_ms: 5000 });
    expect(result.value).toBe(0);
    expect(result.source_id).toBe("ds_file_existence_test");
  });

  it("uses expression as filename directly when ObservationEngine passes mapped value", async () => {
    fs.writeFileSync(path.join(tmpDir, "TARGET.md"), "# Target");
    const adapter = new FileExistenceDataSourceAdapter(
      makeConfig({
        connection: { path: tmpDir },
        dimension_mapping: { aliased_dim: "TARGET.md" },
      })
    );

    // ObservationEngine reads dimension_mapping and passes the value as expression
    const result = await adapter.query({
      dimension_name: "ignored_dim",
      expression: "TARGET.md",
      timeout_ms: 5000,
    });
    expect(result.value).toBe(1);
  });

  it("result includes timestamp and source_id", async () => {
    const adapter = new FileExistenceDataSourceAdapter(
      makeConfig({
        id: "ds_custom_id",
        connection: { path: tmpDir },
        dimension_mapping: { readme_created: "README.md" },
      })
    );

    const result = await adapter.query({ dimension_name: "readme_created", timeout_ms: 5000 });
    expect(result.source_id).toBe("ds_custom_id");
    expect(typeof result.timestamp).toBe("string");
  });
});
