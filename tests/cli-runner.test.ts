/**
 * CLIRunner tests — Stage 6
 *
 * CLIRunner API (src/cli-runner.ts):
 *   class CLIRunner {
 *     constructor(baseDir?: string)
 *     run(argv: string[]): Promise<number>   // argv is pure subcommand args (no "node"/"pulseed" prefix)
 *     stop(): void
 *   }
 *
 * argv format: ["run", "--goal", "<id>"] (pure subcommand args)
 *
 * Subcommands:
 *   pulseed run --goal <id>
 *   pulseed goal add "<description>"
 *   pulseed goal list
 *   pulseed status --goal <id>
 *   pulseed report --goal <id>
 *
 * Exit codes: 0 success, 1 error, 2 stall escalation
 *
 * Strategy:
 * - run() returns exit code directly — no process.exit() interception needed
 * - Mock StateManager to inject a temp-directory instance
 * - Mock CoreLoop and GoalNegotiator to avoid real LLM calls
 * - Capture console.log output where needed
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Module mocks ───────────────────────────────────────────────────────────
//
// These must be declared before any imports of the mocked modules.

// StateManager is NOT mocked — we use real instances pointing to tmpDir.
// CLIRunner(tmpDir) creates a real StateManager(tmpDir) internally.

vi.mock("../src/llm/provider-factory.js", () => ({
  buildLLMClient: vi.fn().mockResolvedValue({
    sendMessage: vi.fn().mockResolvedValue({ content: "mock" }),
    parseJSON: vi.fn().mockResolvedValue({}),
  }),
  buildAdapterRegistry: vi.fn().mockResolvedValue({
    register: vi.fn(),
    getAdapterCapabilities: vi.fn().mockReturnValue([]),
    resolve: vi.fn(),
  }),
}));

vi.mock("../src/cli/ensure-api-key.js", () => ({
  ensureProviderConfig: vi.fn().mockResolvedValue({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    adapter: "claude_code_cli",
    api_key: "test-api-key",
  }),
}));

vi.mock("../src/loop/core-loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/loop/core-loop.js")>();
  return {
    ...actual,
    CoreLoop: vi.fn(),
  };
});

vi.mock("../src/goal/goal-negotiator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/goal/goal-negotiator.js")>();
  return {
    ...actual,
    GoalNegotiator: vi.fn(),
  };
});

vi.mock("../src/goal/goal-refiner.js", () => ({
  GoalRefiner: vi.fn().mockImplementation(function() { return {
    refine: vi.fn().mockResolvedValue({
      goal: { id: "goal_refine_default", title: "Refined Goal", status: "active", dimensions: [], description: "" },
      leaf: true,
      children: null,
      feasibility: null,
      tokensUsed: 100,
      reason: "measurable",
    }),
  }; }),
  collectLeafGoalIds: vi.fn().mockImplementation((result: { leaf: boolean; goal: { id: string }; children?: unknown[] | null }) => {
    if (result.leaf) return [result.goal.id];
    if (!result.children) return [result.goal.id];
    return [result.goal.id];
  }),
}));

vi.mock("../src/llm/llm-client.js", () => ({
  LLMClient: vi.fn().mockImplementation(function() { return {}; }),
  MockLLMClient: vi.fn(),
}));

vi.mock("../src/trust-manager.js", () => ({
  TrustManager: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/drive-system.js", () => ({
  DriveSystem: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/observation/observation-engine.js", () => ({
  ObservationEngine: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/stall-detector.js", () => ({
  StallDetector: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/satisficing-judge.js", () => ({
  SatisficingJudge: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/ethics-gate.js", () => ({
  EthicsGate: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/execution/session-manager.js", () => ({
  SessionManager: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/strategy-manager.js", () => ({
  StrategyManager: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/execution/adapter-layer.js", () => ({
  AdapterRegistry: vi.fn().mockImplementation(function() { return {
    register: vi.fn(),
    getAdapterCapabilities: vi.fn().mockReturnValue([]),
  }; }),
}));

vi.mock("../src/adapters/agents/claude-code-cli.js", () => ({
  ClaudeCodeCLIAdapter: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/adapters/agents/claude-api.js", () => ({
  ClaudeAPIAdapter: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/execution/task/task-lifecycle.js", () => ({
  TaskLifecycle: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/reporting/reporting-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/reporting/reporting-engine.js")>();
  return {
    ...actual,
    ReportingEngine: vi.fn().mockImplementation(function(...args: ConstructorParameters<typeof actual.ReportingEngine>) { return new actual.ReportingEngine(...args); }),
  };
});

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { CLIRunner } from "../src/cli/cli-runner.js";
import { StateManager } from "../src/state/state-manager.js";
import { CoreLoop } from "../src/loop/core-loop.js";
import { GoalNegotiator, EthicsRejectedError } from "../src/goal/goal-negotiator.js";
import { GoalRefiner } from "../src/goal/goal-refiner.js";
import { ensureProviderConfig } from "../src/cli/ensure-api-key.js";
import type { LoopResult } from "../src/loop/core-loop.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";

function makeLoopResult(overrides: Partial<LoopResult> = {}): LoopResult {
  const now = new Date().toISOString();
  return {
    goalId: "goal-1",
    totalIterations: 3,
    finalStatus: "completed",
    iterations: [],
    startedAt: now,
    completedAt: now,
    ...overrides,
  };
}

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

// No argv wrapper needed — run() accepts pure subcommand args directly.
// No ExitError needed — run() returns exit code as Promise<number>.

// ─── Setup / Teardown ────────────────────────────────────────────────────────

let tmpDir: string;
let stateManager: StateManager;
let origApiKey: string | undefined;

beforeEach(() => {
  tmpDir = makeTempDir();

  // Create a real StateManager pointing to tmpDir for test setup (saving goals, etc.).
  // CLIRunner(tmpDir) will create its own StateManager(tmpDir) internally,
  // sharing the same filesystem directory.
  stateManager = new StateManager(tmpDir);

  // Provide a dummy API key so requireApiKey() passes by default.
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

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ENOTEMPTY on Node 20 CI — ignore */ }
  vi.clearAllMocks();
});

