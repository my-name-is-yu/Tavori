/**
 * CLIRunner — capability subcommand tests
 *
 * Verifies that `pulseed capability list` and `pulseed capability remove` work
 * correctly against the capability registry stored in StateManager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";

// ─── Module mocks (must precede imports of mocked modules) ───────────────────

vi.mock("../src/loop/core-loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/loop/core-loop.js")>();
  return { ...actual, CoreLoop: vi.fn() };
});

vi.mock("../src/goal/goal-negotiator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/goal/goal-negotiator.js")>();
  return { ...actual, GoalNegotiator: vi.fn() };
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

import { CLIRunner } from "../src/cli/cli-runner.js";
import { StateManager } from "../src/state/state-manager.js";
import type { Capability } from "../src/types/capability.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function makeCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    id: "test_capability",
    name: "test_capability",
    description: "A test capability",
    type: "tool",
    status: "available",
    ...overrides,
  };
}

async function writeRegistry(baseDir: string, capabilities: Capability[]): Promise<void> {
  const registry = {
    capabilities,
    last_checked: new Date().toISOString(),
  };
  const sm = new StateManager(baseDir);
  await sm.writeRaw("capability_registry.json", registry);
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CLIRunner — pulseed capability list", () => {
  it("shows registered capabilities", async () => {
    const cap = makeCapability({
      id: "git_tool",
      name: "git_tool",
      description: "Git CLI access",
      type: "tool",
      status: "available",
    });
    await writeRegistry(tmpDir, [cap]);

    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["capability", "list"]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("git_tool");
    expect(allOutput).toContain("tool");
    expect(allOutput).toContain("available");
  });

  it("shows an appropriate message when no capabilities are registered", async () => {
    await writeRegistry(tmpDir, []);

    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["capability", "list"]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("No capabilities registered");
  });

  it("lists multiple capabilities", async () => {
    const caps = [
      makeCapability({ id: "cap_a", name: "cap_a", type: "tool", status: "available" }),
      makeCapability({ id: "cap_b", name: "cap_b", type: "service", status: "missing" }),
    ];
    await writeRegistry(tmpDir, caps);

    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["capability", "list"]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("cap_a");
    expect(allOutput).toContain("cap_b");
    expect(allOutput).toContain("2 capability");
  });
});

describe("CLIRunner — pulseed capability remove", () => {
  it("removes a capability by id", async () => {
    const cap = makeCapability({
      id: "removable_cap",
      name: "removable_cap",
      type: "tool",
      status: "available",
    });
    await writeRegistry(tmpDir, [cap]);

    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["capability", "remove", "removable_cap"]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("removable_cap");
    expect(allOutput).toContain("removed");

    // Verify the capability is actually gone from the registry
    const sm = new StateManager(tmpDir);
    const raw = await sm.readRaw("capability_registry.json") as { capabilities: Capability[] } | null;
    expect(raw).not.toBeNull();
    const remaining = raw!.capabilities.filter((c) => c.id === "removable_cap");
    expect(remaining).toHaveLength(0);
  });

  it("returns error when name argument is missing", async () => {
    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["capability", "remove"]);

    expect(exitCode).toBe(1);
  });

  it("returns error when unknown capability subcommand is given", async () => {
    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["capability", "unknown"]);

    expect(exitCode).toBe(1);
  });
});
