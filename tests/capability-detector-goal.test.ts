import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state/state-manager.js";
import { ReportingEngine } from "../src/reporting/reporting-engine.js";
import { CapabilityDetector } from "../src/observation/capability-detector.js";
import type {
  Capability,
} from "../src/types/capability.js";
import type { LLMMessage } from "../src/llm/llm-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";

// ─── Fixtures ───

function makeCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    id: "cap-001",
    name: "Stripe API",
    description: "Access to Stripe payment API",
    type: "service",
    status: "available",
    ...overrides,
  };
}

const NO_GOAL_GAP_RESPONSE = JSON.stringify({ has_gap: false });

const GOAL_GAP_SERVICE_RESPONSE = JSON.stringify({
  has_gap: true,
  missing_capability: { name: "close_github_issue", type: "service" },
  reason: "Goal requires closing resolved issues but adapter only supports creating them",
  alternatives: ["Manually close issues via GitHub UI", "Use a different adapter that supports issue management"],
  impact_description: "Cannot automatically close issues when tasks are completed",
  acquirable: true,
});

const GOAL_GAP_NOT_ACQUIRABLE_RESPONSE = JSON.stringify({
  has_gap: true,
  missing_capability: { name: "production_db_write", type: "permission" },
  reason: "Goal requires writing to production database",
  alternatives: [],
  impact_description: "Cannot persist results without production write access",
  acquirable: false,
});

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;
let reportingEngine: ReportingEngine;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-capability-test-"));
  stateManager = new StateManager(tempDir);
  reportingEngine = new ReportingEngine(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── detectGoalCapabilityGap ───

describe("detectGoalCapabilityGap", () => {
  it("returns null when no capability gap detected", async () => {
    const llm = createMockLLMClient([NO_GOAL_GAP_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = await detector.detectGoalCapabilityGap(
      "Create GitHub issues for each open task",
      ["create_github_issue"]
    );

    expect(result).toBeNull();
  });

  it("returns CapabilityGap when goal requires unavailable capability", async () => {
    const llm = createMockLLMClient([GOAL_GAP_SERVICE_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = await detector.detectGoalCapabilityGap(
      "Manage GitHub issues: create and close them as tasks complete",
      ["create_github_issue"]
    );

    expect(result).not.toBeNull();
    expect(result!.gap.missing_capability.name).toBe("close_github_issue");
    expect(result!.gap.missing_capability.type).toBe("service");
    expect(result!.gap.reason).toContain("closing resolved issues");
    expect(result!.gap.alternatives).toHaveLength(2);
  });

  it("includes registry capabilities in available list (prompt context)", async () => {
    const llm = createMockLLMClient([NO_GOAL_GAP_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    // Pre-register a registry capability so it should appear in the prompt
    await detector.registerCapability(makeCapability({
      id: "cap-registry",
      name: "Jira API",
      description: "Access to Jira project management",
      type: "service",
      status: "available",
    }));

    let capturedMessages: LLMMessage[] = [];
    const originalSend = llm.sendMessage.bind(llm);
    llm.sendMessage = async (messages, options) => {
      capturedMessages = messages;
      return originalSend(messages, options);
    };

    await detector.detectGoalCapabilityGap(
      "Track project tasks in Jira",
      ["execute_code"]
    );

    expect(capturedMessages[0]!.content).toContain("Jira API");
    expect(capturedMessages[0]!.content).toContain("execute_code");
  });

  it("handles LLM failure gracefully — returns null", async () => {
    // MockLLMClient throws when responses are exhausted
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = await detector.detectGoalCapabilityGap(
      "Some goal description",
      ["create_github_issue"]
    );

    expect(result).toBeNull();
  });

  it("returns gap with related_task_id undefined — goal-level gap has no task", async () => {
    const llm = createMockLLMClient([GOAL_GAP_SERVICE_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = await detector.detectGoalCapabilityGap(
      "Manage GitHub issues end-to-end",
      ["create_github_issue"]
    );

    expect(result).not.toBeNull();
    expect(result!.gap.related_task_id).toBeUndefined();
  });

  it("returns acquirable=true when capability can be acquired", async () => {
    const llm = createMockLLMClient([GOAL_GAP_SERVICE_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = await detector.detectGoalCapabilityGap(
      "Manage GitHub issues end-to-end",
      ["create_github_issue"]
    );

    expect(result).not.toBeNull();
    expect(result!.acquirable).toBe(true);
    expect(result!.gap.alternatives.length).toBeGreaterThan(0);
  });

  it("returns acquirable=false when capability cannot be acquired", async () => {
    const llm = createMockLLMClient([GOAL_GAP_NOT_ACQUIRABLE_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = await detector.detectGoalCapabilityGap(
      "Persist results to production database",
      []
    );

    expect(result).not.toBeNull();
    expect(result!.acquirable).toBe(false);
    expect(result!.gap.missing_capability.name).toBe("production_db_write");
  });

  it("handles malformed LLM response gracefully — returns null", async () => {
    const llm = createMockLLMClient(["not valid json"]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = await detector.detectGoalCapabilityGap(
      "Some goal description",
      ["create_github_issue"]
    );

    expect(result).toBeNull();
  });
});

// ─── dependency helpers ───

describe("dependency helpers", () => {
  it("addDependency persists dependencies that getDependencies can read back", async () => {
    const detector = new CapabilityDetector(stateManager, createMockLLMClient([]), reportingEngine);

    await detector.addDependency("deploy", ["build", "test"]);

    expect(await detector.getDependencies("deploy")).toEqual(["build", "test"]);
  });

  it("getDependencies returns an empty array when a capability has no dependency entry", async () => {
    const detector = new CapabilityDetector(stateManager, createMockLLMClient([]), reportingEngine);

    expect(await detector.getDependencies("nonexistent")).toEqual([]);
  });

  it("resolveDependencies orders prerequisites before dependents", () => {
    const detector = new CapabilityDetector(stateManager, createMockLLMClient([]), reportingEngine);

    const ordered = detector.resolveDependencies([
      { capability_id: "deploy", depends_on: ["build", "test"] },
      { capability_id: "build", depends_on: ["lint"] },
    ]);

    expect(ordered.indexOf("lint")).toBeLessThan(ordered.indexOf("build"));
    expect(ordered.indexOf("build")).toBeLessThan(ordered.indexOf("deploy"));
    expect(ordered.indexOf("test")).toBeLessThan(ordered.indexOf("deploy"));
  });

  it("detectCircularDependency returns the cycle path when dependencies loop", () => {
    const detector = new CapabilityDetector(stateManager, createMockLLMClient([]), reportingEngine);

    const cycle = detector.detectCircularDependency([
      { capability_id: "tool-a", depends_on: ["tool-b"] },
      { capability_id: "tool-b", depends_on: ["tool-c"] },
      { capability_id: "tool-c", depends_on: ["tool-a"] },
    ]);

    expect(cycle).not.toBeNull();
    expect(cycle![0]).toBe("tool-a");
    expect(cycle![cycle!.length - 1]).toBe("tool-a");
  });

  it("detectCircularDependency returns null when dependencies are acyclic", () => {
    const detector = new CapabilityDetector(stateManager, createMockLLMClient([]), reportingEngine);

    const cycle = detector.detectCircularDependency([
      { capability_id: "build", depends_on: ["lint"] },
      { capability_id: "deploy", depends_on: ["build"] },
    ]);

    expect(cycle).toBeNull();
  });
});

// ─── matchPluginsForGoal ───

describe("matchPluginsForGoal", () => {
  let matchStateManager: StateManager;
  let matchReportingEngine: ReportingEngine;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-match-test-"));
    matchStateManager = new StateManager(tmpDir);
    matchReportingEngine = new ReportingEngine(matchStateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePluginLoader(pluginStates: Array<{
    name: string;
    dimensions?: string[];
    trustScore?: number;
    status?: "loaded" | "error" | "disabled";
  }>): import("../src/runtime/plugin-loader.js").PluginLoader {
    // Mock PluginLoader that returns pre-configured states
    const mockLoader = {
      loadAll: async () => {
        return pluginStates.map((p) => ({
          name: p.name,
          manifest: {
            name: p.name,
            version: "1.0.0",
            type: "data_source" as const,
            capabilities: ["query"],
            dimensions: p.dimensions ?? [],
            description: "test plugin",
            config_schema: {},
            dependencies: [],
            entry_point: "dist/index.js",
            permissions: { network: false, file_read: false, file_write: false, shell: false },
          },
          status: (p.status ?? "loaded") as "loaded" | "error" | "disabled",
          loaded_at: new Date().toISOString(),
          trust_score: p.trustScore ?? 0,
          usage_count: 0,
          success_count: 0,
          failure_count: 0,
        }));
      },
    } as unknown as import("../src/runtime/plugin-loader.js").PluginLoader;
    return mockLoader;
  }

  it("returns empty array when no pluginLoader provided", async () => {
    const detector = new CapabilityDetector(matchStateManager, createMockLLMClient([]), matchReportingEngine);
    const results = await detector.matchPluginsForGoal(["test_coverage"]);
    expect(results).toEqual([]);
  });

  it("returns empty array when no plugins match dimensions", async () => {
    const loader = makePluginLoader([
      { name: "slack-notifier", dimensions: ["notification_sent"] },
    ]);
    const detector = new CapabilityDetector(matchStateManager, createMockLLMClient([]), matchReportingEngine, loader);
    const results = await detector.matchPluginsForGoal(["test_coverage", "lint_errors"]);
    expect(results).toEqual([]);
  });

  it("returns matching plugins sorted by score then trust", async () => {
    const loader = makePluginLoader([
      { name: "coverage-plugin", dimensions: ["test_coverage", "branch_coverage"], trustScore: 10 },
      { name: "quality-plugin", dimensions: ["test_coverage", "lint_errors", "branch_coverage"], trustScore: 5 },
      { name: "lint-plugin", dimensions: ["lint_errors"], trustScore: 30 },
    ]);
    const detector = new CapabilityDetector(matchStateManager, createMockLLMClient([]), matchReportingEngine, loader);
    const results = await detector.matchPluginsForGoal(["test_coverage", "lint_errors"]);

    // quality-plugin: 2/2 = 1.0; coverage-plugin: 1/2 = 0.5; lint-plugin: 1/2 = 0.5
    expect(results[0].pluginName).toBe("quality-plugin");
    expect(results[0].matchScore).toBe(1.0);
    // lint-plugin has higher trust than coverage-plugin at equal score
    expect(results[1].pluginName).toBe("lint-plugin");
    expect(results[2].pluginName).toBe("coverage-plugin");
  });

  it("filters out plugins below 0.5 threshold", async () => {
    const loader = makePluginLoader([
      { name: "partial-plugin", dimensions: ["test_coverage", "x", "y"] }, // 1/3 ≈ 0.33
    ]);
    const detector = new CapabilityDetector(matchStateManager, createMockLLMClient([]), matchReportingEngine, loader);
    const results = await detector.matchPluginsForGoal(["test_coverage", "lint_errors", "complexity"]);
    expect(results).toEqual([]);
  });

  it("sets autoSelectable=true when trust_score >= 20", async () => {
    const loader = makePluginLoader([
      { name: "trusted-plugin", dimensions: ["test_coverage"], trustScore: 20 },
      { name: "low-trust-plugin", dimensions: ["test_coverage"], trustScore: 19 },
    ]);
    const detector = new CapabilityDetector(matchStateManager, createMockLLMClient([]), matchReportingEngine, loader);
    const results = await detector.matchPluginsForGoal(["test_coverage"]);

    const trusted = results.find((r) => r.pluginName === "trusted-plugin");
    const lowTrust = results.find((r) => r.pluginName === "low-trust-plugin");
    expect(trusted?.autoSelectable).toBe(true);
    expect(lowTrust?.autoSelectable).toBe(false);
  });

  it("excludes plugins with status other than loaded", async () => {
    const mockPluginLoader = makePluginLoader([
      {
        name: "disabled-plugin",
        dimensions: ["test_coverage", "lint_errors"],
        trustScore: 50,
        status: "disabled",
      },
      {
        name: "error-plugin",
        dimensions: ["test_coverage"],
        trustScore: 30,
        status: "error",
      },
    ]);
    const detector = new CapabilityDetector(matchStateManager, createMockLLMClient([]), matchReportingEngine, mockPluginLoader);
    const results = await detector.matchPluginsForGoal(["test_coverage", "lint_errors"]);
    expect(results).toEqual([]);
  });

  it("returns empty array when goalDimensions is empty", async () => {
    const mockPluginLoader = makePluginLoader([
      {
        name: "some-plugin",
        dimensions: ["test_coverage"],
        trustScore: 10,
      },
    ]);
    const detector = new CapabilityDetector(matchStateManager, createMockLLMClient([]), matchReportingEngine, mockPluginLoader);
    const results = await detector.matchPluginsForGoal([]);
    expect(results).toEqual([]);
  });
});
