import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { StateManager } from "../src/state/state-manager.js";
import type { Goal } from "../src/types/goal.js";
import type { ObservationLogEntry } from "../src/types/state.js";
import type { ObservationLayer, ObservationMethod, ObservationTrigger } from "../src/types/core.js";
import type { KnowledgeGapSignal } from "../src/types/knowledge.js";
import type { IDataSourceAdapter } from "../src/observation/data-source-adapter.js";
import type { DataSourceConfig } from "../src/types/data-source.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";
import { randomUUID } from "node:crypto";

// ─── Helpers ───

const defaultMethod: ObservationMethod = {
  type: "mechanical",
  source: "test-runner",
  schedule: null,
  endpoint: null,
  confidence_tier: "mechanical",
};

const testDimension = {
  name: "test_dim",
  label: "Test Dimension",
  current_value: 50,
  threshold: { type: "min" as const, value: 100 },
  confidence: 0.9,
  observation_method: defaultMethod,
  last_updated: new Date().toISOString(),
  history: [],
  weight: 1.0,
  uncertainty_weight: null,
  state_integrity: "ok" as const,
  dimension_mapping: null,
};

function makeEntry(overrides: Partial<ObservationLogEntry> = {}): ObservationLogEntry {
  return {
    observation_id: randomUUID(),
    timestamp: new Date().toISOString(),
    trigger: "post_task",
    goal_id: "goal-1",
    dimension_name: "test_dim",
    layer: "mechanical",
    method: defaultMethod,
    raw_result: 80,
    extracted_value: 80,
    confidence: 0.9,
    notes: null,
    ...overrides,
  };
}

// ─── Tests ───

