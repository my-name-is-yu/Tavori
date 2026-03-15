/**
 * CLIRunner tests — Stage 6
 *
 * CLIRunner API (src/cli-runner.ts):
 *   class CLIRunner {
 *     constructor(baseDir?: string)
 *     run(argv: string[]): Promise<number>   // argv is pure subcommand args (no "node"/"motiva" prefix)
 *     stop(): void
 *   }
 *
 * argv format: ["run", "--goal", "<id>"] (pure subcommand args)
 *
 * Subcommands:
 *   motiva run --goal <id>
 *   motiva goal add "<description>"
 *   motiva goal list
 *   motiva status --goal <id>
 *   motiva report --goal <id>
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
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Module mocks ───────────────────────────────────────────────────────────
//
// These must be declared before any imports of the mocked modules.

// StateManager is NOT mocked — we use real instances pointing to tmpDir.
// CLIRunner(tmpDir) creates a real StateManager(tmpDir) internally.

vi.mock("../src/core-loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core-loop.js")>();
  return {
    ...actual,
    CoreLoop: vi.fn(),
  };
});

vi.mock("../src/goal-negotiator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/goal-negotiator.js")>();
  return {
    ...actual,
    GoalNegotiator: vi.fn(),
  };
});

vi.mock("../src/llm-client.js", () => ({
  LLMClient: vi.fn().mockImplementation(() => ({})),
  MockLLMClient: vi.fn(),
}));

vi.mock("../src/trust-manager.js", () => ({
  TrustManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/drive-system.js", () => ({
  DriveSystem: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/observation-engine.js", () => ({
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

vi.mock("../src/session-manager.js", () => ({
  SessionManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/strategy-manager.js", () => ({
  StrategyManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../src/adapter-layer.js", () => ({
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

vi.mock("../src/task-lifecycle.js", () => ({
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
import { CoreLoop } from "../src/core-loop.js";
import { GoalNegotiator, EthicsRejectedError } from "../src/goal-negotiator.js";
import type { LoopResult } from "../src/core-loop.js";
import type { Goal } from "../src/types/goal.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-cli-test-"));
}

/** Build a minimal valid Goal object */
function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: "goal-1",
    parent_id: null,
    node_type: "goal",
    title: "Test Goal",
    description: "A test goal description",
    status: "active",
    dimensions: [],
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

describe("unknown subcommand", () => {
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

describe("run subcommand", () => {
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
    stateManager.saveGoal(makeGoal({ id: "goal-abc" }));

    const mockRun = vi.fn().mockResolvedValue(makeLoopResult({ goalId: "goal-abc" }));
    vi.mocked(CoreLoop).mockImplementation(
      () => ({ run: mockRun, stop: vi.fn() } as unknown as CoreLoop)
    );

    await runCLI("run", "--goal", "goal-abc");

    expect(mockRun).toHaveBeenCalledWith("goal-abc");
  });

  it("exits with code 0 when finalStatus is completed", async () => {
    stateManager.saveGoal(makeGoal({ id: "g-completed" }));

    vi.mocked(CoreLoop).mockImplementation(() => ({
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "completed" })),
      stop: vi.fn(),
    } as unknown as CoreLoop));

    const code = await runCLI("run", "--goal", "g-completed");
    expect(code).toBe(0);
  });

  it("exits with code 0 when finalStatus is max_iterations", async () => {
    stateManager.saveGoal(makeGoal({ id: "g-max" }));

    vi.mocked(CoreLoop).mockImplementation(() => ({
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "max_iterations" })),
      stop: vi.fn(),
    } as unknown as CoreLoop));

    const code = await runCLI("run", "--goal", "g-max");
    expect(code).toBe(0);
  });

  it("exits with code 0 when finalStatus is stopped", async () => {
    stateManager.saveGoal(makeGoal({ id: "g-stopped" }));

    vi.mocked(CoreLoop).mockImplementation(() => ({
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "stopped" })),
      stop: vi.fn(),
    } as unknown as CoreLoop));

    const code = await runCLI("run", "--goal", "g-stopped");
    expect(code).toBe(0);
  });

  it("exits with code 2 when finalStatus is stalled", async () => {
    stateManager.saveGoal(makeGoal({ id: "g-stalled" }));

    vi.mocked(CoreLoop).mockImplementation(() => ({
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "stalled" })),
      stop: vi.fn(),
    } as unknown as CoreLoop));

    const code = await runCLI("run", "--goal", "g-stalled");
    expect(code).toBe(2);
  });

  it("exits with code 1 when finalStatus is error", async () => {
    stateManager.saveGoal(makeGoal({ id: "g-error" }));

    vi.mocked(CoreLoop).mockImplementation(() => ({
      run: vi.fn().mockResolvedValue(makeLoopResult({ finalStatus: "error" })),
      stop: vi.fn(),
    } as unknown as CoreLoop));

    const code = await runCLI("run", "--goal", "g-error");
    expect(code).toBe(1);
  });

  it("exits with code 1 when CoreLoop.run() throws an error", async () => {
    stateManager.saveGoal(makeGoal({ id: "g-throw" }));

    vi.mocked(CoreLoop).mockImplementation(() => ({
      run: vi.fn().mockRejectedValue(new Error("Unexpected LLM failure")),
      stop: vi.fn(),
    } as unknown as CoreLoop));

    const code = await runCLI("run", "--goal", "g-throw");
    expect(code).toBe(1);
  });

  it("exits with code 1 when ANTHROPIC_API_KEY is not set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    stateManager.saveGoal(makeGoal({ id: "g-nokey" }));

    const code = await runCLI("run", "--goal", "g-nokey");
    expect(code).toBe(1);
  });

  it("prints goal title before starting the loop", async () => {
    stateManager.saveGoal(makeGoal({ id: "g-print", title: "My Test Goal" }));

    vi.mocked(CoreLoop).mockImplementation(() => ({
      run: vi.fn().mockResolvedValue(makeLoopResult()),
      stop: vi.fn(),
    } as unknown as CoreLoop));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("run", "--goal", "g-print");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("My Test Goal");
    consoleSpy.mockRestore();
  });

  it("forwards --max-iterations to CoreLoop as maxIterations number", async () => {
    stateManager.saveGoal(makeGoal({ id: "g-maxiter" }));

    vi.mocked(CoreLoop).mockImplementation(
      (_deps, config) =>
        ({
          run: vi.fn().mockResolvedValue(makeLoopResult()),
          stop: vi.fn(),
          _capturedConfig: config,
        } as unknown as CoreLoop)
    );

    await runCLI("run", "--goal", "g-maxiter", "--max-iterations", "5");

    expect(vi.mocked(CoreLoop)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxIterations: 5 })
    );
  });
});