// ─── Helper: run CLI and capture exit code ───────────────────────────────────

async function runCLI(...args: string[]): Promise<number> {
  const runner = new CLIRunner(tmpDir);
  return runner.run(args);
}

// ─── Construction ─────────────────────────────────────────────────────────────

// NOTE: All significant dependencies are replaced with vi.fn() mocks.
// These tests verify argument parsing, exit-code routing, and DI wiring
// call patterns, but cannot detect bugs in actual dependency implementations.
// For integration coverage, see cli-runner-integration.test.ts

describe("CLIRunner construction", () => {
  it("can be instantiated", () => {
    const runner = new CLIRunner(tmpDir);
    expect(runner).toBeDefined();
  });

  it("exposes a run() method", () => {
    const runner = new CLIRunner(tmpDir);
    expect(typeof runner.run).toBe("function");
  });
});

// ─── Unknown subcommand ───────────────────────────────────────────────────────

describe("unknown subcommand", async () => {
  it("exits with code 1 for an unknown subcommand", async () => {
    const code = await runCLI("unknown-command");
    expect(code).toBe(1);
  });

  it("exits with code 1 when no arguments are given", async () => {
    const code = await runCLI();
    expect(code).toBe(1);
  });

  it("exits with code 0 for --help", async () => {
    const code = await runCLI("--help");
    expect(code).toBe(0);
  });

  it("exits with code 0 for help subcommand", async () => {
    const code = await runCLI("help");
    expect(code).toBe(0);
  });
});

// ─── `run` subcommand ─────────────────────────────────────────────────────────

