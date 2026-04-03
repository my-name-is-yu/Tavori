import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DataSourceRegistry } from "../src/observation/data-source-adapter.js";
import type { IDataSourceAdapter } from "../src/observation/data-source-adapter.js";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { StateManager } from "../src/state/state-manager.js";
import type { DataSourceConfig } from "../src/types/data-source.js";
import type { ObservationMethod } from "../src/types/core.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal, makeDimension } from "./helpers/fixtures.js";

// ─── Helpers ───

function makeConfig(id: string): DataSourceConfig {
  return {
    id,
    name: `Source ${id}`,
    type: "file",
    connection: { path: "/tmp/test.json" },
    enabled: true,
    created_at: new Date().toISOString(),
  };
}

function makeAdapter(id: string, supportedDimensions: string[] = []): IDataSourceAdapter {
  return {
    sourceId: id,
    sourceType: "file" as const,
    config: makeConfig(id),
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({
      value: 0.5,
      raw: 0.5,
      timestamp: new Date().toISOString(),
      source_id: id,
    }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
    getSupportedDimensions: () => supportedDimensions,
  };
}

const defaultMethod: ObservationMethod = {
  type: "mechanical",
  source: "test-runner",
  schedule: null,
  endpoint: null,
  confidence_tier: "mechanical",
};

// ─── DataSourceRegistry.upsert() ───

describe("DataSourceRegistry.upsert()", () => {
  let registry: DataSourceRegistry;

  beforeEach(() => {
    registry = new DataSourceRegistry();
  });

  it("adds new adapter when sourceId is not yet registered", () => {
    const adapter = makeAdapter("new-source");
    registry.upsert(adapter);

    expect(registry.has("new-source")).toBe(true);
    expect(registry.getSource("new-source")).toBe(adapter);
  });

  it("replaces existing adapter with new one when sourceId already exists", () => {
    const original = makeAdapter("ds-1");
    const replacement = makeAdapter("ds-1");

    registry.register(original);
    registry.upsert(replacement);

    expect(registry.has("ds-1")).toBe(true);
    expect(registry.getSource("ds-1")).toBe(replacement);
    expect(registry.getSource("ds-1")).not.toBe(original);
  });

  it("listSources still returns the id once after upsert (no duplicates)", () => {
    const a = makeAdapter("ds-x");
    const b = makeAdapter("ds-x");

    registry.register(a);
    registry.upsert(b);

    expect(registry.listSources()).toEqual(["ds-x"]);
  });

  it("upsert on empty registry behaves like register", () => {
    expect(registry.listSources()).toEqual([]);
    registry.upsert(makeAdapter("fresh"));
    expect(registry.listSources()).toEqual(["fresh"]);
  });

  it("multiple upserts with different ids all coexist", () => {
    registry.upsert(makeAdapter("a"));
    registry.upsert(makeAdapter("b"));
    registry.upsert(makeAdapter("c"));

    expect(registry.listSources()).toEqual(["a", "b", "c"]);
  });
});

// ─── ObservationEngine dynamic datasource management ───

describe("ObservationEngine addDataSource / removeDataSource", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let engine: ObservationEngine;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    engine = new ObservationEngine(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("addDataSource makes the adapter available via getDataSources()", () => {
    const adapter = makeAdapter("dynamic-ds", ["test_dim"]);
    engine.addDataSource(adapter);

    const sources = engine.getDataSources();
    expect(sources).toContain(adapter);
  });

  it("addDataSource allows observe() to use the new source for a matching dimension", async () => {
    const goal = makeGoal({ dimensions: [makeDimension({ name: "test_dim", observation_method: defaultMethod })] });
    await stateManager.saveGoal(goal);

    const adapter = makeAdapter("dynamic-ds", ["test_dim"]);
    (adapter.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: 0.8,
      raw: 0.8,
      timestamp: new Date().toISOString(),
      source_id: "dynamic-ds",
    });

    engine.addDataSource(adapter);
    await engine.observe(goal.id, [defaultMethod]);

    expect(adapter.query).toHaveBeenCalled();
  });

  it("removeDataSource removes the adapter and returns true when found", () => {
    const adapter = makeAdapter("removable-ds", ["test_dim"]);
    engine.addDataSource(adapter);

    const result = engine.removeDataSource("removable-ds");

    expect(result).toBe(true);
    expect(engine.getDataSources()).not.toContain(adapter);
  });

  it("removeDataSource returns false for a sourceId not in dataSources", () => {
    const result = engine.removeDataSource("nonexistent-source");
    expect(result).toBe(false);
  });

  it("observe() does not use removed datasource", async () => {
    const goal = makeGoal({ dimensions: [makeDimension({ name: "test_dim", observation_method: defaultMethod })] });
    await stateManager.saveGoal(goal);

    const adapter = makeAdapter("temp-ds", ["test_dim"]);
    engine.addDataSource(adapter);
    engine.removeDataSource("temp-ds");

    await engine.observe(goal.id, [defaultMethod]);

    expect(adapter.query).not.toHaveBeenCalled();
  });

  it("addDataSource multiple times appends all adapters", () => {
    const a = makeAdapter("ds-a", []);
    const b = makeAdapter("ds-b", []);
    const c = makeAdapter("ds-c", []);

    engine.addDataSource(a);
    engine.addDataSource(b);
    engine.addDataSource(c);

    const sources = engine.getDataSources();
    expect(sources).toContain(a);
    expect(sources).toContain(b);
    expect(sources).toContain(c);
    expect(sources).toHaveLength(3);
  });

  it("removeDataSource only removes the targeted adapter, leaving others intact", () => {
    const a = makeAdapter("ds-a", []);
    const b = makeAdapter("ds-b", []);

    engine.addDataSource(a);
    engine.addDataSource(b);

    engine.removeDataSource("ds-a");

    const sources = engine.getDataSources();
    expect(sources).not.toContain(a);
    expect(sources).toContain(b);
  });
});
