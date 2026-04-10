import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";

// ─── cmdDaemonStatus tests ───

// We test the command by importing it and mocking paths.getPulseedDirPath
// so it points to a temp directory we control.

vi.mock("../../../base/utils/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../base/utils/paths.js")>();
  return {
    ...actual,
    getPulseedDirPath: vi.fn(() => "/tmp/pulseed-test-placeholder"),
  };
});

import { getPulseedDirPath } from "../../../base/utils/paths.js";
import { cmdDaemonStatus } from "../commands/daemon.js";
import { PIDManager } from "../../../runtime/pid-manager.js";

function mockPidInspectRunning(runtimePid: number, ownerPid = runtimePid) {
  return vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
    info: {
      pid: runtimePid,
      runtime_pid: runtimePid,
      owner_pid: ownerPid,
      watchdog_pid: ownerPid !== runtimePid ? ownerPid : undefined,
      started_at: new Date().toISOString(),
      runtime_started_at: new Date().toISOString(),
      owner_started_at: new Date().toISOString(),
      watchdog_started_at: ownerPid !== runtimePid ? new Date().toISOString() : undefined,
    },
    running: true,
    runtimePid,
    ownerPid,
    alivePids: ownerPid === runtimePid ? [runtimePid] : [runtimePid, ownerPid],
    stalePids: [],
    verifiedPids: ownerPid === runtimePid ? [runtimePid] : [runtimePid, ownerPid],
    unverifiedLegacyPids: [],
  });
}

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
    vi.restoreAllMocks();
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
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date().toISOString(),
      })
    );
    const inspectSpy = mockPidInspectRunning(process.pid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain(`running (PID: ${process.pid})`);
    expect(output).toContain("Uptime:");
    expect(output).toContain("10 cycles completed");
    expect(output).toContain("0/3 retries used");
  });

  it("prints runtime KPI status when health snapshot exists", async () => {
    const now = Date.now();
    fs.mkdirSync(path.join(tmpDir, "runtime", "health"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "tasks", "goal-kpi", "ledger"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "runtime", "health", "daemon.json"),
      JSON.stringify({
        status: "degraded",
        leader: true,
        checked_at: now,
        kpi: {
          process_alive: { status: "ok", checked_at: now, last_ok_at: now },
          command_acceptance: {
            status: "degraded",
            checked_at: now,
            last_degraded_at: now,
            reason: "gateway or queue health degraded",
          },
          task_execution: { status: "ok", checked_at: now, last_ok_at: now },
          degraded_at: now,
        },
        details: { pid: process.pid },
      })
    );
    fs.writeFileSync(
      path.join(tmpDir, "runtime", "health", "components.json"),
      JSON.stringify({
        checked_at: now,
        components: {
          gateway: "degraded",
          queue: "ok",
          leases: "ok",
          approval: "ok",
          outbox: "ok",
          supervisor: "ok",
        },
      })
    );
    fs.writeFileSync(
      path.join(tmpDir, "tasks", "goal-kpi", "ledger", "task-1.json"),
      JSON.stringify({
        task_id: "task-1",
        goal_id: "goal-kpi",
        events: [
          { type: "acked", ts: new Date(now - 5_000).toISOString() },
          { type: "started", ts: new Date(now - 4_000).toISOString() },
          { type: "succeeded", ts: new Date(now - 1_000).toISOString() },
        ],
        summary: {
          latest_event_type: "succeeded",
          latencies: {
            created_to_acked_ms: 1000,
            acked_to_started_ms: 200,
            started_to_completed_ms: 2500,
            completed_to_verification_ms: 150,
            created_to_completed_ms: 3700,
          },
        },
      })
    );
    fs.writeFileSync(
      path.join(tmpDir, "daemon-state.json"),
      JSON.stringify({
        pid: process.pid,
        started_at: new Date(now - 60_000).toISOString(),
        last_loop_at: new Date(now).toISOString(),
        loop_count: 2,
        active_goals: ["goal-kpi"],
        status: "running",
        crash_count: 0,
        last_error: null,
      })
    );
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date(now).toISOString(),
      })
    );
    const inspectSpy = mockPidInspectRunning(process.pid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Runtime health:");
    expect(output).toContain("Process alive:");
    expect(output).toContain("Accept command:");
    expect(output).toContain("Execute task:");
    expect(output).toContain("KPI snapshot:    process=up accept=down execute=up (degraded)");
    expect(output).toContain("Degraded at:");
    expect(output).toContain("Task KPIs:");
    expect(output).toContain("Success rate:    1/1 (100.0%)");
    expect(output).toContain("Ack latency:     p95 1.0s");
  });

  it("shows idle status and watchdog PID when the daemon is running without goals", async () => {
    const runtimePid = process.pid;
    const watchdogPid = 424242;
    const state = {
      pid: runtimePid,
      started_at: new Date(Date.now() - 30_000).toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "idle",
      crash_count: 0,
      last_error: null,
    };
    fs.writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(state));
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: runtimePid,
        runtime_pid: runtimePid,
        owner_pid: watchdogPid,
        watchdog_pid: watchdogPid,
        started_at: new Date().toISOString(),
      })
    );
    const inspectSpy = mockPidInspectRunning(runtimePid, watchdogPid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain(`idle (PID: ${runtimePid})`);
    expect(output).toContain(`Watchdog PID:    ${watchdogPid}`);
    expect(output).toContain("Active goals:    (none)");
  });

  it("shows restarting status when the watchdog is alive but the runtime child is dead", async () => {
    const runtimePid = 999999999;
    const watchdogPid = process.pid;
    const state = {
      pid: runtimePid,
      started_at: new Date(Date.now() - 30_000).toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "running",
      crash_count: 0,
      last_error: null,
    };
    fs.writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(state));
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: runtimePid,
        runtime_pid: runtimePid,
        owner_pid: watchdogPid,
        watchdog_pid: watchdogPid,
        started_at: new Date().toISOString(),
      })
    );
    const inspectSpy = vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
      info: {
        pid: runtimePid,
        runtime_pid: runtimePid,
        owner_pid: watchdogPid,
        watchdog_pid: watchdogPid,
        started_at: new Date().toISOString(),
        runtime_started_at: new Date().toISOString(),
        owner_started_at: new Date().toISOString(),
        watchdog_started_at: new Date().toISOString(),
      },
      running: true,
      runtimePid,
      ownerPid: watchdogPid,
      alivePids: [watchdogPid],
      stalePids: [runtimePid],
      verifiedPids: [watchdogPid],
      unverifiedLegacyPids: [],
    });

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain(`restarting (PID: ${runtimePid})`);
    expect(output).toContain(`Watchdog PID:    ${watchdogPid}`);
  });

  it("shows resident activity when the daemon has autonomous work history", async () => {
    const state = {
      pid: process.pid,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      last_loop_at: null,
      loop_count: 1,
      active_goals: ["resident-goal"],
      status: "running",
      crash_count: 0,
      last_error: null,
      last_resident_at: new Date(Date.now() - 5_000).toISOString(),
      resident_activity: {
        kind: "negotiation",
        trigger: "proactive_tick",
        summary: "Resident discovery negotiated a new goal: Add resident daemon coverage",
        recorded_at: new Date(Date.now() - 5_000).toISOString(),
        suggestion_title: "Add resident daemon coverage",
        goal_id: "resident-goal",
      },
    };
    fs.writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(state));
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date().toISOString(),
      })
    );
    const inspectSpy = mockPidInspectRunning(process.pid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Resident:        negotiation");
    expect(output).toContain("Resident note:   Resident discovery negotiated a new goal");
    expect(output).toContain("Resident goal:   resident-goal");
  });

  it("shows dream resident activity without requiring a goal id", async () => {
    const state = {
      pid: process.pid,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      last_loop_at: null,
      loop_count: 1,
      active_goals: [],
      status: "idle",
      crash_count: 0,
      last_error: null,
      last_resident_at: new Date(Date.now() - 5_000).toISOString(),
      resident_activity: {
        kind: "dream",
        trigger: "proactive_tick",
        summary: "Resident dream applied pending suggestion \"Dream resident schedule\" into schedule schedule-entry-1.",
        recorded_at: new Date(Date.now() - 5_000).toISOString(),
      },
    };
    fs.writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(state));
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date().toISOString(),
      })
    );
    const inspectSpy = mockPidInspectRunning(process.pid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Resident:        dream");
    expect(output).toContain("Resident note:   Resident dream applied pending suggestion");
    expect(output).not.toContain("Resident goal:");
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
    expect(output).toContain("Runtime:       durable auto-recovery");
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
      runtime_journal_v2: true,
      runtime_root: "/tmp/pulseed-runtime",
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
    expect(output).toContain("Runtime:       durable auto-recovery");
    expect(output).toContain("/tmp/pulseed-runtime");
    expect(output).toContain("0/5 retries used");
  });

  it("falls back to daemon.json when daemon-config.json is absent", async () => {
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
      check_interval_ms: 180_000,
      iterations_per_cycle: 3,
      runtime_journal_v2: true,
    };
    fs.writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(state));
    fs.writeFileSync(path.join(tmpDir, "daemon.json"), JSON.stringify(config));

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("3m (adaptive sleep: off)");
    expect(output).toContain("3 per cycle");
    expect(output).toContain("Runtime:       durable auto-recovery");
  });

  it("prefers daemon.json over daemon-config.json when both exist", async () => {
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
    fs.writeFileSync(
      path.join(tmpDir, "daemon.json"),
      JSON.stringify({ iterations_per_cycle: 7, runtime_journal_v2: true })
    );
    fs.writeFileSync(
      path.join(tmpDir, "daemon-config.json"),
      JSON.stringify({ iterations_per_cycle: 2, runtime_journal_v2: false })
    );

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("7 per cycle");
    expect(output).toContain("Runtime:       durable auto-recovery");
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