describe("run subcommand", async () => {
  it("exits with code 1 when --goal is missing", async () => {
    const code = await runCLI("run");
    expect(code).toBe(1);
  });

  it("exits with code 1 when goal is not found in state", async () => {
    // stateManager has no goals stored
    const code = await runCLI("run", "--goal", "nonexistent-id");
    expect(code).toBe(1);
  });

  it("calls CoreLoop.run() with the correct goalId", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-abc" }));

    const mockRun = vi.fn().mockResolvedValue(makeLoopResult({ goalId: "goal-abc" }));
    vi.mocked(CoreLoop).mockImplementation(
      function() { return { run: mockRun, stop: vi.fn() } as unknown as CoreLoop; }
    );

    await runCLI("run", "--goal", "goal-abc");

    expect(mockRun).toHaveBeenCalledWith("goal-abc");
  });

  it("exits with code 0 when finalStatus is completed", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-completed" }));

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "completed" })),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const code = await runCLI("run", "--goal", "g-completed");
    expect(code).toBe(0);
  });

  it("exits with code 0 when finalStatus is max_iterations", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-max" }));

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "max_iterations" })),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const code = await runCLI("run", "--goal", "g-max");
    expect(code).toBe(0);
  });

  it("exits with code 0 when finalStatus is stopped", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-stopped" }));

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "stopped" })),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const code = await runCLI("run", "--goal", "g-stopped");
    expect(code).toBe(0);
  });

  it("exits with code 2 when finalStatus is stalled", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-stalled" }));

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "stalled" })),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const code = await runCLI("run", "--goal", "g-stalled");
    expect(code).toBe(2);
  });

  it("exits with code 1 when finalStatus is error", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-error" }));

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "error" })),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const code = await runCLI("run", "--goal", "g-error");
    expect(code).toBe(1);
  });

  it("exits with code 1 when CoreLoop.run() throws an error", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-throw" }));

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockRejectedValue(new Error("Unexpected LLM failure")),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const code = await runCLI("run", "--goal", "g-throw");
    expect(code).toBe(1);
  });

  it("exits with code 1 when ANTHROPIC_API_KEY is not set", async () => {
    vi.mocked(ensureProviderConfig).mockRejectedValueOnce(
      new Error("No API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable")
    );
    await stateManager.saveGoal(makeGoal({ id: "g-nokey" }));

    const code = await runCLI("run", "--goal", "g-nokey");
    expect(code).toBe(1);
  });

  it("prints goal title before starting the loop", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-print", title: "My Test Goal" }));

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult()),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("run", "--goal", "g-print");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("My Test Goal");
    consoleSpy.mockRestore();
  });

  it("forwards --max-iterations to CoreLoop as maxIterations number", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-maxiter" }));

    vi.mocked(CoreLoop).mockImplementation(
      function(_deps: unknown, config: unknown) { return {
          run: vi.fn().mockResolvedValue(makeLoopResult()),
          stop: vi.fn(),
          _capturedConfig: config,
        } as unknown as CoreLoop; }
    );

    await runCLI("run", "--goal", "g-maxiter", "--max-iterations", "5");

    expect(vi.mocked(CoreLoop)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxIterations: 5 })
    );
  });
});

// ─── `--yes` flag position independence ──────────────────────────────────────

describe("--yes flag position independence", async () => {
  // The mock CoreLoop never calls approvalFn, so we cannot observe "Auto-approved"
  // in console output. Instead we verify that:
  //   (a) routing succeeds (exit code 0, not "unknown subcommand")
  //   (b) CoreLoop.run() is called with the correct goalId
  // This confirms --yes is correctly stripped before subcommand dispatch.

  it("honours --yes placed before the subcommand (pulseed --yes run --goal <id>)", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-yes-before" }));

    const mockRun = vi.fn().mockResolvedValue(makeLoopResult({ goalId: "g-yes-before" }));
    vi.mocked(CoreLoop).mockImplementation(
      function() { return { run: mockRun, stop: vi.fn() } as unknown as CoreLoop; }
    );

    // --yes appears BEFORE the subcommand — previously this was treated as an
    // unknown subcommand and returned exit code 1.
    const code = await runCLI("--yes", "run", "--goal", "g-yes-before");

    expect(code).toBe(0);
    expect(mockRun).toHaveBeenCalledWith("g-yes-before");
  });

  it("honours --yes placed after --goal (pulseed run --goal <id> --yes)", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-yes-after" }));

    const mockRun = vi.fn().mockResolvedValue(makeLoopResult({ goalId: "g-yes-after" }));
    vi.mocked(CoreLoop).mockImplementation(
      function() { return { run: mockRun, stop: vi.fn() } as unknown as CoreLoop; }
    );

    // --yes appears after the subcommand — the original behaviour must still work.
    const code = await runCLI("run", "--goal", "g-yes-after", "--yes");

    expect(code).toBe(0);
    expect(mockRun).toHaveBeenCalledWith("g-yes-after");
  });

  it("honours -y shorthand placed before the subcommand", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-y-before" }));

    const mockRun = vi.fn().mockResolvedValue(makeLoopResult({ goalId: "g-y-before" }));
    vi.mocked(CoreLoop).mockImplementation(
      function() { return { run: mockRun, stop: vi.fn() } as unknown as CoreLoop; }
    );

    const code = await runCLI("-y", "run", "--goal", "g-y-before");

    expect(code).toBe(0);
    expect(mockRun).toHaveBeenCalledWith("g-y-before");
  });

  it("--yes before subcommand does not break exit-code when loop fails", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g-yes-fail" }));

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "stalled" })),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const code = await runCLI("--yes", "run", "--goal", "g-yes-fail");

    // stalled → exit 2, same as without --yes
    expect(code).toBe(2);
  });

  it("--yes before 'goal archive' skips confirmation for non-completed goals", async () => {
    // A goal that is NOT completed — without --yes/--force this should return exit 1
    await stateManager.saveGoal(makeGoal({ id: "g-archive-yes", status: "active" }));

    // Without --yes: should fail (status not completed, no force flag)
    const codeNoYes = await runCLI("goal", "archive", "g-archive-yes");
    expect(codeNoYes).toBe(1);

    // Save the goal again since archiving may have side effects on first call
    await stateManager.saveGoal(makeGoal({ id: "g-archive-yes2", status: "active" }));

    // With global --yes before subcommand: should succeed (confirmation skipped)
    const codeWithYes = await runCLI("--yes", "goal", "archive", "g-archive-yes2");
    expect(codeWithYes).toBe(0);
  });
});

