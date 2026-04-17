import { beforeEach, describe, expect, it, vi } from "vitest";

const renderMock = vi.fn();
const destroyMock = vi.fn();
const setTrustedTuiControlStreamMock = vi.fn();

vi.mock("ink", () => ({
  render: renderMock,
}));

vi.mock("../debug-log.js", () => ({
  resetTuiDebugLog: vi.fn(),
  getTuiDebugLogPath: vi.fn(() => "/tmp/tui-debug.log"),
  logTuiDebug: vi.fn(),
}));

vi.mock("../flicker/index.js", () => ({
  AlternateScreen: ({ children }: { children?: unknown }) => children,
  MouseTracking: ({ children }: { children?: unknown }) => children,
  isNoFlickerEnabled: vi.fn(async () => true),
}));

vi.mock("../git-branch.js", () => ({
  getGitBranch: vi.fn(() => ""),
}));

vi.mock("../output-controller.js", () => ({
  createNoFlickerOutputController: vi.fn(() => ({
    install: vi.fn(),
    destroy: destroyMock,
    writeTerminal: vi.fn(),
    renderStdout: process.stdout,
    renderStderr: process.stderr,
    terminalStream: process.stdout,
  })),
}));

vi.mock("../terminal-output.js", () => ({
  setTrustedTuiControlStream: setTrustedTuiControlStreamMock,
}));

describe("startTUITest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.argv[1] = "/tmp/vitest-runner.js";
    renderMock.mockImplementation(() => {
      throw new Error("render failed");
    });
  });

  it("restores the no-flicker controller when setup fails before waitUntilExit", async () => {
    const { startTUITest } = await import("../test-entry.js");

    await expect(startTUITest()).rejects.toThrow("render failed");
    expect(destroyMock).toHaveBeenCalledTimes(1);
    expect(setTrustedTuiControlStreamMock).toHaveBeenLastCalledWith(null);
  });
});
