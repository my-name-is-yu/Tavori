import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

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

vi.mock("../src/core/suggest/repo-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/suggest/repo-context.js")>();
  return {
    ...actual,
    listSuggestRepoFiles: vi.fn(actual.listSuggestRepoFiles),
    buildSuggestRepoContext: vi.fn(actual.buildSuggestRepoContext),
  };
});

vi.mock("../src/core-loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core-loop.js")>();
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

import { CLIRunner } from "../src/cli-runner.js";
import { GoalNegotiator } from "../src/goal/goal-negotiator.js";
import { SuggestOutputSchema } from "../src/types/suggest.js";
import { makeTempDir } from "./helpers/temp-dir.js";

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

describe("suggest output schema", () => {
  it("normalizes malformed legacy model output into canonical non-empty JSON", async () => {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test Repo\n");
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    vi.mocked(GoalNegotiator).mockImplementation(() => ({
      suggestGoals: vi.fn().mockResolvedValue({
        suggestions: [
          {
            name: "Improve CLI docs",
            description: "Improve documentation quality",
            why: "The CLI needs clearer repo-scoped guidance.",
            dimensions_hint: ["documentation_quality"],
          },
          {
            title: "",
            rationale: "",
            steps: [],
          },
        ],
      }),
    } as unknown as GoalNegotiator));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await new CLIRunner(tmpDir).run(["suggest", "improve repo docs", "--path", "."]);
    const jsonCall = consoleSpy.mock.calls
      .map((call) => call[0])
      .find((value): value is string => typeof value === "string" && value.trim().startsWith("{"));
    consoleSpy.mockRestore();

    expect(code).toBe(0);
    expect(jsonCall).toBeTruthy();

    const payload = SuggestOutputSchema.parse(JSON.parse(jsonCall as string));
    expect(payload.suggestions.length).toBeGreaterThan(0);
    expect(payload.suggestions[0]).toEqual({
      title: "Improve CLI docs",
      rationale: "The CLI needs clearer repo-scoped guidance.",
      steps: [expect.stringMatching(/Improve documentation quality by updating .* to deliver a verifiable improvement\./)],
      success_criteria: ["documentation_quality reaches target threshold."],
    });
  }, 15000);

  it("retains a raw total count in fallback TODO/FIXME inventory context", async () => {
    fs.mkdirSync(path.join(tmpDir, "tests"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "tests", "sample.test.ts"), "it('works', () => {})\n");
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    vi.mocked(GoalNegotiator).mockImplementation(() => ({
      suggestGoals: vi.fn().mockResolvedValue([]),
    } as unknown as GoalNegotiator));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const context = [
      "TODO-like marker inventory:",
      '  grouped_counts: {"TODO":2,"FIXME":1}',
      "  raw_total_count: 3",
      "  tests/sample.test.ts",
    ].join("\n");
    const code = await new CLIRunner(tmpDir).run(["suggest", context, "--path", "."]);
    const jsonCall = consoleSpy.mock.calls
      .map((call) => call[0])
      .find((value): value is string => typeof value === "string" && value.trim().startsWith("{"));
    consoleSpy.mockRestore();

    expect(code).toBe(0);
    expect(jsonCall).toBeTruthy();

    const payload = SuggestOutputSchema.parse(JSON.parse(jsonCall as string));
    const rationale = payload.suggestions[0]?.rationale ?? "";
    expect(rationale).toContain("raw_total_count");
    expect(rationale).toContain("\"TODO\":2");
    expect(rationale).toContain("\"FIXME\":1");
  }, 15000);

  it("omits repo_context for non-software goals", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    vi.mocked(GoalNegotiator).mockImplementation(() => ({
      suggestGoals: vi.fn().mockResolvedValue({
        suggestions: [
          {
            title: "Improve team communication",
            description: "Schedule weekly sync meetings to align on priorities",
            rationale: "Better communication reduces misunderstandings.",
            dimensions_hint: ["team_alignment"],
          },
        ],
      }),
    } as unknown as GoalNegotiator));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await new CLIRunner(tmpDir).run(["suggest", "improve team communication and collaboration", "--path", "."]);
    const jsonCall = consoleSpy.mock.calls
      .map((call) => call[0])
      .find((value): value is string => typeof value === "string" && value.trim().startsWith("{"));
    consoleSpy.mockRestore();

    expect(code).toBe(0);
    expect(jsonCall).toBeTruthy();

    const payload = SuggestOutputSchema.parse(JSON.parse(jsonCall as string));
    expect(payload.suggestions.length).toBeGreaterThan(0);
    expect(payload.suggestions[0]?.repo_context).toBeUndefined();
  }, 15000);

  it("includes repo_context for software goals", async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test-pkg" }));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    vi.mocked(GoalNegotiator).mockImplementation(() => ({
      suggestGoals: vi.fn().mockResolvedValue({
        suggestions: [
          {
            title: "Add unit tests for src/utils",
            description: "Add unit tests for src/utils to improve coverage",
            rationale: "The module has no tests.",
            dimensions_hint: ["test_coverage"],
          },
        ],
      }),
    } as unknown as GoalNegotiator));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await new CLIRunner(tmpDir).run(["suggest", "improve test coverage for src/ module", "--path", "."]);
    const jsonCall = consoleSpy.mock.calls
      .map((call) => call[0])
      .find((value): value is string => typeof value === "string" && value.trim().startsWith("{"));
    consoleSpy.mockRestore();

    expect(code).toBe(0);
    expect(jsonCall).toBeTruthy();

    const payload = SuggestOutputSchema.parse(JSON.parse(jsonCall as string));
    expect(payload.suggestions.length).toBeGreaterThan(0);
    expect(payload.suggestions[0]?.repo_context).toBeDefined();
    expect(payload.suggestions[0]?.repo_context?.path).toBe(".");
  }, 15000);
});
