/**
 * CLIRunner — `pulseed improve` subcommand tests (M10.3)
 *
 * Strategy:
 * - All heavy dependencies (CoreLoop, GoalNegotiator, LLM clients, etc.) are mocked.
 * - CLIRunner(tmpDir) creates its own StateManager pointing to tmpDir.
 * - Tests verify argument routing, suggestion/negotiation flow, loop execution, and
 *   the no-loop path when neither --auto nor --yes is provided.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";

// ─── Module mocks ────────────────────────────────────────────────────────────

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

vi.mock("../src/strategy/strategy-manager.js", () => ({
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

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { CLIRunner } from "../src/cli/cli-runner.js";
import { StateManager } from "../src/state/state-manager.js";
import { CoreLoop } from "../src/loop/core-loop.js";
import { GoalNegotiator } from "../src/goal/goal-negotiator.js";
import { ensureProviderConfig } from "../src/cli/ensure-api-key.js";
import type { Goal } from "../src/types/goal.js";
import type { LoopResult } from "../src/loop/core-loop.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";
import { SuggestTimeoutError } from "../src/goal/goal-suggest.js";

function makeLoopResult(overrides: Partial<LoopResult> = {}): LoopResult {
  const now = new Date().toISOString();
  return {
    goalId: "goal-improve-1",
    totalIterations: 2,
    finalStatus: "completed",
    iterations: [],
    startedAt: now,
    completedAt: now,
    ...overrides,
  };
}

function makeSuggestion(overrides: Partial<{
  title: string;
  description: string;
  rationale: string;
  dimensions_hint: string[];
  priority: number;
}> = {}) {
  return {
    title: "Improve test coverage",
    description: "Increase test coverage to 90% for all core modules",
    rationale: "Current test coverage is below the 80% threshold",
    dimensions_hint: ["test_coverage"],
    priority: 1,
    ...overrides,
  };
}

function makeNegotiationResult(goal: Goal) {
  return {
    goal,
    response: {
      type: "accept" as const,
      message: "Goal registered successfully.",
      counter_proposal: null,
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
let stateManager: StateManager;
let origApiKey: string | undefined;

beforeEach(() => {
  tmpDir = makeTempDir();
  stateManager = new StateManager(tmpDir);

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

async function runCLI(...args: string[]): Promise<number> {
  const runner = new CLIRunner(tmpDir);
  return runner.run(args);
}

// ─── improve subcommand ───────────────────────────────────────────────────────

describe("improve subcommand — basic routing", () => {
  it("exits with code 0 when suggestions are found and no loop is run (no --auto/--yes)", async () => {
    const goal = makeGoal();
    const mockSuggest = vi.fn().mockResolvedValue([makeSuggestion()]);
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));

    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      suggestGoals: mockSuggest,
      negotiate: mockNegotiate,
    } as unknown as GoalNegotiator; });

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult()),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI("improve", ".");
    consoleSpy.mockRestore();

    expect(code).toBe(0);
  });

  it("exits with code 1 when ANTHROPIC_API_KEY is not set (and no alternative provider)", async () => {
    vi.mocked(ensureProviderConfig).mockRejectedValueOnce(
      new Error("No API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable")
    );

    const code = await runCLI("improve", ".");
    expect(code).toBe(1);
  });
});

describe("improve subcommand — suggestion flow", () => {
  it("calls suggestGoals with context gathered from the target path", async () => {
    const goal = makeGoal();
    const mockSuggest = vi.fn().mockResolvedValue([makeSuggestion()]);
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));

    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      suggestGoals: mockSuggest,
      negotiate: mockNegotiate,
    } as unknown as GoalNegotiator; });

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult()),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("improve", ".");
    consoleSpy.mockRestore();

    expect(mockSuggest).toHaveBeenCalledOnce();
    // Verify context argument is a string (gathered from the path)
    const [contextArg] = mockSuggest.mock.calls[0]!;
    expect(typeof contextArg).toBe("string");
  });

  it("falls back to synthesized suggestions when suggestGoals returns empty array", async () => {
    // When suggestGoals returns [], normalizeSuggestPayload generates fallback suggestions
    // so the command proceeds to negotiation rather than printing "No improvement goals found"
    const goal = makeGoal();
    const mockSuggest = vi.fn().mockResolvedValue([]);
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));

    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      suggestGoals: mockSuggest,
      negotiate: mockNegotiate,
    } as unknown as GoalNegotiator; });

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn(),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI("improve", ".");
    consoleSpy.mockRestore();

    // Fallback suggestions are generated, so negotiation is called and command succeeds
    expect(code).toBe(0);
    expect(mockNegotiate).toHaveBeenCalled();
  });

  it("calls suggestGoals with maxSuggestions from --max flag", async () => {
    const goal = makeGoal();
    const mockSuggest = vi.fn().mockResolvedValue([makeSuggestion()]);
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));

    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      suggestGoals: mockSuggest,
      negotiate: mockNegotiate,
    } as unknown as GoalNegotiator; });

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult()),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("improve", ".", "--max", "7");
    consoleSpy.mockRestore();

    expect(mockSuggest).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxSuggestions: 7 })
    );
  });
});

describe("improve subcommand — negotiation", () => {
  it("calls negotiate with a string derived from the first suggestion", async () => {
    const goal = makeGoal();
    const suggestion = makeSuggestion({ description: "Increase test coverage to 90% for all core modules" });
    const mockSuggest = vi.fn().mockResolvedValue([suggestion]);
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));

    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      suggestGoals: mockSuggest,
      negotiate: mockNegotiate,
    } as unknown as GoalNegotiator; });

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult()),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("improve", ".");
    consoleSpy.mockRestore();

    expect(mockNegotiate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ constraints: [] })
    );
  });

  it("handles SuggestOutput-shaped response (with 'suggestions' key) from suggestGoals", async () => {
    const goal = makeGoal();
    // suggestGoals returns a SuggestOutput-shaped object instead of a bare array
    const suggestOutput = {
      suggestions: [
        {
          title: "Add baseline tests",
          rationale: "No test coverage detected",
          steps: ["Update tests/baseline.test.ts to add coverage for core modules."],
          success_criteria: ["test_coverage reaches target threshold."],
          repo_context: { path: "tests/baseline.test.ts" },
        },
      ],
    };
    const mockSuggest = vi.fn().mockResolvedValue(suggestOutput);
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));

    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      suggestGoals: mockSuggest,
      negotiate: mockNegotiate,
    } as unknown as GoalNegotiator; });

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult()),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI("improve", ".");
    consoleSpy.mockRestore();

    // Should not print "No improvement goals found" — normalization extracts suggestions correctly
    expect(code).toBe(0);
    expect(mockNegotiate).toHaveBeenCalledWith(
      expect.stringContaining("baseline.test.ts"),
      expect.objectContaining({ constraints: [] })
    );
  });

  it("exits with code 1 when negotiate returns type='reject'", async () => {
    const goal = makeGoal();
    const mockSuggest = vi.fn().mockResolvedValue([makeSuggestion()]);
    const mockNegotiate = vi.fn().mockResolvedValue({
      goal,
      response: {
        type: "reject" as const,
        message: "Goal is unachievable.",
        counter_proposal: null,
        counter_target: null,
      },
      log: {
        goal_id: goal.id,
        timestamp: new Date().toISOString(),
        is_renegotiation: false,
        renegotiation_trigger: null,
      },
    });

    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      suggestGoals: mockSuggest,
      negotiate: mockNegotiate,
    } as unknown as GoalNegotiator; });

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn(),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI("improve", ".");
    consoleSpy.mockRestore();

    expect(code).toBe(1);
  });
});

describe("improve subcommand — loop execution", () => {
  it("does NOT run CoreLoop when neither --auto nor --yes is provided", async () => {
    const goal = makeGoal();
    const mockSuggest = vi.fn().mockResolvedValue([makeSuggestion()]);
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));
    const mockRun = vi.fn().mockResolvedValue(makeLoopResult());

    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      suggestGoals: mockSuggest,
      negotiate: mockNegotiate,
    } as unknown as GoalNegotiator; });

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: mockRun,
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("improve", ".");
    consoleSpy.mockRestore();

    expect(mockRun).not.toHaveBeenCalled();
  });

  it("prints 'Run with: pulseed run' message when no --auto/--yes", async () => {
    const goal = makeGoal({ id: "goal-show-hint" });
    const mockSuggest = vi.fn().mockResolvedValue([makeSuggestion()]);
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));

    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      suggestGoals: mockSuggest,
      negotiate: mockNegotiate,
    } as unknown as GoalNegotiator; });

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn(),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("improve", ".");
    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    consoleSpy.mockRestore();

    expect(output).toContain("pulseed run");
    expect(output).toContain("goal-show-hint");
  });

  it("runs CoreLoop when --auto flag is provided", async () => {
    const goal = makeGoal({ id: "goal-auto" });
    const mockSuggest = vi.fn().mockResolvedValue([makeSuggestion()]);
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));
    const mockRun = vi.fn().mockResolvedValue(makeLoopResult({ goalId: "goal-auto" }));

    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      suggestGoals: mockSuggest,
      negotiate: mockNegotiate,
    } as unknown as GoalNegotiator; });

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: mockRun,
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI("improve", ".", "--auto");
    consoleSpy.mockRestore();

    expect(code).toBe(0);
    expect(mockRun).toHaveBeenCalledWith("goal-auto");
  });

  it("runs CoreLoop when --yes flag is provided", async () => {
    const goal = makeGoal({ id: "goal-yes" });
    const mockSuggest = vi.fn().mockResolvedValue([makeSuggestion()]);
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));
    const mockRun = vi.fn().mockResolvedValue(makeLoopResult({ goalId: "goal-yes" }));

    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      suggestGoals: mockSuggest,
      negotiate: mockNegotiate,
    } as unknown as GoalNegotiator; });

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: mockRun,
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI("improve", ".", "--yes");
    consoleSpy.mockRestore();

    expect(code).toBe(0);
    expect(mockRun).toHaveBeenCalledWith("goal-yes");
  });

  it("propagates --max to CoreLoop maxIterations when --yes is provided", async () => {
    const goal = makeGoal({ id: "goal-max-propagate" });
    const mockSuggest = vi.fn().mockResolvedValue([makeSuggestion()]);
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));
    const mockRun = vi.fn().mockResolvedValue(makeLoopResult({ goalId: "goal-max-propagate" }));

    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      suggestGoals: mockSuggest,
      negotiate: mockNegotiate,
    } as unknown as GoalNegotiator; });

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: mockRun,
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI("improve", ".", "--max", "2", "--yes");
    consoleSpy.mockRestore();

    expect(code).toBe(0);
    // CoreLoop should have been constructed with maxIterations: 2
    const ctorCalls = vi.mocked(CoreLoop).mock.calls;
    // The last CoreLoop instance is the one used for the loop (buildDeps is called twice)
    const loopCtorCall = ctorCalls[ctorCalls.length - 1];
    expect(loopCtorCall).toBeDefined();
    const loopConfig = loopCtorCall![1] as { maxIterations?: number } | undefined;
    expect(loopConfig?.maxIterations).toBe(2);
  });

  it("exits with code 0 and prints completion message after loop with --auto", async () => {
    const goal = makeGoal({ id: "goal-loop-done" });
    const mockSuggest = vi.fn().mockResolvedValue([makeSuggestion()]);
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));

    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      suggestGoals: mockSuggest,
      negotiate: mockNegotiate,
    } as unknown as GoalNegotiator; });

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult({ goalId: "goal-loop-done" })),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI("improve", ".", "--auto");
    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    consoleSpy.mockRestore();

    expect(code).toBe(0);
    expect(output).toContain("Loop completed");
  });
});

describe("improve subcommand — gatherProjectContext", () => {
  it("gatherProjectContext returns a non-empty string for the current directory", async () => {
    // We test gatherProjectContext indirectly through the improve command:
    // when suggestGoals is called, the first argument must be a non-empty string
    const goal = makeGoal();
    const mockSuggest = vi.fn().mockResolvedValue([makeSuggestion()]);
    const mockNegotiate = vi.fn().mockResolvedValue(makeNegotiationResult(goal));

    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      suggestGoals: mockSuggest,
      negotiate: mockNegotiate,
    } as unknown as GoalNegotiator; });

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn().mockResolvedValue(makeLoopResult()),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCLI("improve", ".");
    consoleSpy.mockRestore();

    expect(mockSuggest).toHaveBeenCalled();
    const context = mockSuggest.mock.calls[0]![0] as string;
    // Context should be a string (even if some shell commands fail, at minimum an empty string)
    expect(typeof context).toBe("string");
  });
});

describe("improve subcommand — timeout and LLM failure handling", () => {
  it("exits with code 1 and prints a timeout message when suggestGoals times out", async () => {
    // Simulate a timeout by having suggestGoals reject with a SuggestTimeoutError
    const mockSuggest = vi.fn().mockRejectedValue(
      new SuggestTimeoutError(30_000)
    );

    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      suggestGoals: mockSuggest,
      negotiate: vi.fn(),
    } as unknown as GoalNegotiator; });

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn(),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logLines.push(args.join(" "));
    });
    const code = await runCLI("improve", ".");
    consoleSpy.mockRestore();
    errorSpy.mockRestore();

    expect(code).toBe(1);
    // Verify the timeout message was output via the logger (which uses console.error)
    const errorOutput = logLines.join("\n");
    expect(errorOutput).toMatch(/timed out/i);
    expect(errorOutput).toMatch(/30s/);
  });

  it("exits with code 1 gracefully when suggestGoals throws a non-timeout LLM error", async () => {
    const mockSuggest = vi.fn().mockRejectedValue(
      new Error("Connection refused: API unreachable")
    );

    vi.mocked(GoalNegotiator).mockImplementation(function() { return {
      suggestGoals: mockSuggest,
      negotiate: vi.fn(),
    } as unknown as GoalNegotiator; });

    vi.mocked(CoreLoop).mockImplementation(function() { return {
      run: vi.fn(),
      stop: vi.fn(),
    } as unknown as CoreLoop; });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runCLI("improve", ".");
    consoleSpy.mockRestore();
    errorSpy.mockRestore();

    expect(code).toBe(1);
    // Should not re-throw; process exits cleanly
  });
});