// ─── `goal add` subcommand ───────────────────────────────────────────────────

describe("goal add subcommand", () => {
  it("exits with code 1 when description argument is missing", async () => {
    const code = await runCLI("goal", "add");
    expect(code).toBe(1);
  });

  it("exits with code 1 when ANTHROPIC_API_KEY is not set", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const code = await runCLI("goal", "add", "Build a better README");
    expect(code).toBe(1);
  });

  it("calls GoalNegotiator.negotiate() with the given description", async () => {
    const goal = makeGoal();
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));
    vi.mocked(GoalNegotiator).mockImplementation(
      () => ({ negotiate: mockNegotiate } as unknown as GoalNegotiator)
    );

    await runCLI("goal", "add", "Build a better README");

    expect(mockNegotiate).toHaveBeenCalledWith(
      "Build a better README",
      expect.objectContaining({ deadline: undefined, constraints: [] })
    );
  });

  it("exits with code 0 on successful negotiation", async () => {
    const goal = makeGoal();
    vi.mocked(GoalNegotiator).mockImplementation(() => ({
      negotiate: vi.fn().mockResolvedValue(makeNegotiationResult(goal)),
    } as unknown as GoalNegotiator));

    const code = await runCLI("goal", "add", "Improve test coverage");
    expect(code).toBe(0);
  });

  it("exits with code 1 when EthicsRejectedError is thrown", async () => {
    vi.mocked(GoalNegotiator).mockImplementation(() => ({
      negotiate: vi.fn().mockRejectedValue(
        new EthicsRejectedError({ verdict: "reject", reasoning: "Harmful content" })
      ),
    } as unknown as GoalNegotiator));

    const code = await runCLI("goal", "add", "DDoS competitor servers");
    expect(code).toBe(1);
  });

  it("re-throws non-EthicsRejectedError errors (propagated to main() which exits 1)", async () => {
    vi.mocked(GoalNegotiator).mockImplementation(() => ({
      negotiate: vi.fn().mockRejectedValue(new Error("Network error")),
    } as unknown as GoalNegotiator));

    const code = await runCLI("goal", "add", "Write some code");
    expect(code).toBe(1);
  });

  it("passes --deadline option to negotiate()", async () => {
    const goal = makeGoal();
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));
    vi.mocked(GoalNegotiator).mockImplementation(
      () => ({ negotiate: mockNegotiate } as unknown as GoalNegotiator)
    );

    await runCLI("goal", "add", "Refactor module", "--deadline", "2026-06-01");

    expect(mockNegotiate).toHaveBeenCalledWith(
      "Refactor module",
      expect.objectContaining({ deadline: "2026-06-01" })
    );
  });

  it("passes --constraint option to negotiate()", async () => {
    const goal = makeGoal();
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));
    vi.mocked(GoalNegotiator).mockImplementation(
      () => ({ negotiate: mockNegotiate } as unknown as GoalNegotiator)
    );

    await runCLI("goal", "add", "Deploy app", "--constraint", "no downtime");

    expect(mockNegotiate).toHaveBeenCalledWith(
      "Deploy app",
      expect.objectContaining({ constraints: expect.arrayContaining(["no downtime"]) })
    );
  });

  it("prints goal ID and title after successful negotiation", async () => {
    const goal = makeGoal({ id: "new-goal-id", title: "Negotiated Title" });
    vi.mocked(GoalNegotiator).mockImplementation(() => ({
      negotiate: vi.fn().mockResolvedValue(makeNegotiationResult(goal)),
    } as unknown as GoalNegotiator));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "add", "Do something");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("new-goal-id");
    expect(output).toContain("Negotiated Title");
    consoleSpy.mockRestore();
  });

  it("prints an error message when EthicsRejectedError is thrown", async () => {
    vi.mocked(GoalNegotiator).mockImplementation(() => ({
      negotiate: vi.fn().mockRejectedValue(
        new EthicsRejectedError({ verdict: "reject", reasoning: "Dangerous activity" })
      ),
    } as unknown as GoalNegotiator));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runCLI("goal", "add", "Harmful goal");

    const output = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output.toLowerCase()).toContain("ethics");
    errorSpy.mockRestore();
  });
});