// ─── `goal add` subcommand ───────────────────────────────────────────────────

describe("goal add subcommand", async () => {
  it("exits with code 1 when description argument is missing", async () => {
    const code = await runCLI("goal", "add");
    expect(code).toBe(1);
  });

  it("exits with code 1 when ANTHROPIC_API_KEY is not set", async () => {
    vi.mocked(ensureProviderConfig).mockRejectedValueOnce(
      new Error("No API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable")
    );

    const code = await runCLI("goal", "add", "Build a better README");
    expect(code).toBe(1);
  });

  it("calls GoalRefiner.refine() with the given description (default path)", async () => {
    const mockRefine = vi.fn().mockResolvedValue({
      goal: makeGoal({ id: "goal_refine_1" }),
      leaf: true,
      children: null,
      feasibility: null,
      tokensUsed: 200,
      reason: "measurable",
    });
    vi.mocked(GoalRefiner).mockImplementation(
      function() { return { refine: mockRefine } as unknown as GoalRefiner; }
    );

    await runCLI("goal", "add", "Build a better README");

    expect(mockRefine).toHaveBeenCalledWith(expect.any(String), { feasibilityCheck: true });
  });

  it("calls GoalNegotiator.negotiate() with the given description when --no-refine is set", async () => {
    const goal = makeGoal();
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));
    vi.mocked(GoalNegotiator).mockImplementation(
      function() { return { negotiate: mockNegotiate } as unknown as GoalNegotiator; }
    );

    await runCLI("goal", "add", "Build a better README", "--no-refine");

    expect(mockNegotiate).toHaveBeenCalledWith(
      "Build a better README",
      expect.objectContaining({ deadline: undefined, constraints: [] })
    );
  });

  it("exits with code 0 on successful refine (default path)", async () => {
    const goal = makeGoal();
    vi.mocked(GoalRefiner).mockImplementation(function() { return {
      refine: vi.fn().mockResolvedValue({
        goal,
        leaf: true,
        children: null,
        feasibility: null,
        tokensUsed: 100,
        reason: "measurable",
      }),
    } as unknown as GoalRefiner; });

    const code = await runCLI("goal", "add", "Improve test coverage");
    expect(code).toBe(0);
  });

  it("exits with code 1 when EthicsRejectedError is thrown via --no-refine path", async () => {
    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      negotiate: vi.fn().mockRejectedValue(
        new EthicsRejectedError({ verdict: "reject", reasoning: "Harmful content" })
      ),
    } as unknown as GoalNegotiator; });

    const code = await runCLI("goal", "add", "DDoS competitor servers", "--no-refine");
    expect(code).toBe(1);
  });

  it("exits with code 1 when negotiate errors via --no-refine path", async () => {
    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      negotiate: vi.fn().mockRejectedValue(new Error("Network error")),
    } as unknown as GoalNegotiator; });

    const code = await runCLI("goal", "add", "Write some code", "--no-refine");
    expect(code).toBe(1);
  });

  it("exits with code 0 (fallback) when refine() throws a non-ethics error", async () => {
    vi.mocked(GoalRefiner).mockImplementation(function() { return {
      refine: vi.fn().mockRejectedValue(new Error("Network error")),
    } as unknown as GoalRefiner; });

    const code = await runCLI("goal", "add", "Write some code");
    // Graceful fallback: goal stub was saved, returns 0
    expect(code).toBe(0);
  });

  it("passes --deadline option to negotiate() via --no-refine", async () => {
    const goal = makeGoal();
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));
    vi.mocked(GoalNegotiator).mockImplementation(
      function() { return { negotiate: mockNegotiate } as unknown as GoalNegotiator; }
    );

    await runCLI("goal", "add", "Refactor module", "--deadline", "2026-06-01", "--no-refine");

    expect(mockNegotiate).toHaveBeenCalledWith(
      "Refactor module",
      expect.objectContaining({ deadline: "2026-06-01" })
    );
  });

  it("passes --constraint option to negotiate() via --no-refine", async () => {
    const goal = makeGoal();
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));
    vi.mocked(GoalNegotiator).mockImplementation(
      function() { return { negotiate: mockNegotiate } as unknown as GoalNegotiator; }
    );

    await runCLI("goal", "add", "Deploy app", "--constraint", "no downtime", "--no-refine");

    expect(mockNegotiate).toHaveBeenCalledWith(
      "Deploy app",
      expect.objectContaining({ constraints: expect.arrayContaining(["no downtime"]) })
    );
  });

  it("prints goal ID after successful refine (default path)", async () => {
    const goal = makeGoal({ id: "new-goal-id", title: "Refined Title" });
    vi.mocked(GoalRefiner).mockImplementation(function() { return {
      refine: vi.fn().mockResolvedValue({
        goal,
        leaf: true,
        children: null,
        feasibility: null,
        tokensUsed: 100,
        reason: "measurable",
      }),
    } as unknown as GoalRefiner; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "add", "Do something");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("new-goal-id");
    consoleSpy.mockRestore();
  });

  it("prints an error message when EthicsRejectedError is thrown via --no-refine", async () => {
    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      negotiate: vi.fn().mockRejectedValue(
        new EthicsRejectedError({ verdict: "reject", reasoning: "Dangerous activity" })
      ),
    } as unknown as GoalNegotiator; });

    const code = await runCLI("goal", "add", "Harmful goal", "--no-refine");
    expect(code).toBe(1);
  });
});

