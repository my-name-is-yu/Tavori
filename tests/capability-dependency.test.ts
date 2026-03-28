import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";
import { ReportingEngine } from "../src/reporting-engine.js";
import { CapabilityDetector } from "../src/observation/capability-detector.js";
import type {
  CapabilityDependency,
  CapabilityGap,
} from "../src/types/capability.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";

// ─── Fixtures ───

function makeDep(capabilityId: string, dependsOn: string[]): CapabilityDependency {
  return { capability_id: capabilityId, depends_on: dependsOn };
}

function makeGap(name: string): CapabilityGap {
  return {
    missing_capability: { name, type: "tool" },
    reason: `Need ${name}`,
    alternatives: [],
    impact_description: `Cannot run without ${name}`,
  };
}

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;
let reportingEngine: ReportingEngine;
let detector: CapabilityDetector;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-dep-test-"));
  stateManager = new StateManager(tempDir);
  reportingEngine = new ReportingEngine(stateManager);
  detector = new CapabilityDetector(stateManager, createMockLLMClient("{}"), reportingEngine);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── resolveDependencies ───

describe("resolveDependencies", () => {
  it("returns empty array for empty input", () => {
    expect(detector.resolveDependencies([])).toEqual([]);
  });

  it("linear chain A depends on B depends on C — returns C before B before A", () => {
    // A → B → C means: A depends on B, B depends on C
    // Expected topological order: C first, then B, then A
    const deps: CapabilityDependency[] = [
      makeDep("A", ["B"]),
      makeDep("B", ["C"]),
      makeDep("C", []),
    ];
    const result = detector.resolveDependencies(deps);
    expect(result.indexOf("C")).toBeLessThan(result.indexOf("B"));
    expect(result.indexOf("B")).toBeLessThan(result.indexOf("A"));
  });

  it("independent capabilities (no edges) are all returned", () => {
    const deps: CapabilityDependency[] = [
      makeDep("X", []),
      makeDep("Y", []),
      makeDep("Z", []),
    ];
    const result = detector.resolveDependencies(deps);
    expect(result).toHaveLength(3);
    expect(result).toContain("X");
    expect(result).toContain("Y");
    expect(result).toContain("Z");
  });

  it("node referenced only as a dependency (not in capability_id) appears before its dependent", () => {
    // B is only a dependency target, not defined as a capability_id entry
    const deps: CapabilityDependency[] = [
      makeDep("A", ["B"]),
    ];
    const result = detector.resolveDependencies(deps);
    expect(result.indexOf("B")).toBeLessThan(result.indexOf("A"));
  });

  it("diamond dependency: A depends on B and C, B and C both depend on D — D comes first", () => {
    const deps: CapabilityDependency[] = [
      makeDep("A", ["B", "C"]),
      makeDep("B", ["D"]),
      makeDep("C", ["D"]),
      makeDep("D", []),
    ];
    const result = detector.resolveDependencies(deps);
    expect(result.indexOf("D")).toBeLessThan(result.indexOf("B"));
    expect(result.indexOf("D")).toBeLessThan(result.indexOf("C"));
    expect(result.indexOf("B")).toBeLessThan(result.indexOf("A"));
    expect(result.indexOf("C")).toBeLessThan(result.indexOf("A"));
  });
});

// ─── detectCircularDependency ───

describe("detectCircularDependency", () => {
  it("returns null for empty input", () => {
    expect(detector.detectCircularDependency([])).toBeNull();
  });

  it("returns null when no cycle exists", () => {
    const deps: CapabilityDependency[] = [
      makeDep("A", ["B"]),
      makeDep("B", ["C"]),
    ];
    expect(detector.detectCircularDependency(deps)).toBeNull();
  });

  it("detects a direct self-cycle A → A", () => {
    const deps: CapabilityDependency[] = [
      makeDep("A", ["A"]),
    ];
    const cycle = detector.detectCircularDependency(deps);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("A");
  });

  it("detects a two-node cycle A → B → A", () => {
    const deps: CapabilityDependency[] = [
      makeDep("A", ["B"]),
      makeDep("B", ["A"]),
    ];
    const cycle = detector.detectCircularDependency(deps);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(2);
    expect(cycle).toContain("A");
    expect(cycle).toContain("B");
  });

  it("detects a three-node cycle A → B → C → A and returns the cycle path", () => {
    const deps: CapabilityDependency[] = [
      makeDep("A", ["B"]),
      makeDep("B", ["C"]),
      makeDep("C", ["A"]),
    ];
    const cycle = detector.detectCircularDependency(deps);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(3);
    // All three participants must be in the cycle
    expect(cycle).toContain("A");
    expect(cycle).toContain("B");
    expect(cycle).toContain("C");
  });
});

