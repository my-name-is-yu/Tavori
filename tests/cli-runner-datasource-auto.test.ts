/**
 * CLIRunner — auto DataSource registration tests
 *
 * Verifies that when `pulseed goal add` negotiates a goal with file_existence
 * dimensions, a FileExistenceDataSourceAdapter config is automatically saved
 * to the datasources directory so subsequent loop runs can observe mechanically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Module mocks (must precede imports of mocked modules) ───────────────────

vi.mock("../src/llm/provider-factory.js", () => ({
  buildLLMClient: vi.fn().mockResolvedValue({
    sendMessage: vi.fn(),
    parseJSON: vi.fn(),
  }),
  buildAdapterRegistry: vi.fn().mockResolvedValue({
    register: vi.fn(),
    getAdapterCapabilities: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock("../src/core-loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core-loop.js")>();
  return { ...actual, CoreLoop: vi.fn() };
});

vi.mock("../src/goal/goal-negotiator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/goal/goal-negotiator.js")>();
  return { ...actual, GoalNegotiator: vi.fn() };
});

// GoalRefiner mock — refine() returns the goal that was pre-saved by the test.
// Also export collectLeafGoalIds since goal.ts imports it from this module.
vi.mock("../src/goal/goal-refiner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/goal/goal-refiner.js")>();
  return {
    ...actual,
    GoalRefiner: vi.fn(),
  };
});

vi.mock("../src/llm/llm-client.js", () => ({
  LLMClient: vi.fn().mockImplementation(() => ({})),
  MockLLMClient: vi.fn(),
}));

vi.mock("../src/trust-manager.js", () => ({
  TrustManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/drive-system.js", () => ({
  DriveSystem: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/observation/observation-engine.js", () => ({
  ObservationEngine: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/stall-detector.js", () => ({
  StallDetector: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/satisficing-judge.js", () => ({
  SatisficingJudge: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/ethics-gate.js", () => ({
  EthicsGate: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/execution/session-manager.js", () => ({
  SessionManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/strategy/strategy-manager.js", () => ({
  StrategyManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/execution/adapter-layer.js", () => ({
  AdapterRegistry: vi.fn().mockImplementation(() => ({
    register: vi.fn(),
    getAdapterCapabilities: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock("../src/adapters/claude-code-cli.js", () => ({
  ClaudeCodeCLIAdapter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/adapters/claude-api.js", () => ({
  ClaudeAPIAdapter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/execution/task-lifecycle.js", () => ({
  TaskLifecycle: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/reporting-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/reporting-engine.js")>();
  return {
    ...actual,
    ReportingEngine: vi.fn().mockImplementation((...args) => new actual.ReportingEngine(...args)),
  };
});

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { CLIRunner } from "../src/cli-runner.js";
import { StateManager } from "../src/state-manager.js";
import { GoalNegotiator } from "../src/goal/goal-negotiator.js";
import { GoalRefiner } from "../src/goal/goal-refiner.js";
import type { Goal } from "../src/types/goal.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";

function makeNegotiationResult(goal: Goal) {
  return {
    goal,
    response: {
      type: "accept" as const,
      message: "Goal registered successfully.",
      counter_target: null,
    },
    log: {
      goal_id: goal.id,
      timestamp: new Date().toISOString(),
      is_renegotiation: false,
      renegotiation_trigger: null,
    },
  };
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

let tmpDir: string;
let origApiKey: string | undefined;

beforeEach(() => {
  tmpDir = makeTempDir();
  origApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-api-key";
  process.env.PULSEED_LLM_PROVIDER = "anthropic";
});

afterEach(() => {
  if (origApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = origApiKey;
  }
  delete process.env.PULSEED_LLM_PROVIDER;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function readDatasourceConfigs(baseDir: string): Record<string, unknown>[] {
  const dsDir = path.join(baseDir, "datasources");
  if (!fs.existsSync(dsDir)) return [];
  return fs
    .readdirSync(dsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dsDir, f), "utf-8")) as Record<string, unknown>);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CLIRunner — auto FileExistenceDataSource registration", () => {
  it("registers a FileExistenceDataSource when goal has a _exists dimension and description contains a filename", async () => {
    const goal = makeGoal({
      description: "Ensure CONTRIBUTING.md exists in the repo",
      dimensions: [
        {
          name: "contributing_md_exists",
          label: "CONTRIBUTING.md Exists",
          threshold: { type: "present" },
          observation_method: {
            type: "mechanical",
            source: "file_existence",
            schedule: null,
            endpoint: null,
            confidence_tier: "mechanical",
          },
          current_value: null,
          confidence: 0.5,
          last_updated: null,
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });

    const sm = new StateManager(tmpDir);
    await sm.saveGoal(goal);

    vi.mocked(GoalNegotiator).mockImplementation(() => ({
      negotiate: vi.fn().mockResolvedValue(makeNegotiationResult(goal)),
    } as unknown as GoalNegotiator));

    vi.mocked(GoalRefiner).mockImplementation(() => ({
      refine: vi.fn().mockResolvedValue({
        goal,
        leaf: true,
        children: null,
        feasibility: null,
        tokensUsed: 100,
        reason: "measurable",
      }),
    } as unknown as GoalRefiner));

    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["goal", "add", "Ensure CONTRIBUTING.md exists in the repo"]);

    expect(exitCode).toBe(0);

    const configs = readDatasourceConfigs(tmpDir);
    expect(configs.length).toBeGreaterThanOrEqual(1);

    const fileExistenceConfig = configs.find((c) => c["type"] === "file_existence");
    expect(fileExistenceConfig).toBeDefined();
    expect(fileExistenceConfig!["dimension_mapping"]).toBeDefined();

    const dimMapping = fileExistenceConfig!["dimension_mapping"] as Record<string, string>;
    expect(dimMapping["contributing_md_exists"]).toBeDefined();
    expect(dimMapping["contributing_md_exists"]).toMatch(/CONTRIBUTING\.md/i);
  });

  it("registers a FileExistenceDataSource when dimension name ends in _file", async () => {
    const goal = makeGoal({
      description: "Make sure LICENSE.md file is present",
      dimensions: [
        {
          name: "license_file",
          label: "LICENSE file",
          threshold: { type: "present" },
          observation_method: {
            type: "mechanical",
            source: "file_existence",
            schedule: null,
            endpoint: null,
            confidence_tier: "mechanical",
          },
          current_value: null,
          confidence: 0.5,
          last_updated: null,
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });

    const sm = new StateManager(tmpDir);
    await sm.saveGoal(goal);

    vi.mocked(GoalNegotiator).mockImplementation(() => ({
      negotiate: vi.fn().mockResolvedValue(makeNegotiationResult(goal)),
    } as unknown as GoalNegotiator));

    vi.mocked(GoalRefiner).mockImplementation(() => ({
      refine: vi.fn().mockResolvedValue({
        goal,
        leaf: true,
        children: null,
        feasibility: null,
        tokensUsed: 100,
        reason: "measurable",
      }),
    } as unknown as GoalRefiner));

    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["goal", "add", "Make sure LICENSE.md file is present"]);

    expect(exitCode).toBe(0);

    const configs = readDatasourceConfigs(tmpDir);
    const feConfig = configs.find((c) => c["type"] === "file_existence");
    expect(feConfig).toBeDefined();
    const dimMapping = feConfig!["dimension_mapping"] as Record<string, string>;
    expect(dimMapping["license_file"]).toBeDefined();
  });

  it("does NOT register a FileExistenceDataSource when no file_existence dimensions are present", async () => {
    const goal = makeGoal({
      description: "Increase test coverage to 80%",
      dimensions: [
        {
          name: "test_coverage",
          label: "Test Coverage",
          threshold: { type: "min", value: 80 },
          observation_method: {
            type: "mechanical",
            source: "llm_review",
            schedule: null,
            endpoint: null,
            confidence_tier: "independent_review",
          },
          current_value: null,
          confidence: 0.5,
          last_updated: null,
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });

    const sm = new StateManager(tmpDir);
    await sm.saveGoal(goal);

    vi.mocked(GoalNegotiator).mockImplementation(() => ({
      negotiate: vi.fn().mockResolvedValue(makeNegotiationResult(goal)),
    } as unknown as GoalNegotiator));

    vi.mocked(GoalRefiner).mockImplementation(() => ({
      refine: vi.fn().mockResolvedValue({
        goal,
        leaf: true,
        children: null,
        feasibility: null,
        tokensUsed: 100,
        reason: "measurable",
      }),
    } as unknown as GoalRefiner));

    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["goal", "add", "Increase test coverage to 80%"]);

    expect(exitCode).toBe(0);

    const configs = readDatasourceConfigs(tmpDir);
    const feConfig = configs.find((c) => c["type"] === "file_existence");
    expect(feConfig).toBeUndefined();
  });

  it("does NOT register when dimensions has file_existence pattern but no filename in description", async () => {
    const goal = makeGoal({
      description: "Make sure the required file exists",
      dimensions: [
        {
          name: "required_file_exists",
          label: "Required file exists",
          threshold: { type: "present" },
          observation_method: {
            type: "mechanical",
            source: "file_existence",
            schedule: null,
            endpoint: null,
            confidence_tier: "mechanical",
          },
          current_value: null,
          confidence: 0.5,
          last_updated: null,
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });

    const sm = new StateManager(tmpDir);
    await sm.saveGoal(goal);

    vi.mocked(GoalNegotiator).mockImplementation(() => ({
      negotiate: vi.fn().mockResolvedValue(makeNegotiationResult(goal)),
    } as unknown as GoalNegotiator));

    const runner = new CLIRunner(tmpDir);
    // Description has no filename with an extension — no auto-registration expected
    const exitCode = await runner.run(["goal", "add", "Make sure the required file exists"]);

    expect(exitCode).toBe(0);

    const configs = readDatasourceConfigs(tmpDir);
    const feConfig = configs.find((c) => c["type"] === "file_existence");
    // No matching filename in description, so no registration
    expect(feConfig).toBeUndefined();
  });

  it("auto-registered config has correct structure (type, connection, dimension_mapping)", async () => {
    const goal = makeGoal({
      description: "Ensure README.md exists",
      dimensions: [
        {
          name: "readme_md_exists",
          label: "README.md Exists",
          threshold: { type: "present" },
          observation_method: {
            type: "mechanical",
            source: "file_existence",
            schedule: null,
            endpoint: null,
            confidence_tier: "mechanical",
          },
          current_value: null,
          confidence: 0.5,
          last_updated: null,
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });

    const sm = new StateManager(tmpDir);
    await sm.saveGoal(goal);

    vi.mocked(GoalNegotiator).mockImplementation(() => ({
      negotiate: vi.fn().mockResolvedValue(makeNegotiationResult(goal)),
    } as unknown as GoalNegotiator));

    const runner = new CLIRunner(tmpDir);
    await runner.run(["goal", "add", "Ensure README.md exists"]);

    const configs = readDatasourceConfigs(tmpDir);
    const feConfig = configs.find((c) => c["type"] === "file_existence");
    expect(feConfig).toBeDefined();

    // Must have required DataSourceConfig fields
    expect(typeof feConfig!["id"]).toBe("string");
    expect(typeof feConfig!["name"]).toBe("string");
    expect(feConfig!["type"]).toBe("file_existence");
    expect(feConfig!["enabled"]).toBe(true);
    expect(typeof feConfig!["created_at"]).toBe("string");
    expect(typeof feConfig!["connection"]).toBe("object");
    expect(typeof feConfig!["dimension_mapping"]).toBe("object");
  });
});