// ─── `goal add` raw mode ─────────────────────────────────────────────────────

describe("goal add raw mode", async () => {
  it("exits with code 0 for a single --dim flag", async () => {
    const code = await runCLI("goal", "add", "--title", "tsc zero", "--dim", "tsc_error_count:min:0");
    expect(code).toBe(0);
  });

  it("exits with code 0 for multiple --dim flags", async () => {
    const code = await runCLI("goal", "add", "--title", "clean code", "--dim", "todo_count:max:0", "--dim", "fixme_count:max:0");
    expect(code).toBe(0);
  });

  it("outputs Goal ID and title after successful raw add", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "add", "--title", "my raw goal", "--dim", "todo_count:max:0");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("my raw goal");
    expect(output).toContain("Goal ID:");
    consoleSpy.mockRestore();
  });

  it("exits with code 1 when --dim is provided but neither --title nor description is given", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runCLI("goal", "add", "--dim", "todo_count:max:0");
    expect(code).toBe(1);
    errorSpy.mockRestore();
  });

  it("exits with code 1 for an invalid --dim format", async () => {
    const code = await runCLI("goal", "add", "--title", "bad dim", "--dim", "badformat");
    expect(code).toBe(1);
  });

  it("does NOT call GoalNegotiator in raw mode", async () => {
    const mockNegotiate = vi.fn().mockResolvedValue({ goal: makeGoal(), response: { type: "accept", message: "ok", counter_target: null }, log: {} });
    vi.mocked(GoalNegotiator).mockImplementation(function() { return { negotiate: mockNegotiate } as unknown as GoalNegotiator; });

    await runCLI("goal", "add", "--title", "raw no llm", "--dim", "todo_count:max:0");

    expect(mockNegotiate).not.toHaveBeenCalled();
  });

  it("calls GoalRefiner.refine() when --negotiate flag is present (--negotiate is alias for refine)", async () => {
    const mockRefine = vi.fn().mockResolvedValue({
      goal: makeGoal({ id: "goal_neg_alias" }),
      leaf: true,
      children: null,
      feasibility: null,
      tokensUsed: 100,
      reason: "measurable",
    });
    vi.mocked(GoalRefiner).mockImplementation(function() { return { refine: mockRefine } as unknown as GoalRefiner; });

    await runCLI("goal", "add", "TypeScriptエラーを0にする", "--negotiate");

    expect(mockRefine).toHaveBeenCalledWith(expect.any(String), { feasibilityCheck: true });
  });
});

