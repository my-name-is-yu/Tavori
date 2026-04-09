import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StateManager } from "../../../base/state/state-manager.js";
import { getDatasourcesDir } from "../../../base/utils/paths.js";
import { cmdDatasourceAdd } from "../commands/config.js";
import { createCliDataSourceAdapter } from "../setup.js";
import { PostgresDataSourceAdapter } from "../../../platform/observation/data-source-adapter.js";

describe("cmdDatasourceAdd(database)", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-datasource-command-"));
    stateManager = new StateManager(tmpDir);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("writes a database datasource config with a dimension mapping", async () => {
    const exitCode = await cmdDatasourceAdd(stateManager, [
      "database",
      "--connection-string",
      "postgresql://localhost:5432/analytics",
      "--dimension",
      "open_issue_count",
      "--query",
      "SELECT count(*) FROM issues WHERE state = 'open'",
    ]);

    expect(exitCode).toBe(0);

    const datasourcesDir = getDatasourcesDir(stateManager.getBaseDir());
    const [filename] = fs.readdirSync(datasourcesDir);
    const saved = JSON.parse(
      fs.readFileSync(path.join(datasourcesDir, filename!), "utf-8")
    ) as {
      id: string;
      type: string;
      connection_string?: string;
      dimension_mapping?: Record<string, string>;
    };

    expect(saved.type).toBe("database");
    expect(saved.connection_string).toBe("postgresql://localhost:5432/analytics");
    expect(saved.dimension_mapping).toEqual({
      [saved.id!]: "SELECT count(*) FROM issues WHERE state = 'open'",
      open_issue_count: "SELECT count(*) FROM issues WHERE state = 'open'",
    });
  });

  it("accepts postgres as an alias for database", async () => {
    const exitCode = await cmdDatasourceAdd(stateManager, [
      "postgres",
      "--connection-string",
      "postgresql://localhost:5432/app",
      "--query",
      "SELECT 1",
    ]);

    expect(exitCode).toBe(0);

    const datasourcesDir = getDatasourcesDir(stateManager.getBaseDir());
    const [filename] = fs.readdirSync(datasourcesDir);
    const saved = JSON.parse(
      fs.readFileSync(path.join(datasourcesDir, filename!), "utf-8")
    ) as { type: string };

    expect(saved.type).toBe("database");
  });
});

describe("createCliDataSourceAdapter", () => {
  it("maps database datasources to PostgresDataSourceAdapter", () => {
    const adapter = createCliDataSourceAdapter({
      id: "db-source",
      name: "Analytics DB",
      type: "database",
      connection: {},
      connection_string: "postgresql://localhost:5432/analytics",
      dimension_mapping: {
        open_issue_count: "SELECT count(*) FROM issues WHERE state = 'open'",
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    expect(adapter).toBeInstanceOf(PostgresDataSourceAdapter);
  });
});
