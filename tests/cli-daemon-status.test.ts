import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "./helpers/temp-dir.js";

// ─── cmdDaemonStatus tests ───

// We test the command by importing it and mocking paths.getPulseedDirPath
// so it points to a temp directory we control.

vi.mock("../src/utils/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/paths.js")>();
  return {
    ...actual,
    getPulseedDirPath: vi.fn(() => "/tmp/pulseed-test-placeholder"),
  };
});

import { getPulseedDirPath } from "../src/utils/paths.js";
import { cmdDaemonStatus } from "../src/cli/commands/daemon.js";

describe("cmdDaemonStatus", () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-status-test-");
    vi.mocked(getPulseedDirPath).mockReturnValue(tmpDir);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    cleanupTempDir(tmpDir);
  });

  it("prints 'No daemon state found' when state file does not exist", async () => {
    await cmdDaemonStatus([]);

    expect(consoleSpy).toHaveBeenCalledWith("No daemon state found");
  });

  it("shows stopped status when PID is not running", async () => {
    // Write a state file with a PID that is almost certainly not running
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 5,
      active_goals: ["goal-a", "goal-b"],
      status: "running",
      crash_count: 1,
      last_error: null,
    };
    fs.writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(state));

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("stopped (PID: 999999999)");
    expect(output).toContain("goal-a");
    expect(output).toContain("goal-b");
    expect(output).toContain("5 cycles completed");
    expect(output).toContain("1/3 retries used");
  });

  it("shows running status when PID is the current process", async () => {
    // Use our own PID — guaranteed to be running
    const state = {
      pid: process.pid,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      last_loop_at: new Date().toISOString(),
      loop_count: 10,
      active_goals: ["goal-x"],
      status: "running",
      crash_count: 0,
      last_error: null,
    };
    fs.writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(state));

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain(`running (PID: ${process.pid})`);
    expect(output).toContain("Uptime:");
    expect(output).toContain("10 cycles completed");
    expect(output).toContain("0/3 retries used");
  });

  it("shows last_error when present", async () => {
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "crashed",
      crash_count: 3,
      last_error: "something went wrong",
    };
    fs.writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(state));

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Last error:      something went wrong");
  });

  it("handles empty active_goals gracefully", async () => {
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    };
    fs.writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(state));

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Active goals:    (none)");
  });

  it("shows header and separator", async () => {
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    };
    fs.writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(state));

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("PulSeed Daemon Status");
    expect(output).toContain("\u2500".repeat(21));
  });

  it("shows config section with defaults when no config file", async () => {
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    };
    fs.writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(state));

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Config:");
    expect(output).toContain("5m (adaptive sleep: off)");
    expect(output).toContain("10 per cycle");
    expect(output).toContain("Proactive:     off");
    expect(output).toContain("enabled");
  });

  it("reads config file when present and shows its values", async () => {
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    };
    const config = {
      check_interval_ms: 120_000, // 2 min
      iterations_per_cycle: 5,
      proactive_mode: true,
      adaptive_sleep: { enabled: true },
      crash_recovery: { enabled: true, max_retries: 5 },
    };
    fs.writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(state));
    fs.writeFileSync(path.join(tmpDir, "daemon-config.json"), JSON.stringify(config));

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("2m (adaptive sleep: on)");
    expect(output).toContain("5 per cycle");
    expect(output).toContain("Proactive:     on");
    expect(output).toContain("0/5 retries used");
  });

  it("shows last cycle relative time when last_loop_at is present", async () => {
    const lastLoop = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // 3 minutes ago
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: lastLoop,
      loop_count: 7,
      active_goals: ["goal-z"],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    };
    fs.writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(state));

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Last cycle:");
    expect(output).toMatch(/\d+m ago/);
  });

  it("shows 'Last error: none' when no error", async () => {
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    };
    fs.writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(state));

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Last error:      none");
  });
});