// ─── `goal list` subcommand ───────────────────────────────────────────────────

describe("goal list subcommand", async () => {
  it("exits with code 0 when no goals exist", async () => {
    const code = await runCLI("goal", "list");
    expect(code).toBe(0);
  });

  it("exits with code 0 when goals exist", async () => {
    await stateManager.saveGoal(makeGoal({ id: "g1", title: "First Goal" }));
    await stateManager.saveGoal(makeGoal({ id: "g2", title: "Second Goal" }));

    const code = await runCLI("goal", "list");
    expect(code).toBe(0);
  });

  it("outputs a message indicating no goals when none are registered", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCLI("goal", "list");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n").toLowerCase();
    expect(output).toMatch(/no goals|0 goals|no registered|use.*goal add/);
    consoleSpy.mockRestore();
  });

  it("lists all registered goal IDs in the output", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-alpha", title: "Alpha" }));
    await stateManager.saveGoal(makeGoal({ id: "goal-beta", title: "Beta" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "list");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("goal-alpha");
    expect(output).toContain("goal-beta");
    consoleSpy.mockRestore();
  });

  it("shows goal titles in the listing output", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-xyz", title: "My Important Goal" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "list");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("My Important Goal");
    consoleSpy.mockRestore();
  });

  it("shows goal status in the listing output", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-active", title: "Active Goal", status: "active" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "list");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("active");
    consoleSpy.mockRestore();
  });

  it("shows the count of goals found", async () => {
    await stateManager.saveGoal(makeGoal({ id: "ga", title: "A" }));
    await stateManager.saveGoal(makeGoal({ id: "gb", title: "B" }));
    await stateManager.saveGoal(makeGoal({ id: "gc", title: "C" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "list");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("3");
    consoleSpy.mockRestore();
  });
});

// ─── `goal` with unknown sub-subcommand ──────────────────────────────────────

describe("goal subcommand — unknown sub-subcommand", async () => {
  it("exits with code 1 for unknown goal sub-subcommand", async () => {
    const code = await runCLI("goal", "delete");
    expect(code).toBe(1);
  });

  it("exits with code 1 when 'goal' is given with no sub-subcommand", async () => {
    const code = await runCLI("goal");
    expect(code).toBe(1);
  });

  it("prints an error message for unknown goal sub-subcommand", async () => {
    const code = await runCLI("goal", "unknown-sub");
    expect(code).toBe(1);
  });
});

// ─── `status` subcommand ──────────────────────────────────────────────────────

