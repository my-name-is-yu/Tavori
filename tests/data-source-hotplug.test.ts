import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DataSourceRegistry } from "../src/data-source-adapter.js";
import type { IDataSourceAdapter } from "../src/data-source-adapter.js";
import { ObservationEngine } from "../src/observation-engine.js";
import { StateManager } from "../src/state-manager.js";
import type { DataSourceConfig } from "../src/types/data-source.js";
import type { Goal } from "../src/types/goal.js";
import type { ObservationMethod } from "../src/types/core.js";

// ─── Helpers ───

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-hotplug-test-"));
}

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

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    parent_id: null,
    node_type: "goal",
    title: "Test Goal",
    description: "Hotplug test goal",
    status: "active",
    dimensions: overrides.dimensions ?? [
      {
        name: "test_dim",
        label: "Test Dimension",
        current_value: 0.3,
        threshold: { type: "min", value: 1.0 },
        confidence: 0.5,
        observation_method: defaultMethod,
        last_updated: now,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
        state_integrity: "ok",
      },
    ],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: null,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

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
    const goal = makeGoal();
    stateManager.saveGoal(goal);

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
    const goal = makeGoal();
    stateManager.saveGoal(goal);

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
