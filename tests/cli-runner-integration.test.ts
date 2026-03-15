/**
 * CLIRunner Integration Tests — P1-5
 *
 * Tests CLIRunner wired with real GoalNegotiator + real CoreLoop
 * using MockLLMClient (from helpers/mock-llm.ts) and a MockAdapter.
 *
 * Strategy:
 * - Only LLMClient, adapter layer, and a few heavyweight deps are mocked
 * - GoalNegotiator and CoreLoop run as real implementations
 * - StateManager uses a temp directory for isolation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockLLMClient } from "./helpers/mock-llm.js";

// ─── Module mocks ─────────────────────────────────────────────────────────────
// Only mock modules that would make real network/process calls.

vi.mock("../src/llm-client.js", () => ({
  LLMClient: vi.fn().mockImplementation(() => ({})),
  MockLLMClient: vi.fn(),
}));

vi.mock("../src/adapters/claude-code-cli.js", () => ({
  ClaudeCodeCLIAdapter: vi.fn().mockImplementation(() => ({
    adapterType: "claude-code-cli",
    async execute() {
      return {
        success: true,
        output: "Task completed",
        error: null,
        exit_code: 0,
        elapsed_ms: 10,
        stopped_reason: "completed",
      };
    },
  })),
}));

vi.mock("../src/adapters/claude-api.js", () => ({
  ClaudeAPIAdapter: vi.fn().mockImplementation(() => ({
    adapterType: "claude-api",
    async execute() {
      return {
        success: true,
        output: "Task completed",
        error: null,
        exit_code: 0,
        elapsed_ms: 10,
        stopped_reason: "completed",
      };
    },
  })),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { CLIRunner } from "../src/cli-runner.js";
import { StateManager } from "../src/state-manager.js";
import type { Goal } from "../src/types/goal.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-cli-integ-test-"));
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: "integ-goal-1",
    parent_id: null,
    node_type: "goal",
    title: "Integration Test Goal",
    description: "Improve test coverage to 80%",
    status: "active",
    dimensions: [
      {
        name: "test_coverage",
        label: "Test Coverage",
        current_value: 0.5,
        threshold: { type: "min", value: 80 },
        confidence: 0.5,
        observation_method: {
          type: "llm_review",
          source: "Run test suite",
          schedule: null,
          endpoint: null,
          confidence_tier: "self_report",
        },
        last_updated: null,
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
    origin: "manual",
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

async function runCLI(tmpDir: string, ...args: string[]): Promise<number> {
  const runner = new CLIRunner(tmpDir);
  return runner.run(args);
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

let tmpDir: string;
let stateManager: StateManager;
let origApiKey: string | undefined;

beforeEach(() => {
  tmpDir = makeTempDir();
  stateManager = new StateManager(tmpDir);
  origApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-api-key-for-integration";
});

afterEach(() => {
  if (origApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = origApiKey;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ─── goal add — real GoalNegotiator ──────────────────────────────────────────

describe("goal add with real GoalNegotiator", () => {
  it("invokes GoalNegotiator.negotiate and saves goal to StateManager on success", async () => {
    // GoalNegotiator.negotiate() calls LLM several times:
    // 1. EthicsGate.checkGoal (1 call)
    // 2. buildDecompositionPrompt (1 call)
    // 3. buildFeasibilityPrompt (N calls, 1 per dimension)
    // 4. buildCounterProposalPrompt if ratio too high (0-1 call)
    // 5. buildNegotiationResponsePrompt (1 call)

    const ethicsPass = JSON.stringify({ verdict: "pass", reasoning: "Acceptable goal" });
    const decomposition = JSON.stringify([
      {
        name: "test_coverage",
        label: "Test Coverage",
        threshold_type: "min",
        threshold_value: 80,
        observation_method_hint: "Run test suite and check coverage report",
      },
    ]);
    const feasibility = JSON.stringify({
      feasibility_ratio: 1.2,
      is_feasible: true,
      adjusted_target: null,
      reasoning: "Achievable with current velocity",
    });
    const negotiationResponse = JSON.stringify({
      type: "accept",
      message: "Goal accepted. Test coverage target of 80% is feasible.",
      counter_target: null,
    });

    // Wire up a shared MockLLMClient that CLIRunner will use internally.
    // CLIRunner creates a real LLMClient via the mocked constructor — we need
    // to inject our mock before construction. We do this by overriding the
    // LLMClient mock implementation for this test.
    const { LLMClient } = await import("../src/llm-client.js");
    const capabilityCheck = JSON.stringify({ gaps: [] });
    const mockLLM = createMockLLMClient([
      ethicsPass,
      decomposition,
      feasibility,
      capabilityCheck,
      negotiationResponse,
    ]);
    vi.mocked(LLMClient).mockImplementation(() => mockLLM as unknown as InstanceType<typeof LLMClient>);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCLI(tmpDir, "goal", "add", "Improve test coverage to 80%");

    consoleSpy.mockRestore();

    // Exit 0 means negotiate succeeded
    expect(code).toBe(0);

    // Verify a goal was actually saved to state
    const goalIds = stateManager.listGoalIds();
    expect(goalIds.length).toBeGreaterThan(0);
    const goals = goalIds.map((id) => stateManager.loadGoal(id)).filter(Boolean);
    expect(goals.length).toBeGreaterThan(0);
    expect(goals[0]!.description).toContain("Improve test coverage");
  });

  it("exits with code 1 when GoalNegotiator ethics gate rejects the goal", async () => {
    const ethicsReject = JSON.stringify({
      verdict: "reject",
      reasoning: "Goal is harmful",
    });

    const { LLMClient } = await import("../src/llm-client.js");
    const mockLLM = createMockLLMClient([ethicsReject]);
    vi.mocked(LLMClient).mockImplementation(() => mockLLM as unknown as InstanceType<typeof LLMClient>);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runCLI(tmpDir, "goal", "add", "Delete all user data without consent");
    errorSpy.mockRestore();

    expect(code).toBe(1);
  });

  it("goal added via real GoalNegotiator appears in goal list output", async () => {
    const ethicsPass = JSON.stringify({ verdict: "pass", reasoning: "Acceptable" });
    const decomposition = JSON.stringify([
      {
        name: "coverage",
        label: "Coverage",
        threshold_type: "min",
        threshold_value: 70,
        observation_method_hint: "Check coverage report",
      },
    ]);
    const feasibility = JSON.stringify({
      feasibility_ratio: 1.1,
      is_feasible: true,
      adjusted_target: null,
      reasoning: "Feasible",
    });
    const negotiationResponse = JSON.stringify({
      type: "accept",
      message: "Goal accepted",
      counter_target: null,
    });

    const capabilityCheck = JSON.stringify({ gaps: [] });
    const { LLMClient } = await import("../src/llm-client.js");
    const mockLLM = createMockLLMClient([
      ethicsPass,
      decomposition,
      feasibility,
      capabilityCheck,
      negotiationResponse,
    ]);
    vi.mocked(LLMClient).mockImplementation(() => mockLLM as unknown as InstanceType<typeof LLMClient>);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const addCode = await runCLI(tmpDir, "goal", "add", "Improve coverage");
    expect(addCode).toBe(0);

    const listCode = await runCLI(tmpDir, "goal", "list");
    expect(listCode).toBe(0);

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    // The negotiated goal title or description should appear in list
    expect(output.toLowerCase()).toMatch(/coverage|improve/);
    consoleSpy.mockRestore();
  });
});

// ─── run — real CoreLoop (max_iterations=1) ───────────────────────────────────

describe("run subcommand with real CoreLoop (max_iterations=1)", () => {
  it("runs CoreLoop to completion with max_iterations=1 using MockLLM", async () => {
    // Pre-save a goal so CLIRunner can find it
    const goal = makeGoal({ id: "run-integ-goal" });
    stateManager.saveGoal(goal);

    // CoreLoop needs LLM responses for:
    // 1. ObservationEngine (LLM-based observation for each dimension)
    // 2. TaskLifecycle.generateTask (task generation)
    // 3. TaskLifecycle.verifyTask -> runLLMReview (LLM review)
    // Additional calls may happen for session context, strategy generation, etc.
    // We provide generous responses and use max-iterations=1 to keep it short.

    const observationResponse = JSON.stringify({
      current_value: 0.6,
      confidence: 0.7,
      evidence: "Coverage is at 60%",
      method: "llm_inference",
    });
    const taskResponse = `\`\`\`json
{
  "work_description": "Add tests for core module",
  "rationale": "Increase test coverage",
  "approach": "Use vitest to write tests",
  "success_criteria": [
    {
      "description": "Tests pass",
      "verification_method": "Run vitest",
      "is_blocking": true
    }
  ],
  "scope_boundary": {
    "in_scope": ["src/core"],
    "out_of_scope": ["src/ui"],
    "blast_radius": "tests directory"
  },
  "constraints": [],
  "reversibility": "reversible",
  "estimated_duration": { "value": 1, "unit": "hours" }
}
\`\`\``;
    const llmReviewResponse = JSON.stringify({
      verdict: "pass",
      reasoning: "All criteria satisfied",
      criteria_met: 1,
      criteria_total: 1,
    });

    const { LLMClient } = await import("../src/llm-client.js");
    // Provide many responses since CoreLoop may make multiple LLM calls
    const mockLLM = createMockLLMClient([
      observationResponse,
      observationResponse,
      taskResponse,
      llmReviewResponse,
      llmReviewResponse,
      llmReviewResponse,
      observationResponse,
    ]);
    vi.mocked(LLMClient).mockImplementation(() => mockLLM as unknown as InstanceType<typeof LLMClient>);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCLI(
      tmpDir,
      "run",
      "--goal",
      "run-integ-goal",
      "--max-iterations",
      "1"
    );

    consoleSpy.mockRestore();

    // Exit code 0 = completed or max_iterations reached
    expect(code).toBe(0);
  });

  it("exits with code 1 when the goal ID does not exist in state", async () => {
    const { LLMClient } = await import("../src/llm-client.js");
    const mockLLM = createMockLLMClient([]);
    vi.mocked(LLMClient).mockImplementation(() => mockLLM as unknown as InstanceType<typeof LLMClient>);

    const code = await runCLI(tmpDir, "run", "--goal", "nonexistent-goal-id");
    expect(code).toBe(1);
  });

  it("exits with code 1 when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    stateManager.saveGoal(makeGoal({ id: "key-test-goal" }));

    const code = await runCLI(tmpDir, "run", "--goal", "key-test-goal");
    expect(code).toBe(1);
  });
});

// ─── goal list — reads real state ─────────────────────────────────────────────

describe("goal list reads real StateManager state", () => {
  it("shows goals saved directly to StateManager", async () => {
    stateManager.saveGoal(makeGoal({ id: "direct-goal-1", title: "Direct Goal Alpha" }));
    stateManager.saveGoal(makeGoal({ id: "direct-goal-2", title: "Direct Goal Beta" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI(tmpDir, "goal", "list");
    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    consoleSpy.mockRestore();

    expect(code).toBe(0);
    expect(output).toContain("direct-goal-1");
    expect(output).toContain("direct-goal-2");
  });

  it("shows empty state message when no goals exist", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI(tmpDir, "goal", "list");
    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n").toLowerCase();
    consoleSpy.mockRestore();

    expect(code).toBe(0);
    expect(output).toMatch(/no goals|0 goals|no registered|use.*goal add/);
  });
});