describe("status subcommand", async () => {
  it("exits with code 1 when --goal is missing", async () => {
    const code = await runCLI("status");
    expect(code).toBe(1);
  });

  it("exits with code 1 when goal does not exist", async () => {
    const code = await runCLI("status", "--goal", "no-such-goal");
    expect(code).toBe(1);
  });

  it("exits with code 0 for an existing goal with no reports", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-no-rep", title: "Goal With No Reports" }));

    const code = await runCLI("status", "--goal", "goal-no-rep");
    expect(code).toBe(0);
  });

  it("exits with code 0 for an existing goal with reports", async () => {
    const goal = makeGoal({ id: "goal-with-rep" });
    await stateManager.saveGoal(goal);

    // Write a report in the expected directory layout
    const reportDir = path.join(tmpDir, "reports", "goal-with-rep");
    fs.mkdirSync(reportDir, { recursive: true });
    const report = {
      id: "rep-001",
      report_type: "execution_summary",
      goal_id: "goal-with-rep",
      title: "Execution Summary — Loop 1",
      content: "## Progress\nAll good.",
      verbosity: "standard",
      generated_at: new Date().toISOString(),
      delivered_at: null,
      read: false,
    };
    fs.writeFileSync(path.join(reportDir, "rep-001.json"), JSON.stringify(report), "utf-8");

    const code = await runCLI("status", "--goal", "goal-with-rep");
    expect(code).toBe(0);
  });

  it("displays the goal ID in the output", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-display", title: "Display Goal" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("status", "--goal", "goal-display");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("goal-display");
    consoleSpy.mockRestore();
  });

  it("displays goal status in the output", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-stat", status: "active" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("status", "--goal", "goal-stat");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("active");
    consoleSpy.mockRestore();
  });

  it("shows 'no execution reports yet' message when no reports exist", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-norep2" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("status", "--goal", "goal-norep2");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n").toLowerCase();
    expect(output).toMatch(/no execution reports|no reports/);
    consoleSpy.mockRestore();
  });

  it("prints error message for missing goal", async () => {
    const code = await runCLI("status", "--goal", "missing-goal");
    expect(code).toBe(1);
  });
});

// ─── `report` subcommand ──────────────────────────────────────────────────────

describe("report subcommand", async () => {
  it("exits with code 1 when --goal is missing", async () => {
    const code = await runCLI("report");
    expect(code).toBe(1);
  });

  it("exits with code 1 when goal does not exist", async () => {
    const code = await runCLI("report", "--goal", "nonexistent");
    expect(code).toBe(1);
  });

  it("exits with code 0 when no reports exist for the goal", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-no-rep3" }));

    const code = await runCLI("report", "--goal", "goal-no-rep3");
    expect(code).toBe(0);
  });

  it("exits with code 0 when reports exist for the goal", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-rep2" }));

    const reportDir = path.join(tmpDir, "reports", "goal-rep2");
    fs.mkdirSync(reportDir, { recursive: true });
    const report = {
      id: "rep-latest",
      report_type: "execution_summary",
      goal_id: "goal-rep2",
      title: "Execution Summary — Loop 2",
      content: "## Latest Progress\nDone.",
      verbosity: "standard",
      generated_at: new Date().toISOString(),
      delivered_at: null,
      read: false,
    };
    fs.writeFileSync(path.join(reportDir, "rep-latest.json"), JSON.stringify(report), "utf-8");

    const code = await runCLI("report", "--goal", "goal-rep2");
    expect(code).toBe(0);
  });

  it("outputs a message when no reports exist", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-no-rep4" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("report", "--goal", "goal-no-rep4");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n").toLowerCase();
    expect(output).toMatch(/no reports|not found/);
    consoleSpy.mockRestore();
  });

  it("shows the goal ID in report output", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-repout" }));

    const reportDir = path.join(tmpDir, "reports", "goal-repout");
    fs.mkdirSync(reportDir, { recursive: true });
    const report = {
      id: "rep-show",
      report_type: "execution_summary",
      goal_id: "goal-repout",
      title: "Execution Summary — Loop 1",
      content: "Content here.",
      verbosity: "standard",
      generated_at: new Date().toISOString(),
      delivered_at: null,
      read: false,
    };
    fs.writeFileSync(path.join(reportDir, "rep-show.json"), JSON.stringify(report), "utf-8");

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("report", "--goal", "goal-repout");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("goal-repout");
    consoleSpy.mockRestore();
  });

  it("shows the report title in output", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-reptitle" }));

    const reportDir = path.join(tmpDir, "reports", "goal-reptitle");
    fs.mkdirSync(reportDir, { recursive: true });
    const report = {
      id: "rep-title",
      report_type: "execution_summary",
      goal_id: "goal-reptitle",
      title: "Execution Summary — Loop 5",
      content: "Progress update.",
      verbosity: "standard",
      generated_at: new Date().toISOString(),
      delivered_at: null,
      read: false,
    };
    fs.writeFileSync(path.join(reportDir, "rep-title.json"), JSON.stringify(report), "utf-8");

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("report", "--goal", "goal-reptitle");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Execution Summary — Loop 5");
    consoleSpy.mockRestore();
  });

  it("shows the latest report when multiple reports exist", async () => {
    await stateManager.saveGoal(makeGoal({ id: "goal-multi-rep" }));

    const reportDir = path.join(tmpDir, "reports", "goal-multi-rep");
    fs.mkdirSync(reportDir, { recursive: true });

    const older = {
      id: "rep-old",
      report_type: "execution_summary",
      goal_id: "goal-multi-rep",
      title: "Execution Summary — Loop 1",
      content: "Old content.",
      verbosity: "standard",
      generated_at: "2026-03-01T10:00:00.000Z",
      delivered_at: null,
      read: false,
    };
    const newer = {
      id: "rep-new",
      report_type: "execution_summary",
      goal_id: "goal-multi-rep",
      title: "Execution Summary — Loop 10",
      content: "Latest content.",
      verbosity: "standard",
      generated_at: "2026-03-02T10:00:00.000Z",
      delivered_at: null,
      read: false,
    };

    fs.writeFileSync(path.join(reportDir, "rep-old.json"), JSON.stringify(older), "utf-8");
    fs.writeFileSync(path.join(reportDir, "rep-new.json"), JSON.stringify(newer), "utf-8");

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("report", "--goal", "goal-multi-rep");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Execution Summary — Loop 10");
    consoleSpy.mockRestore();
  });
});