describe("ObservationEngine", () => {
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

  // ─── applyProgressCeiling ───

  describe("applyProgressCeiling", () => {
    it("mechanical: returns progress unchanged when below ceiling (1.0)", () => {
      expect(engine.applyProgressCeiling(0.75, "mechanical")).toBe(0.75);
    });

    it("mechanical: allows progress = 1.0", () => {
      expect(engine.applyProgressCeiling(1.0, "mechanical")).toBe(1.0);
    });

    it("mechanical: caps at 1.0 if somehow above", () => {
      expect(engine.applyProgressCeiling(1.5, "mechanical")).toBe(1.0);
    });

    it("independent_review: caps at 0.90", () => {
      expect(engine.applyProgressCeiling(0.95, "independent_review")).toBe(0.90);
    });

    it("independent_review: returns progress unchanged when below ceiling", () => {
      expect(engine.applyProgressCeiling(0.80, "independent_review")).toBe(0.80);
    });

    it("self_report: caps at 0.70", () => {
      expect(engine.applyProgressCeiling(0.85, "self_report")).toBe(0.70);
    });

    it("self_report: returns progress unchanged when below ceiling", () => {
      expect(engine.applyProgressCeiling(0.50, "self_report")).toBe(0.50);
    });

    it("all layers: progress = 0 returns 0", () => {
      const layers: ObservationLayer[] = ["mechanical", "independent_review", "self_report"];
      for (const layer of layers) {
        expect(engine.applyProgressCeiling(0, layer)).toBe(0);
      }
    });

    it("self_report: progress exactly at ceiling (0.70) is unchanged", () => {
      expect(engine.applyProgressCeiling(0.70, "self_report")).toBe(0.70);
    });

    it("independent_review: progress exactly at ceiling (0.90) is unchanged", () => {
      expect(engine.applyProgressCeiling(0.90, "independent_review")).toBe(0.90);
    });
  });

  // ─── getConfidenceTier ───

  describe("getConfidenceTier", () => {
    it("mechanical: returns tier=mechanical with range [0.85, 1.0]", () => {
      const result = engine.getConfidenceTier("mechanical");
      expect(result.tier).toBe("mechanical");
      expect(result.range).toEqual([0.85, 1.0]);
    });

    it("independent_review: returns tier=independent_review with range [0.50, 0.84]", () => {
      const result = engine.getConfidenceTier("independent_review");
      expect(result.tier).toBe("independent_review");
      expect(result.range).toEqual([0.50, 0.84]);
    });

    it("self_report: returns tier=self_report with range [0.10, 0.49]", () => {
      const result = engine.getConfidenceTier("self_report");
      expect(result.tier).toBe("self_report");
      expect(result.range).toEqual([0.10, 0.49]);
    });
  });

  // ─── createObservationEntry ───

  describe("createObservationEntry", () => {
    it("generates a unique observation_id (uuid)", () => {
      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 80,
        extractedValue: 80,
        confidence: 0.95,
      });
      expect(typeof entry.observation_id).toBe("string");
      expect(entry.observation_id.length).toBeGreaterThan(0);
    });

    it("generates different ids for successive calls", () => {
      const params = {
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical" as ObservationLayer,
        method: defaultMethod,
        trigger: "post_task" as ObservationTrigger,
        rawResult: 80,
        extractedValue: 80,
        confidence: 0.95,
      };
      const e1 = engine.createObservationEntry(params);
      const e2 = engine.createObservationEntry(params);
      expect(e1.observation_id).not.toBe(e2.observation_id);
    });

    it("sets timestamp to a valid ISO string", () => {
      const before = Date.now();
      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "periodic",
        rawResult: null,
        extractedValue: null,
        confidence: 0.90,
      });
      const after = Date.now();
      const ts = new Date(entry.timestamp).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it("mechanical: clamps confidence above tier max (1.0) to 1.0", () => {
      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 1,
        extractedValue: 1,
        confidence: 1.5, // above max
      });
      expect(entry.confidence).toBe(1.0);
    });

    it("mechanical: clamps confidence below tier min (0.85) to 0.85", () => {
      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 1,
        extractedValue: 1,
        confidence: 0.5, // below mechanical min
      });
      expect(entry.confidence).toBe(0.85);
    });

    it("self_report: clamps confidence above tier max (0.49) to 0.49", () => {
      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "self_report",
        method: { ...defaultMethod, confidence_tier: "self_report" },
        trigger: "post_task",
        rawResult: "done",
        extractedValue: 1,
        confidence: 0.80, // above self_report max
      });
      expect(entry.confidence).toBe(0.49);
    });

    it("self_report: clamps confidence below tier min (0.10) to 0.10", () => {
      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "self_report",
        method: { ...defaultMethod, confidence_tier: "self_report" },
        trigger: "post_task",
        rawResult: "done",
        extractedValue: 1,
        confidence: 0.01, // below self_report min
      });
      expect(entry.confidence).toBe(0.10);
    });

    it("sets notes to null when not provided", () => {
      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 80,
        extractedValue: 80,
        confidence: 0.90,
      });
      expect(entry.notes).toBeNull();
    });

    it("preserves provided notes", () => {
      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "independent_review",
        method: { ...defaultMethod, confidence_tier: "independent_review" },
        trigger: "event_driven",
        rawResult: { score: 0.75 },
        extractedValue: 0.75,
        confidence: 0.70,
        notes: "Reviewed by LLM session 42",
      });
      expect(entry.notes).toBe("Reviewed by LLM session 42");
    });

    it("preserves all provided fields correctly", () => {
      const entry = engine.createObservationEntry({
        goalId: "goal-abc",
        dimensionName: "coverage",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 95,
        extractedValue: 95,
        confidence: 0.98,
      });
      expect(entry.goal_id).toBe("goal-abc");
      expect(entry.dimension_name).toBe("coverage");
      expect(entry.layer).toBe("mechanical");
      expect(entry.trigger).toBe("post_task");
      expect(entry.extracted_value).toBe(95);
    });
  });

  // ─── needsVerificationTask ───

  describe("needsVerificationTask", () => {
    it("returns true when progress >= threshold AND confidence < 0.85", () => {
      expect(engine.needsVerificationTask(0.80, 0.70, 0.80)).toBe(true);
    });

    it("returns true when progress exactly equals threshold and confidence < 0.85", () => {
      expect(engine.needsVerificationTask(0.90, 0.50, 0.90)).toBe(true);
    });

    it("returns false when progress < threshold regardless of confidence", () => {
      expect(engine.needsVerificationTask(0.50, 0.30, 0.80)).toBe(false);
    });

    it("returns false when confidence >= 0.85 regardless of progress", () => {
      expect(engine.needsVerificationTask(1.0, 0.90, 0.80)).toBe(false);
    });

    it("returns false when both progress < threshold and confidence >= 0.85", () => {
      expect(engine.needsVerificationTask(0.40, 0.90, 0.90)).toBe(false);
    });

    it("boundary: confidence exactly 0.85 returns false (not < 0.85)", () => {
      expect(engine.needsVerificationTask(1.0, 0.85, 0.80)).toBe(false);
    });

    it("boundary: progress = 0 with threshold > 0, returns false", () => {
      expect(engine.needsVerificationTask(0, 0.30, 0.5)).toBe(false);
    });
  });

  // ─── resolveContradiction ───

  describe("resolveContradiction", () => {
    it("throws when entries is empty", () => {
      expect(() => engine.resolveContradiction([])).toThrow();
    });

    it("returns the single entry when only one provided", () => {
      const entry = makeEntry({ layer: "self_report", confidence: 0.30 });
      expect(engine.resolveContradiction([entry])).toEqual(entry);
    });

    it("mechanical beats self_report", () => {
      const mechanicalEntry = makeEntry({ layer: "mechanical", confidence: 0.90, extracted_value: 80 });
      const selfReportEntry = makeEntry({ layer: "self_report", confidence: 0.30, extracted_value: 95 });
      const winner = engine.resolveContradiction([selfReportEntry, mechanicalEntry]);
      expect(winner.layer).toBe("mechanical");
    });

    it("mechanical beats independent_review", () => {
      const mechanicalEntry = makeEntry({ layer: "mechanical", confidence: 0.90, extracted_value: 70 });
      const reviewEntry = makeEntry({ layer: "independent_review", confidence: 0.65, extracted_value: 90 });
      const winner = engine.resolveContradiction([reviewEntry, mechanicalEntry]);
      expect(winner.layer).toBe("mechanical");
    });

    it("independent_review beats self_report", () => {
      const reviewEntry = makeEntry({ layer: "independent_review", confidence: 0.65, extracted_value: 75 });
      const selfEntry = makeEntry({ layer: "self_report", confidence: 0.30, extracted_value: 90 });
      const winner = engine.resolveContradiction([selfEntry, reviewEntry]);
      expect(winner.layer).toBe("independent_review");
    });

    it("within same layer (mechanical): pessimistic (lower numeric) wins", () => {
      const high = makeEntry({ layer: "mechanical", confidence: 0.92, extracted_value: 90 });
      const low = makeEntry({ layer: "mechanical", confidence: 0.88, extracted_value: 60 });
      const winner = engine.resolveContradiction([high, low]);
      expect(winner.extracted_value).toBe(60);
    });

    it("within same layer (self_report): pessimistic wins", () => {
      const e1 = makeEntry({ layer: "self_report", confidence: 0.40, extracted_value: 55 });
      const e2 = makeEntry({ layer: "self_report", confidence: 0.35, extracted_value: 30 });
      const winner = engine.resolveContradiction([e1, e2]);
      expect(winner.extracted_value).toBe(30);
    });

    it("within same layer with non-numeric values: returns first entry", () => {
      const e1 = makeEntry({ layer: "self_report", confidence: 0.40, extracted_value: "done" });
      const e2 = makeEntry({ layer: "self_report", confidence: 0.35, extracted_value: "partial" });
      const winner = engine.resolveContradiction([e1, e2]);
      // Non-numeric: first entry in the group is returned
      expect(winner.extracted_value).toBe("done");
    });
  });

  // ─── applyObservation ───

  describe("applyObservation", () => {
    it("throws when goal is not found", async () => {
      const entry = makeEntry({ goal_id: "nonexistent" });
      await expect(engine.applyObservation("nonexistent", entry)).rejects.toThrow(
        /goal "nonexistent" not found/
      );
    });

    it("throws when dimension is not found in goal", async () => {
      const goal = makeGoal({ id: "goal-1" });
      await stateManager.saveGoal(goal);
      const entry = makeEntry({ goal_id: "goal-1", dimension_name: "nonexistent_dim" });
      await expect(engine.applyObservation("goal-1", entry)).rejects.toThrow(
        /dimension "nonexistent_dim" not found/
      );
    });

    it("updates dimension current_value after applying observation", async () => {
      const goal = makeGoal({ id: "goal-1", dimensions: [testDimension] });
      await stateManager.saveGoal(goal);

      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 80,
        extractedValue: 80,
        confidence: 0.95,
      });

      await engine.applyObservation("goal-1", entry);

      const updatedGoal = await stateManager.loadGoal("goal-1");
      expect(updatedGoal).not.toBeNull();
      const dim = updatedGoal!.dimensions.find((d) => d.name === "test_dim");
      expect(dim).not.toBeNull();
      expect(dim!.current_value).toBe(80);
    });

    it("updates dimension confidence after applying observation", async () => {
      const goal = makeGoal({ id: "goal-1", dimensions: [testDimension] });
      await stateManager.saveGoal(goal);

      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 80,
        extractedValue: 80,
        confidence: 0.95,
      });

      await engine.applyObservation("goal-1", entry);

      const updatedGoal = await stateManager.loadGoal("goal-1");
      const dim = updatedGoal!.dimensions.find((d) => d.name === "test_dim");
      expect(dim!.confidence).toBe(entry.confidence);
    });

    it("appends entry to dimension history with correct source_observation_id", async () => {
      const goal = makeGoal({ id: "goal-1", dimensions: [testDimension] });
      await stateManager.saveGoal(goal);

      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 80,
        extractedValue: 80,
        confidence: 0.95,
      });

      await engine.applyObservation("goal-1", entry);

      const updatedGoal = await stateManager.loadGoal("goal-1");
      const dim = updatedGoal!.dimensions.find((d) => d.name === "test_dim");
      expect(dim!.history).toHaveLength(1);
      expect(dim!.history[0]!.source_observation_id).toBe(entry.observation_id);
      expect(dim!.history[0]!.value).toBe(80);
    });

    it("persists the observation entry in the observation log", async () => {
      const goal = makeGoal({ id: "goal-1", dimensions: [testDimension] });
      await stateManager.saveGoal(goal);

      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 80,
        extractedValue: 80,
        confidence: 0.95,
      });

      await engine.applyObservation("goal-1", entry);

      const log = await stateManager.loadObservationLog("goal-1");
      expect(log).not.toBeNull();
      expect(log!.entries).toHaveLength(1);
      expect(log!.entries[0]!.observation_id).toBe(entry.observation_id);
    });

    it("accumulates multiple observations in history", async () => {
      const goal = makeGoal({ id: "goal-1", dimensions: [testDimension] });
      await stateManager.saveGoal(goal);

      for (let i = 0; i < 3; i++) {
        const entry = engine.createObservationEntry({
          goalId: "goal-1",
          dimensionName: "test_dim",
          layer: "mechanical",
          method: defaultMethod,
          trigger: "post_task",
          rawResult: 60 + i * 10,
          extractedValue: 60 + i * 10,
          confidence: 0.90,
        });
        await engine.applyObservation("goal-1", entry);
      }

      const updatedGoal = await stateManager.loadGoal("goal-1");
      const dim = updatedGoal!.dimensions.find((d) => d.name === "test_dim");
      expect(dim!.history).toHaveLength(3);
      expect(dim!.current_value).toBe(80); // last applied value
    });
  });

  // ─── getObservationLog / saveObservationLog ───

  describe("getObservationLog", () => {
    it("returns empty log when none exists", async () => {
      const log = await engine.getObservationLog("goal-nonexistent");
      expect(log.goal_id).toBe("goal-nonexistent");
      expect(log.entries).toHaveLength(0);
    });

    it("returns existing log after entries are appended", async () => {
      const goal = makeGoal({ id: "goal-2", dimensions: [testDimension] });
      await stateManager.saveGoal(goal);

      const entry = engine.createObservationEntry({
        goalId: "goal-2",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 70,
        extractedValue: 70,
        confidence: 0.92,
      });
      await engine.applyObservation("goal-2", entry);

      const log = await engine.getObservationLog("goal-2");
      expect(log.goal_id).toBe("goal-2");
      expect(log.entries).toHaveLength(1);
      expect(log.entries[0]!.observation_id).toBe(entry.observation_id);
    });
  });

  describe("saveObservationLog", () => {
    it("persists a log and allows round-trip retrieval", async () => {
      const entry1 = makeEntry({ goal_id: "goal-3", observation_id: "obs-1", extracted_value: 55 });
      const entry2 = makeEntry({ goal_id: "goal-3", observation_id: "obs-2", extracted_value: 70 });
      const log = { goal_id: "goal-3", entries: [entry1, entry2] };

      await engine.saveObservationLog("goal-3", log);

      const loaded = await engine.getObservationLog("goal-3");
      expect(loaded.goal_id).toBe("goal-3");
      expect(loaded.entries).toHaveLength(2);
      expect(loaded.entries[0]!.observation_id).toBe("obs-1");
      expect(loaded.entries[1]!.observation_id).toBe("obs-2");
    });

    it("overwrites previous log on second save", async () => {
      const entry1 = makeEntry({ goal_id: "goal-4", observation_id: "obs-a", extracted_value: 40 });
      await engine.saveObservationLog("goal-4", { goal_id: "goal-4", entries: [entry1] });

      const entry2 = makeEntry({ goal_id: "goal-4", observation_id: "obs-b", extracted_value: 80 });
      await engine.saveObservationLog("goal-4", { goal_id: "goal-4", entries: [entry2] });

      const loaded = await engine.getObservationLog("goal-4");
      expect(loaded.entries).toHaveLength(1);
      expect(loaded.entries[0]!.observation_id).toBe("obs-b");
    });
  });

  // ─── detectKnowledgeGap ───

  describe("detectKnowledgeGap", () => {
    it("returns null when entries array is empty", () => {
      const result = engine.detectKnowledgeGap([]);
      expect(result).toBeNull();
    });

    it("returns null when all entries have confidence >= 0.3", () => {
      const entry = makeEntry({ layer: "self_report", confidence: 0.30 });
      const result = engine.detectKnowledgeGap([entry]);
      expect(result).toBeNull();
    });

    it("returns null when at least one entry has confidence >= 0.3", () => {
      const low = makeEntry({ layer: "self_report", confidence: 0.10 });
      const ok = makeEntry({ layer: "self_report", confidence: 0.40 });
      const result = engine.detectKnowledgeGap([low, ok]);
      expect(result).toBeNull();
    });

    it("returns interpretation_difficulty signal when all entries have confidence < 0.3", () => {
      const e1 = makeEntry({ layer: "self_report", confidence: 0.10 });
      const e2 = makeEntry({ layer: "self_report", confidence: 0.20 });
      const result = engine.detectKnowledgeGap([e1, e2]);
      expect(result).not.toBeNull();
      expect(result!.signal_type).toBe("interpretation_difficulty");
    });

    it("signal has source_step = gap_recognition", () => {
      const entry = makeEntry({ layer: "self_report", confidence: 0.10 });
      const result = engine.detectKnowledgeGap([entry]);
      expect(result!.source_step).toBe("gap_recognition");
    });

    it("signal has non-empty missing_knowledge description", () => {
      const entry = makeEntry({ layer: "self_report", confidence: 0.10 });
      const result = engine.detectKnowledgeGap([entry]);
      expect(result!.missing_knowledge.length).toBeGreaterThan(0);
    });

    it("signal carries the provided dimensionName in related_dimension", () => {
      const entry = makeEntry({ layer: "self_report", confidence: 0.10 });
      const result = engine.detectKnowledgeGap([entry], "coverage");
      expect(result!.related_dimension).toBe("coverage");
    });

    it("related_dimension is null when dimensionName is omitted", () => {
      const entry = makeEntry({ layer: "self_report", confidence: 0.10 });
      const result = engine.detectKnowledgeGap([entry]);
      expect(result!.related_dimension).toBeNull();
    });
  });
});

