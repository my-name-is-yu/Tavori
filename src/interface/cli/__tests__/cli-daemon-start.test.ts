import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const {
  buildDepsMock,
  daemonStartMock,
  watchdogStartMock,
  scheduleLoadEntriesMock,
  scheduleEnsureSoilPublishScheduleMock,
  pluginLoadAllMock,
  setRealtimeSinkMock,
  eventServerBroadcastMock,
  eventServerInstances,
  scheduleEngineArgs,
  daemonRunnerArgs,
  watchdogArgs,
  notificationDispatcherArgs,
  cliLoggerMock,
} = vi.hoisted(() => ({
  buildDepsMock: vi.fn(),
  daemonStartMock: vi.fn().mockResolvedValue(undefined),
  watchdogStartMock: vi.fn().mockResolvedValue(undefined),
  scheduleLoadEntriesMock: vi.fn().mockResolvedValue(undefined),
  scheduleEnsureSoilPublishScheduleMock: vi.fn().mockResolvedValue(null),
  pluginLoadAllMock: vi.fn().mockResolvedValue(undefined),
  setRealtimeSinkMock: vi.fn(),
  eventServerBroadcastMock: vi.fn(),
  eventServerInstances: [] as Array<{ broadcast: ReturnType<typeof vi.fn> }>,
  scheduleEngineArgs: [] as unknown[],
  daemonRunnerArgs: [] as unknown[],
  watchdogArgs: [] as unknown[],
  notificationDispatcherArgs: [] as unknown[],
  cliLoggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => "/tmp/pulseed-daemon-start-test-home"),
  };
});

vi.mock("../setup.js", () => ({
  buildDeps: buildDepsMock,
}));

vi.mock("../../../runtime/daemon/runner.js", () => ({
  DaemonRunner: vi.fn().mockImplementation(function (deps: unknown) {
    daemonRunnerArgs.push(deps);
    return {
      start: daemonStartMock,
    };
  }),
}));

vi.mock("../../../runtime/watchdog.js", () => ({
  RuntimeWatchdog: vi.fn().mockImplementation(function (args: unknown) {
    watchdogArgs.push(args);
    return {
      start: watchdogStartMock,
    };
  }),
}));

vi.mock("../../../runtime/pid-manager.js", () => ({
  PIDManager: vi.fn().mockImplementation(function () {
    return {
      isRunning: vi.fn().mockResolvedValue(false),
      readPID: vi.fn().mockResolvedValue(null),
    };
  }),
}));

vi.mock("../../../runtime/logger.js", () => ({
  Logger: vi.fn().mockImplementation(function () {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }),
}));

vi.mock("../cli-logger.js", () => ({
  getCliLogger: vi.fn(() => cliLoggerMock),
}));

vi.mock("../../../runtime/event/server.js", () => ({
  EventServer: vi.fn().mockImplementation(function () {
    const instance = {
      broadcast: eventServerBroadcastMock,
    };
    eventServerInstances.push(instance);
    return instance;
  }),
}));

