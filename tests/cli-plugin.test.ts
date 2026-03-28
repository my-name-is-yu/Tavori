/**
 * CLIRunner — plugin subcommand tests
 *
 * Verifies that `pulseed plugin list`, `pulseed plugin install`, and
 * `pulseed plugin remove` work correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as yaml from "js-yaml";

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

import { cmdPluginList, cmdPluginInstall, cmdPluginRemove, cmdPluginUpdate, cmdPluginSearch } from "../src/cli/commands/plugin.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ManifestOverrides {
  name?: string;
  version?: string;
  type?: string;
  capabilities?: string[];
  description?: string;
  permissions?: Record<string, boolean>;
}

function writePluginManifest(dir: string, overrides: ManifestOverrides = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    name: overrides.name ?? "test-plugin",
    version: overrides.version ?? "1.0.0",
    type: overrides.type ?? "notifier",
    capabilities: overrides.capabilities ?? ["notify"],
    description: overrides.description ?? "A test plugin",
    permissions: overrides.permissions ?? {},
  };
  fs.writeFileSync(path.join(dir, "plugin.yaml"), yaml.dump(manifest), "utf-8");
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

let tmpDir: string;
let pluginsDir: string;
let consoleLogs: string[];
let consoleErrors: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-plugin-test-"));
  pluginsDir = path.join(tmpDir, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
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
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ─── cmdPluginList ────────────────────────────────────────────────────────────

describe("cmdPluginList", () => {
  it("returns 0 and shows empty message when no plugins installed", async () => {
    const exitCode = await cmdPluginList(pluginsDir);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toMatch(/no plugins/i);
  });

  it("returns 0 and shows plugin name and version when plugins exist", async () => {
    writePluginManifest(path.join(pluginsDir, "my-notifier"), {
      name: "my-notifier",
      version: "2.3.1",
      type: "notifier",
      description: "Sends notifications",
    });

    const exitCode = await cmdPluginList(pluginsDir);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("my-notifier");
    expect(allOutput).toContain("2.3.1");
  });
});

// ─── cmdPluginInstall ─────────────────────────────────────────────────────────

describe("cmdPluginInstall", () => {
  it("returns 0 and creates plugin dir on successful install", async () => {
    const sourceDir = path.join(tmpDir, "source", "my-plugin");
    writePluginManifest(sourceDir, { name: "my-plugin", version: "1.0.0" });

    const exitCode = await cmdPluginInstall(pluginsDir, [sourceDir]);

    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(pluginsDir, "my-plugin"))).toBe(true);
  });

  it("returns 1 when plugin already exists and --force not given", async () => {
    const sourceDir = path.join(tmpDir, "source", "existing-plugin");
    writePluginManifest(sourceDir, { name: "existing-plugin" });
    // Pre-create the destination to simulate already-installed
    fs.mkdirSync(path.join(pluginsDir, "existing-plugin"), { recursive: true });

    const exitCode = await cmdPluginInstall(pluginsDir, [sourceDir]);

    expect(exitCode).toBe(1);
  });

  it("returns 0 and overwrites when plugin exists with --force", async () => {
    const sourceDir = path.join(tmpDir, "source", "existing-plugin");
    writePluginManifest(sourceDir, { name: "existing-plugin", version: "2.0.0" });
    fs.mkdirSync(path.join(pluginsDir, "existing-plugin"), { recursive: true });

    const exitCode = await cmdPluginInstall(pluginsDir, [sourceDir, "--force"]);

    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(pluginsDir, "existing-plugin"))).toBe(true);
  });

  it("returns 1 when source path has no valid manifest", async () => {
    const sourceDir = path.join(tmpDir, "source", "bad-plugin");
    fs.mkdirSync(sourceDir, { recursive: true });
    // No plugin.yaml written

    const exitCode = await cmdPluginInstall(pluginsDir, [sourceDir]);

    expect(exitCode).toBe(1);
  });

  it("returns 0 and shows shell warning when permissions.shell is true", async () => {
    const sourceDir = path.join(tmpDir, "source", "shell-plugin");
    writePluginManifest(sourceDir, {
      name: "shell-plugin",
      permissions: { shell: true },
    });

    const exitCode = await cmdPluginInstall(pluginsDir, [sourceDir]);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toMatch(/shell|warning/i);
  });

  it("returns 1 when source path argument is missing", async () => {
    const exitCode = await cmdPluginInstall(pluginsDir, []);

    expect(exitCode).toBe(1);
  });
});

// ─── cmdPluginRemove ──────────────────────────────────────────────────────────

describe("cmdPluginRemove", () => {
  it("returns 0 and deletes the plugin directory", async () => {
    const pluginDir = path.join(pluginsDir, "removable-plugin");
    writePluginManifest(pluginDir, { name: "removable-plugin" });

    const exitCode = await cmdPluginRemove(pluginsDir, ["removable-plugin"]);

    expect(exitCode).toBe(0);
    expect(fs.existsSync(pluginDir)).toBe(false);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("removable-plugin");
    expect(allOutput).toMatch(/removed/i);
  });

  it("returns 1 when plugin does not exist", async () => {
    const exitCode = await cmdPluginRemove(pluginsDir, ["nonexistent-plugin"]);

    expect(exitCode).toBe(1);
  });

  it("returns 1 when name argument is missing", async () => {
    const exitCode = await cmdPluginRemove(pluginsDir, []);

    expect(exitCode).toBe(1);
  });
});

// ─── Path detection helpers ────────────────────────────────────────────────────

describe("cmdPluginInstall — path detection", () => {
  it("treats absolute path as local install", async () => {
    const sourceDir = path.join(tmpDir, "source", "abs-plugin");
    writePluginManifest(sourceDir, { name: "abs-plugin", version: "1.0.0" });

    const exitCode = await cmdPluginInstall(pluginsDir, [sourceDir]);

    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(pluginsDir, "abs-plugin"))).toBe(true);
  });

  it("treats ./ relative path as local install", async () => {
    // Create a plugin dir and simulate the install errors (path does not exist)
    const exitCode = await cmdPluginInstall(pluginsDir, ["./nonexistent-plugin"]);

    // Should fail with "does not exist" for local path, not npm install
    expect(exitCode).toBe(1);
    const allOutput = [...consoleLogs, ...consoleErrors].join("\n");
    expect(allOutput).toMatch(/does not exist/i);
  });

  it("treats @scope/package as npm install", async () => {
    const mockExecFile = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    // npm install will succeed but manifest won't be found (no actual package installed)
    const exitCode = await cmdPluginInstall(pluginsDir, ["@pulseed-plugins/test"], undefined, mockExecFile as never);

    expect(mockExecFile).toHaveBeenCalledWith(
      "npm",
      expect.arrayContaining(["install", "--prefix", expect.any(String), "@pulseed-plugins/test"])
    );
    // fails at manifest read since nothing was actually installed
    expect(exitCode).toBe(1);
  });

  it("treats bare package name as npm install", async () => {
    const mockExecFile = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    const exitCode = await cmdPluginInstall(pluginsDir, ["my-pulseed-plugin"], undefined, mockExecFile as never);

    expect(mockExecFile).toHaveBeenCalledWith(
      "npm",
      expect.arrayContaining(["install", "--prefix", expect.any(String), "my-pulseed-plugin"])
    );
    expect(exitCode).toBe(1);
  });
});

describe("cmdPluginInstall — npm flow", () => {
  it("returns 1 when npm install fails", async () => {
    const mockExecFile = vi.fn().mockRejectedValue(new Error("npm install failed"));

    const exitCode = await cmdPluginInstall(pluginsDir, ["some-package"], undefined, mockExecFile as never);

    expect(exitCode).toBe(1);
    const allOutput = [...consoleLogs, ...consoleErrors].join("\n");
    expect(allOutput).toMatch(/npm install/i);
  });

  it("returns 1 when already installed without --force", async () => {
    // Pre-create the plugin dir to simulate already installed
    const pluginDir = path.join(pluginsDir, "some-package");
    fs.mkdirSync(pluginDir, { recursive: true });

    const mockExecFile = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const exitCode = await cmdPluginInstall(pluginsDir, ["some-package"], undefined, mockExecFile as never);

    expect(exitCode).toBe(1);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("installs successfully with manifest in node_modules", async () => {
    const mockExecFile = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      // Simulate npm install creating node_modules/<pkgname>/plugin.yaml
      const prefixIndex = args.indexOf("--prefix");
      if (prefixIndex !== -1) {
        const prefixDir = args[prefixIndex + 1];
        const pkgName = args[args.length - 1];
        const nodeModulesDir = path.join(prefixDir, "node_modules", pkgName);
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        writePluginManifest(nodeModulesDir, { name: "mock-npm-plugin", version: "1.2.3" });
      }
      return { stdout: "", stderr: "" };
    });

    const exitCode = await cmdPluginInstall(
      pluginsDir,
      ["mock-npm-plugin"],
      () => "0.1.0",
      mockExecFile as never
    );

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toMatch(/installed from npm/i);
    expect(allOutput).toContain("mock-npm-plugin");
  });

  it("returns 1 when plugin requires higher PulSeed version", async () => {
    const mockExecFile = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      const prefixIndex = args.indexOf("--prefix");
      if (prefixIndex !== -1) {
        const prefixDir = args[prefixIndex + 1];
        const pkgName = args[args.length - 1];
        const nodeModulesDir = path.join(prefixDir, "node_modules", pkgName);
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        const manifest = {
          name: "future-plugin",
          version: "1.0.0",
          type: "notifier",
          capabilities: ["notify"],
          description: "Requires future PulSeed",
          permissions: {},
          min_pulseed_version: "99.0.0",
        };
        fs.writeFileSync(path.join(nodeModulesDir, "plugin.yaml"), yaml.dump(manifest), "utf-8");
      }
      return { stdout: "", stderr: "" };
    });

    const exitCode = await cmdPluginInstall(
      pluginsDir,
      ["future-plugin"],
      () => "0.1.0",
      mockExecFile as never
    );

    expect(exitCode).toBe(1);
  });
});

// ─── cmdPluginUpdate ──────────────────────────────────────────────────────────

describe("cmdPluginUpdate", () => {
  it("returns 1 when name argument is missing", async () => {
    const exitCode = await cmdPluginUpdate(pluginsDir, []);
    expect(exitCode).toBe(1);
  });

  it("returns 1 when plugin directory does not exist", async () => {
    const exitCode = await cmdPluginUpdate(pluginsDir, ["nonexistent-plugin"]);
    expect(exitCode).toBe(1);
  });

  it("runs npm update --prefix <dir> and returns 0", async () => {
    const pluginDir = path.join(pluginsDir, "my-npm-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });

    let capturedArgs: string[] = [];
    const mockExecFile = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      capturedArgs = args;
      return { stdout: "", stderr: "" };
    });

    const exitCode = await cmdPluginUpdate(pluginsDir, ["my-npm-plugin"], mockExecFile as never);

    expect(exitCode).toBe(0);
    expect(mockExecFile).toHaveBeenCalledWith("npm", expect.arrayContaining(["update", "--prefix"]));
    expect(capturedArgs).toContain("--prefix");
    expect(capturedArgs).toContain(pluginDir);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("my-npm-plugin");
    expect(allOutput).toMatch(/updated/i);
  });

  it("returns 1 when npm update fails", async () => {
    const pluginDir = path.join(pluginsDir, "broken-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });

    const mockExecFile = vi.fn().mockRejectedValue(new Error("npm update failed"));

    const exitCode = await cmdPluginUpdate(pluginsDir, ["broken-plugin"], mockExecFile as never);

    expect(exitCode).toBe(1);
  });
});

// ─── cmdPluginSearch ──────────────────────────────────────────────────────────

describe("cmdPluginSearch", () => {
  it("returns 1 when keyword argument is missing", async () => {
    const exitCode = await cmdPluginSearch(pluginsDir, []);
    expect(exitCode).toBe(1);
  });

  it("runs npm search and displays results in table format", async () => {
    const mockResults = [
      { name: "@pulseed-plugins/slack", version: "1.0.0", description: "Slack notifications" },
      { name: "@pulseed-plugins/discord", version: "2.1.0", description: "Discord notifications" },
    ];
    const mockExecFile = vi.fn().mockResolvedValue({
      stdout: JSON.stringify(mockResults),
      stderr: "",
    });

    const exitCode = await cmdPluginSearch(pluginsDir, ["slack"], mockExecFile as never);

    expect(exitCode).toBe(0);
    expect(mockExecFile).toHaveBeenCalledWith("npm", ["search", "@pulseed-plugins/slack", "--json"]);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toContain("@pulseed-plugins/slack");
    expect(allOutput).toContain("@pulseed-plugins/discord");
    expect(allOutput).toContain("1.0.0");
  });

  it("returns 0 and shows no results message when search is empty", async () => {
    const mockExecFile = vi.fn().mockResolvedValue({ stdout: "[]", stderr: "" });

    const exitCode = await cmdPluginSearch(pluginsDir, ["unknown-keyword"], mockExecFile as never);

    expect(exitCode).toBe(0);
    const allOutput = consoleLogs.join("\n");
    expect(allOutput).toMatch(/no plugins found/i);
  });

  it("returns 1 when npm search fails", async () => {
    const mockExecFile = vi.fn().mockRejectedValue(new Error("network error"));

    const exitCode = await cmdPluginSearch(pluginsDir, ["test"], mockExecFile as never);

    expect(exitCode).toBe(1);
  });

  it("returns 1 when npm search returns invalid JSON", async () => {
    const mockExecFile = vi.fn().mockResolvedValue({ stdout: "not-json", stderr: "" });

    const exitCode = await cmdPluginSearch(pluginsDir, ["test"], mockExecFile as never);

    expect(exitCode).toBe(1);
  });
});