// ─── observeFromDataSource ───

function makeDsConfig(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: "mock-ds",
    name: "Mock Data Source",
    type: "file",
    connection: { path: "/tmp/mock.json" },
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockDataSource(overrides: Partial<IDataSourceAdapter> = {}): IDataSourceAdapter {
  return {
    sourceId: "mock-ds",
    sourceType: "file",
    config: makeDsConfig(),
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({
      value: 42,
      raw: { metrics: { cpu: 42 } },
      timestamp: new Date().toISOString(),
      source_id: "mock-ds",
    }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("observeFromDataSource", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let mockDs: IDataSourceAdapter;
  let engineWithDs: ObservationEngine;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    mockDs = makeMockDataSource();
    engineWithDs = new ObservationEngine(stateManager, [mockDs]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates observation entry from data source query result", async () => {
    const goal = makeGoal({
      id: "goal-ds-1",
      dimensions: [
        {
          name: "cpu",
          label: "CPU Usage",
          current_value: 0,
          threshold: { type: "max", value: 80 },
          confidence: 0.5,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
        },
      ],
    });
    await stateManager.saveGoal(goal);

    const entry = await engineWithDs.observeFromDataSource("goal-ds-1", "cpu", "mock-ds");

    expect(entry).not.toBeNull();
    expect(entry.goal_id).toBe("goal-ds-1");
    expect(entry.dimension_name).toBe("cpu");
    expect(entry.extracted_value).toBe(42);
    expect(entry.layer).toBe("mechanical");
    expect(typeof entry.observation_id).toBe("string");
    expect(entry.observation_id.length).toBeGreaterThan(0);
  });

  it("throws when source is not found in dataSources", async () => {
    await expect(
      engineWithDs.observeFromDataSource("goal-ds-1", "cpu", "nonexistent-ds")
    ).rejects.toThrow(/nonexistent-ds/);
  });

  // ─── findDataSourceForDimension scoped-priority ───

  describe("findDataSourceForDimension scoped-priority", () => {
    it("prefers scoped datasource over unscoped when both support the same dimension", async () => {
      const goalId = "goal-scoped-test";

      const unscopedDs = makeMockDataSource({
        sourceId: "unscoped-ds",
        config: makeDsConfig({ id: "unscoped-ds" }),
        getSupportedDimensions: () => ["metric_x"],
        query: vi.fn().mockResolvedValue({
          value: 1,
          raw: { value: 1 },
          timestamp: new Date().toISOString(),
          source_id: "unscoped-ds",
        }),
      });

      const scopedDs = makeMockDataSource({
        sourceId: "scoped-ds",
        config: makeDsConfig({ id: "scoped-ds", scope_goal_id: goalId } as never),
        getSupportedDimensions: () => ["metric_x"],
        query: vi.fn().mockResolvedValue({
          value: 99,
          raw: { value: 99 },
          timestamp: new Date().toISOString(),
          source_id: "scoped-ds",
        }),
      });

      // unscoped appears first in the array — scoped must still win
      const eng = new ObservationEngine(stateManager, [unscopedDs, scopedDs]);

      const goal = makeGoal({
        id: goalId,
        dimensions: [
          {
            name: "metric_x",
            label: "Metric X",
            current_value: 0,
            threshold: { type: "min", value: 100 },
            confidence: 0.5,
            observation_method: defaultMethod,
            last_updated: new Date().toISOString(),
            history: [],
            weight: 1.0,
            uncertainty_weight: null,
            state_integrity: "ok",
          },
        ],
      });
      await stateManager.saveGoal(goal);

      const entry = await eng.observeFromDataSource(goalId, "metric_x", "scoped-ds");
      expect(entry.extracted_value).toBe(99);
      expect(scopedDs.query).toHaveBeenCalled();
      expect(unscopedDs.query).not.toHaveBeenCalled();
    });

    it("falls back to unscoped datasource when no scoped datasource exists", async () => {
      const goalId = "goal-fallback-test";

      const unscopedDs = makeMockDataSource({
        sourceId: "only-ds",
        config: makeDsConfig({ id: "only-ds" }),
        getSupportedDimensions: () => ["metric_y"],
        query: vi.fn().mockResolvedValue({
          value: 55,
          raw: { value: 55 },
          timestamp: new Date().toISOString(),
          source_id: "only-ds",
        }),
      });

      const eng = new ObservationEngine(stateManager, [unscopedDs]);

      const goal = makeGoal({
        id: goalId,
        dimensions: [
          {
            name: "metric_y",
            label: "Metric Y",
            current_value: 0,
            threshold: { type: "min", value: 100 },
            confidence: 0.5,
            observation_method: defaultMethod,
            last_updated: new Date().toISOString(),
            history: [],
            weight: 1.0,
            uncertainty_weight: null,
            state_integrity: "ok",
          },
        ],
      });
      await stateManager.saveGoal(goal);

      const entry = await eng.observeFromDataSource(goalId, "metric_y", "only-ds");
      expect(entry.extracted_value).toBe(55);
      expect(unscopedDs.query).toHaveBeenCalled();
    });

    it("falls back to a datasource scoped to a different goal when no exact or unscoped match exists", async () => {
      const goalIdA = "goal-a";
      const goalIdB = "goal-b";

      // Datasource scoped to goal-a covers "todo_count"
      const scopedToA = makeMockDataSource({
        sourceId: "ds-scoped-to-a",
        config: makeDsConfig({ id: "ds-scoped-to-a", scope_goal_id: goalIdA } as never),
        getSupportedDimensions: () => ["todo_count"],
        query: vi.fn().mockResolvedValue({
          value: 42,
          raw: { value: 42 },
          timestamp: new Date().toISOString(),
          source_id: "ds-scoped-to-a",
        }),
      });

      // goal-b uses the same dimension name but dedup prevented creating its own datasource
      const eng = new ObservationEngine(stateManager, [scopedToA]);

      const goalB = makeGoal({
        id: goalIdB,
        dimensions: [
          {
            name: "todo_count",
            label: "Todo Count",
            current_value: 0,
            threshold: { type: "min", value: 10 },
            confidence: 0.5,
            observation_method: defaultMethod,
            last_updated: new Date().toISOString(),
            history: [],
            weight: 1.0,
            uncertainty_weight: null,
            state_integrity: "ok",
          },
        ],
      });
      await stateManager.saveGoal(goalB);

      const entry = await eng.observeFromDataSource(goalIdB, "todo_count", "ds-scoped-to-a");
      expect(entry.extracted_value).toBe(42);
      expect(scopedToA.query).toHaveBeenCalled();
    });
  });

  it("uses dimension_mapping from config to build expression when present", async () => {
    const dsWithMapping = makeMockDataSource({
      sourceId: "mapped-ds",
      config: makeDsConfig({
        id: "mapped-ds",
        dimension_mapping: { cpu: "metrics.cpu" },
      }),
    });
    const engineMapped = new ObservationEngine(stateManager, [dsWithMapping]);

    const goal = makeGoal({
      id: "goal-mapped",
      dimensions: [
        {
          name: "cpu",
          label: "CPU",
          current_value: 0,
          threshold: { type: "max", value: 90 },
          confidence: 0.6,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
        },
      ],
    });
    await stateManager.saveGoal(goal);

    await engineMapped.observeFromDataSource("goal-mapped", "cpu", "mapped-ds");

    // query should have been called with expression from dimension_mapping
    const queryMock = dsWithMapping.query as ReturnType<typeof vi.fn>;
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({ expression: "metrics.cpu" })
    );
  });

  it("handles non-numeric values from data source", async () => {
    const stringDs = makeMockDataSource({
      query: vi.fn().mockResolvedValue({
        value: "healthy",
        raw: { status: "healthy" },
        timestamp: new Date().toISOString(),
        source_id: "mock-ds",
      }),
    });
    const engineStr = new ObservationEngine(stateManager, [stringDs]);

    const goal = makeGoal({
      id: "goal-str",
      dimensions: [
        {
          name: "test_dim",
          label: "Status",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.5,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
        },
      ],
    });
    await stateManager.saveGoal(goal);

    const entry = await engineStr.observeFromDataSource("goal-str", "test_dim", "mock-ds");

    expect(entry.extracted_value).toBe("healthy");
  });
});