// ─── `goal list` subcommand ───────────────────────────────────────────────────

describe("goal list subcommand", () => {
  it("exits with code 0 when no goals exist", async () => {
    const code = await runCLI("goal", "list");
    expect(code).toBe(0);
  });

  it("exits with code 0 when goals exist", async () => {
    stateManager.saveGoal(makeGoal({ id: "g1", title: "First Goal" }));
    stateManager.saveGoal(makeGoal({ id: "g2", title: "Second Goal" }));

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
    stateManager.saveGoal(makeGoal({ id: "goal-alpha", title: "Alpha" }));
    stateManager.saveGoal(makeGoal({ id: "goal-beta", title: "Beta" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "list");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("goal-alpha");
    expect(output).toContain("goal-beta");
    consoleSpy.mockRestore();
  });

  it("shows goal titles in the listing output", async () => {
    stateManager.saveGoal(makeGoal({ id: "goal-xyz", title: "My Important Goal" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "list");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("My Important Goal");
    consoleSpy.mockRestore();
  });

  it("shows goal status in the listing output", async () => {
    stateManager.saveGoal(makeGoal({ id: "goal-active", title: "Active Goal", status: "active" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "list");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("active");
    consoleSpy.mockRestore();
  });

  it("shows the count of goals found", async () => {
    stateManager.saveGoal(makeGoal({ id: "ga", title: "A" }));
    stateManager.saveGoal(makeGoal({ id: "gb", title: "B" }));
    stateManager.saveGoal(makeGoal({ id: "gc", title: "C" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("goal", "list");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("3");
    consoleSpy.mockRestore();
  });
});

// ─── `goal` with unknown sub-subcommand ──────────────────────────────────────

describe("goal subcommand — unknown sub-subcommand", () => {
  it("exits with code 1 for unknown goal sub-subcommand", async () => {
    const code = await runCLI("goal", "delete");
    expect(code).toBe(1);
  });

  it("exits with code 1 when 'goal' is given with no sub-subcommand", async () => {
    const code = await runCLI("goal");
    expect(code).toBe(1);
  });

  it("prints an error message for unknown goal sub-subcommand", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runCLI("goal", "unknown-sub");

    const output = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n").toLowerCase();
    expect(output).toContain("unknown");
    errorSpy.mockRestore();
  });
});

// ─── `status` subcommand ──────────────────────────────────────────────────────

describe("status subcommand", () => {
  it("exits with code 1 when --goal is missing", async () => {
    const code = await runCLI("status");
    expect(code).toBe(1);
  });

  it("exits with code 1 when goal does not exist", async () => {
    const code = await runCLI("status", "--goal", "no-such-goal");
    expect(code).toBe(1);
  });

  it("exits with code 0 for an existing goal with no reports", async () => {
    stateManager.saveGoal(makeGoal({ id: "goal-no-rep", title: "Goal With No Reports" }));

    const code = await runCLI("status", "--goal", "goal-no-rep");
    expect(code).toBe(0);
  });

  it("exits with code 0 for an existing goal with reports", async () => {
    const goal = makeGoal({ id: "goal-with-rep" });
    stateManager.saveGoal(goal);

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
    stateManager.saveGoal(makeGoal({ id: "goal-display", title: "Display Goal" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("status", "--goal", "goal-display");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("goal-display");
    consoleSpy.mockRestore();
  });

  it("displays goal status in the output", async () => {
    stateManager.saveGoal(makeGoal({ id: "goal-stat", status: "active" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("status", "--goal", "goal-stat");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("active");
    consoleSpy.mockRestore();
  });

  it("shows 'no execution reports yet' message when no reports exist", async () => {
    stateManager.saveGoal(makeGoal({ id: "goal-norep2" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("status", "--goal", "goal-norep2");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n").toLowerCase();
    expect(output).toMatch(/no execution reports|no reports/);
    consoleSpy.mockRestore();
  });

  it("prints error message for missing goal", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runCLI("status", "--goal", "missing-goal");

    const output = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("missing-goal");
    errorSpy.mockRestore();
  });
});

// ─── `report` subcommand ──────────────────────────────────────────────────────

describe("report subcommand", () => {
  it("exits with code 1 when --goal is missing", async () => {
    const code = await runCLI("report");
    expect(code).toBe(1);
  });

  it("exits with code 1 when goal does not exist", async () => {
    const code = await runCLI("report", "--goal", "nonexistent");
    expect(code).toBe(1);
  });

  it("exits with code 0 when no reports exist for the goal", async () => {
    stateManager.saveGoal(makeGoal({ id: "goal-no-rep3" }));

    const code = await runCLI("report", "--goal", "goal-no-rep3");
    expect(code).toBe(0);
  });

  it("exits with code 0 when reports exist for the goal", async () => {
    stateManager.saveGoal(makeGoal({ id: "goal-rep2" }));

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
    stateManager.saveGoal(makeGoal({ id: "goal-no-rep4" }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("report", "--goal", "goal-no-rep4");

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n").toLowerCase();
    expect(output).toMatch(/no reports|not found/);
    consoleSpy.mockRestore();
  });

  it("shows the goal ID in report output", async () => {
    stateManager.saveGoal(makeGoal({ id: "goal-repout" }));

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
    stateManager.saveGoal(makeGoal({ id: "goal-reptitle" }));

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
    stateManager.saveGoal(makeGoal({ id: "goal-multi-rep" }));

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

describe("ANTHROPIC_API_KEY", () => {
  it("exits with code 1 and prints error when key is missing for run", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    stateManager.saveGoal(makeGoal({ id: "g-nokey2" }));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runCLI("run", "--goal", "g-nokey2");

    expect(code).toBe(1);
    const output = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output.toLowerCase()).toContain("anthropic_api_key");
    errorSpy.mockRestore();
  });

  it("exits with code 1 and prints error when key is missing for goal add", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runCLI("goal", "add", "Some goal");

    expect(code).toBe(1);
    const output = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output.toLowerCase()).toContain("anthropic_api_key");
    errorSpy.mockRestore();
  });

  it("does not require API key for goal list", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    // goal list doesn't call requireApiKey(), so it should work without a key
    const code = await runCLI("goal", "list");
    expect(code).toBe(0);
  });

  it("does not require API key for status", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    stateManager.saveGoal(makeGoal({ id: "g-nokey-status" }));

    const code = await runCLI("status", "--goal", "g-nokey-status");
    expect(code).toBe(0);
  });

  it("does not require API key for report", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    stateManager.saveGoal(makeGoal({ id: "g-nokey-report" }));

    const code = await runCLI("report", "--goal", "g-nokey-report");
    expect(code).toBe(0);
  });
});

// ─── Directory initialisation ─────────────────────────────────────────────────

describe("directory initialisation", () => {
  it("creates base sub-directories on construction", () => {
    // Use a fresh temp dir to verify CLIRunner triggers StateManager directory creation
    const freshDir = makeTempDir();
    try {
      new CLIRunner(freshDir);
      expect(fs.existsSync(path.join(freshDir, "goals"))).toBe(true);
      expect(fs.existsSync(path.join(freshDir, "reports"))).toBe(true);
      expect(fs.existsSync(path.join(freshDir, "events"))).toBe(true);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

// ─── Integration: goal add then goal list ────────────────────────────────────

describe("integration: goal add then goal list", () => {
  it("a goal added via negotiate() appears in goal list output", async () => {
    const goal = makeGoal({ id: "integ-goal", title: "Integration Test Goal" });
    // The real GoalNegotiator.negotiate() saves the goal internally before returning.
    // Simulate that behaviour in the mock so goal list can find it.
    const mockNegotiate = vi.fn().mockImplementation(async () => {
      stateManager.saveGoal(goal);
      return makeNegotiationResult(goal);
    });
    vi.mocked(GoalNegotiator).mockImplementation(
      () => ({ negotiate: mockNegotiate } as unknown as GoalNegotiator)
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