// ─── addDependency / getDependencies roundtrip ───

describe("addDependency / getDependencies", () => {
  it("returns empty array for an unknown capability", async () => {
    expect(await detector.getDependencies("unknown")).toEqual([]);
  });

  it("stores and retrieves a dependency entry", async () => {
    await detector.addDependency("cap-A", ["cap-B", "cap-C"]);
    expect(await detector.getDependencies("cap-A")).toEqual(["cap-B", "cap-C"]);
  });

  it("replaces an existing entry when called again with the same capabilityId", async () => {
    await detector.addDependency("cap-A", ["cap-B"]);
    await detector.addDependency("cap-A", ["cap-C", "cap-D"]);
    expect(await detector.getDependencies("cap-A")).toEqual(["cap-C", "cap-D"]);
  });

  it("persists dependencies across detector instances (same stateManager)", async () => {
    await detector.addDependency("cap-X", ["cap-Y"]);
    // Create a new detector pointing at the same tempDir
    const detector2 = new CapabilityDetector(
      stateManager,
      createMockLLMClient("{}"),
      reportingEngine
    );
    expect(await detector2.getDependencies("cap-X")).toEqual(["cap-Y"]);
  });

  it("stores multiple independent entries", async () => {
    await detector.addDependency("cap-A", ["cap-B"]);
    await detector.addDependency("cap-C", ["cap-D", "cap-E"]);
    expect(await detector.getDependencies("cap-A")).toEqual(["cap-B"]);
    expect(await detector.getDependencies("cap-C")).toEqual(["cap-D", "cap-E"]);
  });
});

// ─── getAcquisitionOrder ───

describe("getAcquisitionOrder", () => {
  it("returns empty array for empty input", async () => {
    expect(await detector.getAcquisitionOrder([])).toEqual([]);
  });

  it("returns original order when no dependencies are registered", async () => {
    const gaps = [makeGap("tool-A"), makeGap("tool-B"), makeGap("tool-C")];
    const result = await detector.getAcquisitionOrder(gaps);
    expect(result.map((g) => g.missing_capability.name)).toEqual(["tool-A", "tool-B", "tool-C"]);
  });

  it("reorders gaps so dependency comes before dependent", async () => {
    // tool-C depends on tool-A
    await detector.addDependency("tool-C", ["tool-A"]);
    const gaps = [makeGap("tool-C"), makeGap("tool-A")];
    const result = await detector.getAcquisitionOrder(gaps);
    const names = result.map((g) => g.missing_capability.name);
    expect(names.indexOf("tool-A")).toBeLessThan(names.indexOf("tool-C"));
  });

  it("handles a linear chain of three gaps: C depends on B depends on A", async () => {
    await detector.addDependency("gap-C", ["gap-B"]);
    await detector.addDependency("gap-B", ["gap-A"]);
    const gaps = [makeGap("gap-C"), makeGap("gap-B"), makeGap("gap-A")];
    const result = await detector.getAcquisitionOrder(gaps);
    const names = result.map((g) => g.missing_capability.name);
    expect(names.indexOf("gap-A")).toBeLessThan(names.indexOf("gap-B"));
    expect(names.indexOf("gap-B")).toBeLessThan(names.indexOf("gap-C"));
  });

  it("ignores registered dependencies that reference capabilities not in the gaps list", async () => {
    // tool-A depends on some-other-tool which is not in gaps
    await detector.addDependency("tool-A", ["some-other-tool"]);
    const gaps = [makeGap("tool-A"), makeGap("tool-B")];
    // Should not throw and should return both gaps
    const result = await detector.getAcquisitionOrder(gaps);
    expect(result).toHaveLength(2);
  });
});