vi.mock("../../../runtime/cron-scheduler.js", () => ({
  CronScheduler: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock("../../../runtime/schedule/engine.js", () => ({
  ScheduleEngine: vi.fn().mockImplementation(function (args: unknown) {
    scheduleEngineArgs.push(args);
    return {
      loadEntries: scheduleLoadEntriesMock,
      ensureSoilPublishSchedule: scheduleEnsureSoilPublishScheduleMock,
    };
  }),
}));

vi.mock("../../../runtime/plugin-loader.js", () => ({
  PluginLoader: vi.fn().mockImplementation(function () {
    return {
      loadAll: pluginLoadAllMock,
    };
  }),
}));

vi.mock("../../../runtime/notifier-registry.js", () => ({
  NotifierRegistry: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock("../../../runtime/notification-dispatcher.js", () => ({
  NotificationDispatcher: vi.fn().mockImplementation(function (...args: unknown[]) {
    notificationDispatcherArgs.push(args);
    return {
      setRealtimeSink: setRealtimeSinkMock,
    };
  }),
}));

vi.mock("../../../orchestrator/execution/adapter-layer.js", () => ({
  AdapterRegistry: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock("../../../platform/observation/data-source-adapter.js", () => ({
  DataSourceRegistry: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

import { cmdStart } from "../commands/daemon.js";

describe("cmdStart", () => {
  const mockedHome = "/tmp/pulseed-daemon-start-test-home";

  beforeEach(() => {
    buildDepsMock.mockReset();
    daemonStartMock.mockClear();
    watchdogStartMock.mockClear();
    scheduleLoadEntriesMock.mockClear();
    scheduleEnsureSoilPublishScheduleMock.mockClear();
    pluginLoadAllMock.mockClear();
    setRealtimeSinkMock.mockClear();
    eventServerBroadcastMock.mockClear();
    eventServerInstances.length = 0;
    scheduleEngineArgs.length = 0;
    daemonRunnerArgs.length = 0;
    watchdogArgs.length = 0;
    notificationDispatcherArgs.length = 0;
    cliLoggerMock.info.mockClear();
    cliLoggerMock.warn.mockClear();
    cliLoggerMock.error.mockClear();
    delete process.env.PULSEED_WATCHDOG_CHILD;
    fs.rmSync(mockedHome, { recursive: true, force: true });
    fs.rmSync("/tmp/pulseed-daemon-start-base", { recursive: true, force: true });

    buildDepsMock.mockResolvedValue({
      coreLoop: {},
      driveSystem: {},
      stateManager: { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") },
      llmClient: {},
      reportingEngine: { setNotificationDispatcher: vi.fn() },
      hookManager: { id: "hook-manager" },
      memoryLifecycleManager: { id: "memory" },
      knowledgeManager: { id: "knowledge" },
    });
  });

  afterEach(() => {
    fs.rmSync(mockedHome, { recursive: true, force: true });
    fs.rmSync("/tmp/pulseed-daemon-start-base", { recursive: true, force: true });
    delete process.env.PULSEED_WATCHDOG_CHILD;
  });

  it("wires EventServer realtime sink and full ScheduleEngine deps in the watchdog child process", async () => {
    process.env.PULSEED_WATCHDOG_CHILD = "1";
    fs.mkdirSync("/tmp/pulseed-daemon-start-base", { recursive: true });
    fs.writeFileSync(
      "/tmp/pulseed-daemon-start-base/notification.json",
      JSON.stringify({
        plugin_notifiers: {
          mode: "only",
          routes: [{ id: "discord-bot", enabled: true, report_types: ["weekly_report"] }],
        },
      }),
      "utf-8"
    );

    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
      {} as never,
      ["--goal", "goal-1"]
    );

    expect(setRealtimeSinkMock).toHaveBeenCalledOnce();
    expect(notificationDispatcherArgs[0]).toEqual([
      expect.objectContaining({
        plugin_notifiers: {
          mode: "only",
          routes: [{ id: "discord-bot", enabled: true, report_types: ["weekly_report"] }],
        },
      }),
      expect.any(Object),
    ]);
    const realtimeSink = setRealtimeSinkMock.mock.calls[0]?.[0] as ((report: unknown) => Promise<void>) | undefined;
    expect(realtimeSink).toBeTypeOf("function");

    await realtimeSink?.({ id: "report-1" });
    expect(eventServerBroadcastMock).toHaveBeenCalledWith("notification_report", { id: "report-1" });
    expect(buildDepsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      expect.any(Function),
      expect.objectContaining({
        info: expect.any(Function),
        warn: expect.any(Function),
        error: expect.any(Function),
      }),
      undefined,
      undefined,
    );

    expect(scheduleEngineArgs).toHaveLength(1);
    expect(scheduleEngineArgs[0]).toEqual(
      expect.objectContaining({
        reportingEngine: expect.any(Object),
        hookManager: { id: "hook-manager" },
        memoryLifecycle: { id: "memory" },
        knowledgeManager: { id: "knowledge" },
      })
    );

    expect(daemonRunnerArgs).toHaveLength(1);
    expect(daemonRunnerArgs[0]).toEqual(
      expect.objectContaining({
        eventServer: eventServerInstances[0],
        gateway: expect.any(Object),
        reportingEngine: expect.any(Object),
      })
    );
    expect(daemonStartMock).toHaveBeenCalledWith(["goal-1"]);
    expect(watchdogStartMock).not.toHaveBeenCalled();
  });

  it("passes explicit daemon workspace into buildDeps and DaemonRunner", async () => {
    process.env.PULSEED_WATCHDOG_CHILD = "1";

    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
      {} as never,
      ["--workspace", "/tmp/pulseed-workspace"]
    );

    expect(buildDepsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      expect.any(Function),
      expect.any(Object),
      undefined,
      "/tmp/pulseed-workspace",
    );
    expect(daemonRunnerArgs[0]).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({ workspace_path: "/tmp/pulseed-workspace" }),
      })
    );
  });

  it("launches RuntimeWatchdog on the top-level daemon start path", async () => {
    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
      {} as never,
      ["--goal", "goal-1"]
    );

    expect(watchdogStartMock).toHaveBeenCalledOnce();
    expect(watchdogArgs).toHaveLength(1);
    expect(daemonRunnerArgs).toHaveLength(0);
    expect(buildDepsMock).not.toHaveBeenCalled();
    expect(watchdogArgs[0]).toEqual(
      expect.objectContaining({
        healthProbe: expect.any(Function),
        startChild: expect.any(Function),
      })
    );
  });

  it("warns and falls back to defaults when ~/.pulseed/daemon.json is invalid", async () => {
    fs.mkdirSync(path.join(mockedHome, ".pulseed"), { recursive: true });
    fs.writeFileSync(path.join(mockedHome, ".pulseed", "daemon.json"), "{not-json", "utf-8");

    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
      {} as never,
      ["--goal", "goal-1"]
    );

    expect(cliLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring invalid daemon config at")
    );
    expect(watchdogStartMock).toHaveBeenCalledOnce();
  });

  it("allows idle watchdog startup with zero initial goals", async () => {
    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
      {} as never,
      []
    );

    expect(watchdogStartMock).toHaveBeenCalledOnce();
    expect(daemonStartMock).not.toHaveBeenCalled();
  });
});