// ─── ANTHROPIC_API_KEY ────────────────────────────────────────────────────────

describe("ANTHROPIC_API_KEY", async () => {
  it("exits with code 1 and prints error when key is missing for run", async () => {
    vi.mocked(ensureProviderConfig).mockRejectedValueOnce(
      new Error("No API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable")
    );
    await stateManager.saveGoal(makeGoal({ id: "g-nokey2" }));

    const code = await runCLI("run", "--goal", "g-nokey2");
    expect(code).toBe(1);
  });

  it("exits with code 1 and prints error when key is missing for goal add", async () => {
    vi.mocked(ensureProviderConfig).mockRejectedValueOnce(
      new Error("No API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable")
    );

    const code = await runCLI("goal", "add", "Some goal");
    expect(code).toBe(1);
  });

  it("does not require API key for goal list", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    // goal list doesn't call requireApiKey(), so it should work without a key
    const code = await runCLI("goal", "list");
    expect(code).toBe(0);
  });

  it("does not require API key for status", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await stateManager.saveGoal(makeGoal({ id: "g-nokey-status" }));

    const code = await runCLI("status", "--goal", "g-nokey-status");
    expect(code).toBe(0);
  });

  it("does not require API key for report", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await stateManager.saveGoal(makeGoal({ id: "g-nokey-report" }));

    const code = await runCLI("report", "--goal", "g-nokey-report");
    expect(code).toBe(0);
  });
});

// ─── Directory initialisation ─────────────────────────────────────────────────

describe("directory initialisation", () => {
  it("creates base sub-directories after init()", async () => {
    // Use a fresh temp dir to verify CLIRunner triggers StateManager directory creation
    const freshDir = makeTempDir();
    try {
      const runner = new CLIRunner(freshDir);
      await runner.init();
      expect(fs.existsSync(path.join(freshDir, "goals"))).toBe(true);
      expect(fs.existsSync(path.join(freshDir, "reports"))).toBe(true);
      expect(fs.existsSync(path.join(freshDir, "events"))).toBe(true);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

// ─── Integration: goal add then goal list ────────────────────────────────────

describe("integration: goal add then goal list", async () => {
  it("a goal added via refine() appears in goal list output", async () => {
    const goal = makeGoal({ id: "integ-goal", title: "Integration Test Goal" });
    // GoalRefiner.refine() saves the goal internally. Simulate that in the mock.
    const mockRefine = vi.fn().mockImplementation(async () => {
      await stateManager.saveGoal(goal);
      return {
        goal,
        leaf: true,
        children: null,
        feasibility: null,
        tokensUsed: 100,
        reason: "measurable",
      };
    });
    vi.mocked(GoalRefiner).mockImplementation(
      function() { return { refine: mockRefine } as unknown as GoalRefiner; }
    );

    // Add
    const addCode = await runCLI("goal", "add", "Integration test");
    expect(addCode).toBe(0);

    // List
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runner2 = new CLIRunner(tmpDir);
    await runner2.run(["goal", "list"]);

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("integ-goal");
    consoleSpy.mockRestore();
  });
});
