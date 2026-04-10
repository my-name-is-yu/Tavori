import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { RuntimeHealthStore } from "../store/health-store.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import { RuntimeHealthSnapshotSchema, evolveRuntimeHealthKpi } from "../store/runtime-schemas.js";

describe("RuntimeHealthStore", () => {
  let tmpDir: string;
  let store: RuntimeHealthStore;

  beforeEach(() => {
    tmpDir = makeTempDir();
    store = new RuntimeHealthStore(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("saves and loads a combined health snapshot", async () => {
    const snapshot = RuntimeHealthSnapshotSchema.parse({
      status: "degraded",
      leader: true,
      checked_at: 123,
      components: {
        gateway: "ok",
        queue: "degraded",
      },
      kpi: evolveRuntimeHealthKpi(null, {
        process_alive: "ok",
        command_acceptance: "degraded",
        task_execution: "ok",
      }, 123),
      details: { lag: 3 },
    });

    await store.saveSnapshot(snapshot);
    const daemonPath = path.join(tmpDir, "health", "daemon.json");
    const componentsPath = path.join(tmpDir, "health", "components.json");

    expect(fs.existsSync(daemonPath)).toBe(true);
    expect(fs.existsSync(componentsPath)).toBe(true);

    const loaded = await store.loadSnapshot();
    expect(loaded).toMatchObject({
      status: snapshot.status,
      leader: snapshot.leader,
      checked_at: snapshot.checked_at,
      components: snapshot.components,
      details: snapshot.details,
    });
    expect(loaded?.kpi?.command_acceptance.status).toBe("degraded");
  });

  it("returns null for a partial health state", async () => {
    await store.saveDaemonHealth({
      status: "ok",
      leader: false,
      checked_at: 1,
    });
    expect(await store.loadSnapshot()).toBeNull();
  });

  it("loads the individual health records", async () => {
    await store.saveDaemonHealth({
      status: "ok",
      leader: true,
      checked_at: 1,
      kpi: evolveRuntimeHealthKpi(null, {
        process_alive: "ok",
        command_acceptance: "ok",
        task_execution: "ok",
      }, 1),
    });
    await store.saveComponentsHealth({
      checked_at: 2,
      components: { gateway: "ok", queue: "ok" },
    });

    expect(await store.loadDaemonHealth()).toMatchObject({ leader: true });
    expect(await store.loadComponentsHealth()).toMatchObject({ components: { gateway: "ok" } });
  });

  it("preserves KPI data when repairing a partial snapshot", async () => {
    await store.saveDaemonHealth({
      status: "degraded",
      leader: true,
      checked_at: 50,
      kpi: evolveRuntimeHealthKpi(null, {
        process_alive: "ok",
        command_acceptance: "degraded",
        task_execution: "ok",
      }, 50),
    });

    const repaired = await store.reconcile(100);
    expect(repaired.kpi).toBeDefined();
    expect(repaired.kpi?.command_acceptance.status).toBe("degraded");
  });
});
