import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock fs and execFileNoThrow before importing the module under test ───

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

vi.mock("../src/utils/execFileNoThrow.js", () => ({
  execFileNoThrow: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
}));

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileNoThrow } from "../src/utils/execFileNoThrow.js";
import { buildPlist, cmdInstall, cmdUninstall } from "../src/cli/commands/install.js";

const PLIST_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  "com.pulseed.daemon.plist"
);

describe("buildPlist", () => {
  it("includes goal IDs in ProgramArguments", () => {
    const xml = buildPlist({
      nodePath: "/usr/local/bin/node",
      cliRunnerPath: "/app/dist/cli-runner.js",
      goalIds: ["goal-abc", "goal-xyz"],
      stdoutLog: "/home/.pulseed/logs/launchd-stdout.log",
      stderrLog: "/home/.pulseed/logs/launchd-stderr.log",
      workingDir: "/home/user",
    });

    expect(xml).toContain("<string>goal-abc</string>");
    expect(xml).toContain("<string>goal-xyz</string>");
    expect(xml).toContain("<string>--goal</string>");
  });

  it("includes the correct node path and cli-runner path", () => {
    const xml = buildPlist({
      nodePath: "/usr/local/bin/node",
      cliRunnerPath: "/app/dist/cli-runner.js",
      goalIds: ["g1"],
      stdoutLog: "/logs/out.log",
      stderrLog: "/logs/err.log",
      workingDir: "/home/user",
    });

    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>/app/dist/cli-runner.js</string>");
  });

  it("includes RunAtLoad and KeepAlive true", () => {
    const xml = buildPlist({
      nodePath: "/usr/local/bin/node",
      cliRunnerPath: "/app/dist/cli-runner.js",
      goalIds: ["g1"],
      stdoutLog: "/logs/out.log",
      stderrLog: "/logs/err.log",
      workingDir: "/home/user",
    });

    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("<key>KeepAlive</key>");
    // Both should be <true/>
    const trueCount = (xml.match(/<true\/>/g) ?? []).length;
    expect(trueCount).toBeGreaterThanOrEqual(2);
  });

  it("includes StandardOutPath and StandardErrorPath", () => {
    const xml = buildPlist({
      nodePath: "/usr/local/bin/node",
      cliRunnerPath: "/app/dist/cli-runner.js",
      goalIds: ["g1"],
      stdoutLog: "/home/.pulseed/logs/launchd-stdout.log",
      stderrLog: "/home/.pulseed/logs/launchd-stderr.log",
      workingDir: "/home/user",
    });

    expect(xml).toContain("<key>StandardOutPath</key>");
    expect(xml).toContain("<string>/home/.pulseed/logs/launchd-stdout.log</string>");
    expect(xml).toContain("<key>StandardErrorPath</key>");
    expect(xml).toContain("<string>/home/.pulseed/logs/launchd-stderr.log</string>");
  });

  it("includes WorkingDirectory", () => {
    const xml = buildPlist({
      nodePath: "/usr/local/bin/node",
      cliRunnerPath: "/app/dist/cli-runner.js",
      goalIds: ["g1"],
      stdoutLog: "/logs/out.log",
      stderrLog: "/logs/err.log",
      workingDir: "/home/user",
    });

    expect(xml).toContain("<key>WorkingDirectory</key>");
    expect(xml).toContain("<string>/home/user</string>");
  });

  it("includes EnvironmentVariables when PATH is provided", () => {
    const xml = buildPlist({
      nodePath: "/usr/local/bin/node",
      cliRunnerPath: "/app/dist/cli-runner.js",
      goalIds: ["g1"],
      stdoutLog: "/logs/out.log",
      stderrLog: "/logs/err.log",
      workingDir: "/home/user",
      envPath: "/usr/local/bin:/usr/bin",
    });

    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<key>PATH</key>");
    expect(xml).toContain("<string>/usr/local/bin:/usr/bin</string>");
  });

  it("includes PULSEED_HOME when provided", () => {
    const xml = buildPlist({
      nodePath: "/usr/local/bin/node",
      cliRunnerPath: "/app/dist/cli-runner.js",
      goalIds: ["g1"],
      stdoutLog: "/logs/out.log",
      stderrLog: "/logs/err.log",
      workingDir: "/home/user",
      pulseedHome: "/custom/.pulseed",
    });

    expect(xml).toContain("<key>PULSEED_HOME</key>");
    expect(xml).toContain("<string>/custom/.pulseed</string>");
  });

  it("omits EnvironmentVariables block when neither PATH nor PULSEED_HOME is given", () => {
    const xml = buildPlist({
      nodePath: "/usr/local/bin/node",
      cliRunnerPath: "/app/dist/cli-runner.js",
      goalIds: ["g1"],
      stdoutLog: "/logs/out.log",
      stderrLog: "/logs/err.log",
      workingDir: "/home/user",
    });

    expect(xml).not.toContain("<key>EnvironmentVariables</key>");
  });

  it("includes --config when configPath is provided", () => {
    const xml = buildPlist({
      nodePath: "/usr/local/bin/node",
      cliRunnerPath: "/app/dist/cli-runner.js",
      goalIds: ["g1"],
      configPath: "/home/user/.pulseed/config.json",
      stdoutLog: "/logs/out.log",
      stderrLog: "/logs/err.log",
      workingDir: "/home/user",
    });

    expect(xml).toContain("<string>--config</string>");
    expect(xml).toContain("<string>/home/user/.pulseed/config.json</string>");
  });

  it("includes --check-interval-ms when intervalMs is provided", () => {
    const xml = buildPlist({
      nodePath: "/usr/local/bin/node",
      cliRunnerPath: "/app/dist/cli-runner.js",
      goalIds: ["g1"],
      intervalMs: 5000,
      stdoutLog: "/logs/out.log",
      stderrLog: "/logs/err.log",
      workingDir: "/home/user",
    });

    expect(xml).toContain("<string>--check-interval-ms</string>");
    expect(xml).toContain("<string>5000</string>");
  });

  it("escapes special XML characters in paths", () => {
    const xml = buildPlist({
      nodePath: "/usr/local/bin/node",
      cliRunnerPath: "/app/dist/cli-runner.js",
      goalIds: ["g1"],
      stdoutLog: "/logs/out.log",
      stderrLog: "/logs/err.log",
      workingDir: "/home/user",
      envPath: "a&b<c>d",
    });

    expect(xml).toContain("a&amp;b&lt;c&gt;d");
  });

  it("contains valid XML plist header and root element", () => {
    const xml = buildPlist({
      nodePath: "/usr/local/bin/node",
      cliRunnerPath: "/app/dist/cli-runner.js",
      goalIds: ["g1"],
      stdoutLog: "/logs/out.log",
      stderrLog: "/logs/err.log",
      workingDir: "/home/user",
    });

    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain("<plist version=\"1.0\">");
    expect(xml).toContain("</plist>");
    expect(xml).toContain("<string>com.pulseed.daemon</string>");
  });
});

