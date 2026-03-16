/**
 * CLIRunner — capability subcommand tests
 *
 * Verifies that `motiva capability list` and `motiva capability remove` work
 * correctly against the capability registry stored in StateManager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Module mocks (must precede imports of mocked modules) ───────────────────

vi.mock("../src/core-loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core-loop.js")>();
  return { ...actual, CoreLoop: vi.fn() };
});

vi.mock("../src/goal-negotiator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/goal-negotiator.js")>();
  return { ...actual, GoalNegotiator: vi.fn() };
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

vi.mock("../src/provider-factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/provider-factory.js")>();
  return {
    ...actual,
    buildLLMClient: vi.fn().mockReturnValue({}),
    buildAdapterRegistry: vi.fn().mockReturnValue({
      register: vi.fn(),
      getAdapterCapabilities: vi.fn().mockReturnValue([]),
    }),
  };
});

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { CLIRunner } from "../src/cli-runner.js";
import { StateManager } from "../src/state-manager.js";
import type { Capability } from "../src/types/capability.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-capability-test-"));
}

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

function writeRegistry(baseDir: string, capabilities: Capability[]): void {
  const registry = {
    capabilities,
    last_checked: new Date().toISOString(),
  };
  const sm = new StateManager(baseDir);
  sm.writeRaw("capability_registry.json", registry);
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
  delete process.env.MOTIVA_LLM_PROVIDER;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CLIRunner — motiva capability list", () => {
  it("shows registered capabilities", async () => {
    const cap = makeCapability({
      id: "git_tool",
      name: "git_tool",
      description: "Git CLI access",
      type: "tool",
      status: "available",
    });
    writeRegistry(tmpDir, [cap]);

    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["capability", "list"]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("git_tool");
    expect(allOutput).toContain("tool");
    expect(allOutput).toContain("available");
  });

  it("shows an appropriate message when no capabilities are registered", async () => {
    writeRegistry(tmpDir, []);

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
    writeRegistry(tmpDir, caps);

    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["capability", "list"]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("cap_a");
    expect(allOutput).toContain("cap_b");
    expect(allOutput).toContain("2 capability");
  });
});

describe("CLIRunner — motiva capability remove", () => {
  it("removes a capability by id", async () => {
    const cap = makeCapability({
      id: "removable_cap",
      name: "removable_cap",
      type: "tool",
      status: "available",
    });
    writeRegistry(tmpDir, [cap]);

    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["capability", "remove", "removable_cap"]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("removable_cap");
    expect(allOutput).toContain("removed");

    // Verify the capability is actually gone from the registry
    const sm = new StateManager(tmpDir);
    const raw = sm.readRaw("capability_registry.json") as { capabilities: Capability[] } | null;
    expect(raw).not.toBeNull();
    const remaining = raw!.capabilities.filter((c) => c.id === "removable_cap");
    expect(remaining).toHaveLength(0);
  });

  it("returns error when name argument is missing", async () => {
    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["capability", "remove"]);

    expect(exitCode).toBe(1);
    const allErrors = consoleErrors.join("\n");
    expect(allErrors).toContain("name is required");
  });

  it("returns error when unknown capability subcommand is given", async () => {
    const runner = new CLIRunner(tmpDir);
    const exitCode = await runner.run(["capability", "unknown"]);

    expect(exitCode).toBe(1);
    const allErrors = consoleErrors.join("\n");
    expect(allErrors).toContain("Unknown capability subcommand");
  });
});
