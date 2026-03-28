/**
 * CLIRunner — knowledge subcommand tests
 *
 * Verifies that `pulseed knowledge list`, `pulseed knowledge search`, and
 * `pulseed knowledge stats` work correctly against the shared knowledge base
 * stored in StateManager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";

// ─── Module mocks (must precede imports of mocked modules) ───────────────────

vi.mock("../src/core-loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core-loop.js")>();
  return { ...actual, CoreLoop: vi.fn() };
});

vi.mock("../src/goal/goal-negotiator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/goal/goal-negotiator.js")>();
  return { ...actual, GoalNegotiator: vi.fn() };
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

vi.mock("../src/llm/provider-factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/provider-factory.js")>();
  return {
    ...actual,
    buildLLMClient: vi.fn().mockReturnValue({}),
    buildAdapterRegistry: vi.fn().mockResolvedValue({
      register: vi.fn(),
      getAdapterCapabilities: vi.fn().mockReturnValue([]),
    }),
  };
});

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { CLIRunner } from "../src/cli-runner.js";
import { StateManager } from "../src/state-manager.js";
import type { SharedKnowledgeEntry } from "../src/types/knowledge.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSharedKnowledgeEntry(overrides: Partial<SharedKnowledgeEntry> = {}): SharedKnowledgeEntry {
  return {
    entry_id: `entry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    question: "What is the test question?",
    answer: "The test answer.",
    sources: [],
    confidence: 0.9,
    acquired_at: new Date().toISOString(),
    acquisition_task_id: "task-001",
    superseded_by: null,
    tags: ["test"],
    embedding_id: null,
    source_goal_ids: ["goal-001"],
    domain_stability: "moderate",
    revalidation_due_at: new Date(Date.now() + 86400000).toISOString(),
    ...overrides,
  };
}

async function writeSharedKnowledge(
  baseDir: string,
  entries: SharedKnowledgeEntry[]
): Promise<void> {
  const sm = new StateManager(baseDir);
  await sm.init();
  await sm.writeRaw("memory/shared-knowledge/entries.json", entries);
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

let tmpDir: string;
let origApiKey: string | undefined;
let consoleLogs: string[];
let consoleErrors: string[];

beforeEach(() => {
  tmpDir = makeTempDir();
  origApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-api-key";
  consoleLogs = [];
  consoleErrors = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    consoleLogs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  });
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
  vi.restoreAllMocks();
});

// ─── Tests: knowledge list ────────────────────────────────────────────────────

describe("CLIRunner — pulseed knowledge list", () => {
  it("shows a message when no knowledge entries exist", async () => {
    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["knowledge", "list"]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("No knowledge entries found");
  });

  it("lists a single knowledge entry", async () => {
    const entry = makeSharedKnowledgeEntry({
      question: "How does TypeScript work?",
      answer: "TypeScript is a typed superset of JavaScript.",
      tags: ["typescript", "language"],
      confidence: 0.95,
    });
    await writeSharedKnowledge(tmpDir, [entry]);

    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["knowledge", "list"]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("1 knowledge entry");
    expect(allOutput).toContain("typescript");
    expect(allOutput).toContain("How does TypeScript work?");
  });

  it("lists multiple knowledge entries", async () => {
    const entries = [
      makeSharedKnowledgeEntry({
        entry_id: "entry-aaa",
        question: "Question A",
        answer: "Answer A",
        tags: ["tag-a"],
      }),
      makeSharedKnowledgeEntry({
        entry_id: "entry-bbb",
        question: "Question B",
        answer: "Answer B",
        tags: ["tag-b"],
      }),
    ];
    await writeSharedKnowledge(tmpDir, entries);

    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["knowledge", "list"]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("2 knowledge entry");
    expect(allOutput).toContain("Question A");
    expect(allOutput).toContain("Question B");
  });
});

// ─── Tests: knowledge search ─────────────────────────────────────────────────

describe("CLIRunner — pulseed knowledge search", () => {
  it("returns error when no query argument is provided", async () => {
    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["knowledge", "search"]);

    expect(exitCode).toBe(1);
    const errOutput = consoleErrors.join("\n");
    expect(errOutput).toContain("query is required");
  });

  it("shows message when no entries match the query", async () => {
    const entry = makeSharedKnowledgeEntry({
      question: "What is TypeScript?",
      answer: "A typed language.",
      tags: ["typescript"],
    });
    await writeSharedKnowledge(tmpDir, [entry]);

    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["knowledge", "search", "golang"]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("No knowledge entries matched");
  });

  it("returns matching entries by question text", async () => {
    const entries = [
      makeSharedKnowledgeEntry({
        question: "How does TypeScript work?",
        answer: "Typed superset of JS.",
        tags: ["typescript"],
      }),
      makeSharedKnowledgeEntry({
        question: "How does Python work?",
        answer: "Interpreted language.",
        tags: ["python"],
      }),
    ];
    await writeSharedKnowledge(tmpDir, entries);

    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["knowledge", "search", "TypeScript"]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("1 matching");
    expect(allOutput).toContain("How does TypeScript work?");
    expect(allOutput).not.toContain("How does Python work?");
  });

  it("matches entries by tag", async () => {
    const entry = makeSharedKnowledgeEntry({
      question: "Is Node.js fast?",
      answer: "Yes, V8-powered.",
      tags: ["nodejs", "performance"],
    });
    await writeSharedKnowledge(tmpDir, [entry]);

    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["knowledge", "search", "nodejs"]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("Is Node.js fast?");
  });

  it("shows message when no entries exist at all", async () => {
    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["knowledge", "search", "anything"]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("No knowledge entries found");
  });
});

// ─── Tests: knowledge stats ───────────────────────────────────────────────────

describe("CLIRunner — pulseed knowledge stats", () => {
  it("shows zero counts when no knowledge exists", async () => {
    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["knowledge", "stats"]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("Knowledge Base Statistics");
    expect(allOutput).toContain("Shared KB entries:   0");
  });

  it("counts shared KB entries correctly", async () => {
    const entries = [
      makeSharedKnowledgeEntry({ tags: ["typescript", "language"], confidence: 0.9 }),
      makeSharedKnowledgeEntry({ tags: ["typescript", "performance"], confidence: 0.8 }),
      makeSharedKnowledgeEntry({ tags: ["nodejs"], confidence: 0.7 }),
    ];
    await writeSharedKnowledge(tmpDir, entries);

    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["knowledge", "stats"]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("Shared KB entries:   3");
    expect(allOutput).toContain("typescript");
  });
});

// ─── Tests: unknown knowledge subcommand ────────────────────────────────────

describe("CLIRunner — pulseed knowledge (error cases)", () => {
  it("returns error when no subcommand is given", async () => {
    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["knowledge"]);

    expect(exitCode).toBe(1);
    const errOutput = consoleErrors.join("\n");
    expect(errOutput).toContain("subcommand required");
  });

  it("returns error for unknown knowledge subcommand", async () => {
    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["knowledge", "unknown-cmd"]);

    expect(exitCode).toBe(1);
    const errOutput = consoleErrors.join("\n");
    expect(errOutput).toContain("Unknown knowledge subcommand");
  });
});