describe("cmdInstall", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(execFileNoThrow).mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Restore platform descriptor if it was changed
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("returns 1 and prints error on non-darwin platform", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await cmdInstall(["--goal", "g1"]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith("launchd is only supported on macOS");
    errSpy.mockRestore();
  });

  it("returns 1 when no --goal is provided", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await cmdInstall([]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith("Error: at least one --goal is required");
    errSpy.mockRestore();
  });

  it("writes the plist file and calls launchctl load on success", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await cmdInstall(["--goal", "goal-1", "--goal", "goal-2"]);

    expect(code).toBe(0);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      PLIST_PATH,
      expect.stringContaining("<string>goal-1</string>"),
      "utf8"
    );
    expect(execFileNoThrow).toHaveBeenCalledWith("launchctl", ["load", PLIST_PATH]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(PLIST_PATH));
    logSpy.mockRestore();
  });

  it("warns when plist already exists and overwrites", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await cmdInstall(["--goal", "g1"]);

    expect(code).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("already exists")
    );
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("returns 1 when launchctl load fails", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    vi.mocked(execFileNoThrow).mockResolvedValue({
      stdout: "",
      stderr: "bootstrap failed",
      exitCode: 1,
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await cmdInstall(["--goal", "g1"]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("bootstrap failed")
    );
    errSpy.mockRestore();
  });
});

describe("cmdUninstall", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
    vi.mocked(execFileNoThrow).mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("returns 1 and prints error on non-darwin platform", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await cmdUninstall([]);

    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith("launchd is only supported on macOS");
    errSpy.mockRestore();
  });

  it("returns 1 and prints 'Not installed' when plist does not exist", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await cmdUninstall([]);

    expect(code).toBe(1);
    expect(logSpy).toHaveBeenCalledWith("Not installed");
    logSpy.mockRestore();
  });

  it("calls launchctl unload, deletes plist, and returns 0 on success", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await cmdUninstall([]);

    expect(code).toBe(0);
    expect(execFileNoThrow).toHaveBeenCalledWith("launchctl", ["unload", PLIST_PATH]);
    expect(fs.unlinkSync).toHaveBeenCalledWith(PLIST_PATH);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("uninstalled")
    );
    logSpy.mockRestore();
  });

  it("still deletes plist and returns 0 even if launchctl unload fails", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    vi.mocked(execFileNoThrow).mockResolvedValue({
      stdout: "",
      stderr: "Could not find specified service",
      exitCode: 1,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await cmdUninstall([]);

    expect(code).toBe(0);
    expect(fs.unlinkSync).toHaveBeenCalledWith(PLIST_PATH);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Could not find"));
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });
});
