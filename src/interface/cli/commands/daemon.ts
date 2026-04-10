// ─── pulseed daemon commands (start, stop, cron, status) ───

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonFileOrNull } from "../../../base/utils/json-io.js";
import { DaemonStateSchema, DaemonConfigSchema } from "../../../base/types/daemon.js";
import type { DaemonState, DaemonConfig } from "../../../base/types/daemon.js";

import { StateManager } from "../../../base/state/state-manager.js";
import { CharacterConfigManager } from "../../../platform/traits/character-config.js";
import { Logger } from "../../../runtime/logger.js";
import { DaemonRunner } from "../../../runtime/daemon/runner.js";
import { PIDManager } from "../../../runtime/pid-manager.js";
import { EventServer } from "../../../runtime/event/server.js";
import { CronScheduler } from "../../../runtime/cron-scheduler.js";
import { ScheduleEngine } from "../../../runtime/schedule/engine.js";
import { RuntimeWatchdog } from "../../../runtime/watchdog.js";
import { LeaderLockManager } from "../../../runtime/leader-lock-manager.js";
import { RuntimeHealthStore } from "../../../runtime/store/index.js";
import { compactRuntimeHealthKpi, type RuntimeHealthKpi } from "../../../runtime/store/index.js";
import { PluginLoader } from "../../../runtime/plugin-loader.js";
import { NotifierRegistry } from "../../../runtime/notifier-registry.js";
import { NotificationDispatcher } from "../../../runtime/notification-dispatcher.js";
import { AdapterRegistry } from "../../../orchestrator/execution/adapter-layer.js";
import { DataSourceRegistry } from "../../../platform/observation/data-source-adapter.js";
import { getProviderRuntimeFingerprint } from "../../../base/llm/provider-config.js";
import { buildDeps } from "../setup.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import { getPulseedDirPath, getLogsDir } from "../../../base/utils/paths.js";
import { summarizeTaskOutcomeLedgers } from "../../../orchestrator/execution/task/task-outcome-ledger.js";

const WATCHDOG_CHILD_ENV = "PULSEED_WATCHDOG_CHILD";

function resolveDaemonRuntimeRoot(baseDir: string, configuredRoot?: string): string {
  if (!configuredRoot || configuredRoot.trim() === "") {
    return path.join(baseDir, "runtime");
  }
  return path.isAbsolute(configuredRoot)
    ? configuredRoot
    : path.resolve(baseDir, configuredRoot);
}

function formatGoalMode(goalIds: string[]): string {
  return goalIds.length > 0 ? goalIds.join(", ") : "(idle mode)";
}

export async function cmdStart(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  args: string[]
): Promise<void> {
  let values: { "api-key"?: string; config?: string; goal?: string[]; detach?: boolean; "check-interval-ms"?: string; "iterations-per-cycle"?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        "api-key": { type: "string" },
        config: { type: "string" },
        goal: { type: "string", multiple: true },
        detach: { type: "boolean", short: "d" },
        "check-interval-ms": { type: "string" },
        "iterations-per-cycle": { type: "string" },
      },
      strict: false,
    }) as { values: { "api-key"?: string; config?: string; goal?: string[]; detach?: boolean; "check-interval-ms"?: string; "iterations-per-cycle"?: string } });
  } catch (err) {
    getCliLogger().error(formatOperationError("parse start command arguments", err));
    values = {};
  }

  const goalIds = (values.goal as string[]) || [];

  // Gap 1: Load DaemonConfig from --config path (if provided)
  let daemonConfig: Partial<DaemonConfig> | undefined;
  if (values.config) {
    try {
      const raw = await readJsonFileOrNull(values.config);
      if (raw !== null) {
        daemonConfig = DaemonConfigSchema.parse(raw);
      } else {
        getCliLogger().error(`Config file not found: ${values.config}`);
        process.exit(1);
      }
    } catch (err) {
      getCliLogger().error(formatOperationError(`parse daemon config from "${values.config}"`, err));
      process.exit(1);
    }
  }

  // Auto-load ~/.pulseed/daemon.json when no --config flag was provided
  if (!values.config) {
    const defaultDaemonConfigPath = path.join(os.homedir(), '.pulseed', 'daemon.json');
    if (fs.existsSync(defaultDaemonConfigPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(defaultDaemonConfigPath, 'utf-8'));
        daemonConfig = DaemonConfigSchema.parse(raw);
      } catch {
        // Ignore invalid daemon.json, use defaults
      }
    }
  }

  // Merge CLI flag overrides into daemonConfig
  if (values["check-interval-ms"]) {
    const parsed = parseInt(values["check-interval-ms"], 10);
    if (isNaN(parsed) || parsed <= 0) {
      getCliLogger().error("--check-interval-ms must be a positive integer");
      process.exit(1);
    }
    daemonConfig = daemonConfig ?? {};
    daemonConfig.check_interval_ms = parsed;
  }
  if (values["iterations-per-cycle"]) {
    const parsed = parseInt(values["iterations-per-cycle"], 10);
    if (isNaN(parsed) || parsed <= 0) {
      getCliLogger().error("--iterations-per-cycle must be a positive integer");
      process.exit(1);
    }
    daemonConfig = daemonConfig ?? {};
    daemonConfig.iterations_per_cycle = parsed;
  }

  const resolvedDaemonConfig = DaemonConfigSchema.parse(daemonConfig ?? {});
  const isWatchdogChild = process.env[WATCHDOG_CHILD_ENV] === "1";
  const shouldUseWatchdog = !isWatchdogChild;
  const baseDir = stateManager.getBaseDir();
  const pidManager = new PIDManager(baseDir);
  const logger = new Logger({
    dir: getLogsDir(baseDir),
  });

  // --detach: spawn a detached process and exit immediately.
  // The detached process becomes the watchdog parent.
  if (values.detach) {
    const scriptPath = process.argv[1]!;
    const childArgs = process.argv
      .slice(2)
      .filter((arg) => arg !== "--detach" && arg !== "-d");

    const child = spawn(process.execPath, [scriptPath, ...childArgs], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) => {
      console.error(`Failed to start daemon: ${err.message}`);
      process.exit(1);
    });
    child.unref();
    if (child.pid == null) {
      console.error("Failed to start daemon: no PID assigned");
      process.exit(1);
    }
    console.log(`Daemon started in background (PID: ${child.pid})`);
    process.exit(0);
  }

  if (!isWatchdogChild && await pidManager.isRunning()) {
    const info = await pidManager.readPID();
    logger.error(`Daemon already running (PID: ${info?.pid})`);
    process.exit(1);
  }

  if (shouldUseWatchdog) {
    const runtimeRoot = resolveDaemonRuntimeRoot(baseDir, resolvedDaemonConfig.runtime_root);
    const healthStore = new RuntimeHealthStore(runtimeRoot);
    const leaderLockManager = new LeaderLockManager(runtimeRoot);
    const scriptPath = process.argv[1]!;
    const childArgs = process.argv.slice(2);
    const watchdog = new RuntimeWatchdog({
      pidManager,
      healthStore,
      leaderLockManager,
      logger,
      startChild: () =>
        spawn(process.execPath, [scriptPath, ...childArgs], {
          stdio: "inherit",
          env: {
            ...process.env,
            [WATCHDOG_CHILD_ENV]: "1",
          },
        }),
    });

    const shutdown = (): void => watchdog.stop();
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    try {
      logger.info(`Starting runtime watchdog for goals: ${formatGoalMode(goalIds)}`);
      await watchdog.start();
    } finally {
      process.removeListener("SIGTERM", shutdown);
      process.removeListener("SIGINT", shutdown);
    }
    return;
  }

  const deps = await buildDeps(stateManager, characterConfigManager);

  // Load notifier plugins and wire NotificationDispatcher
  const notifierRegistry = new NotifierRegistry();
  const pluginsDir = path.join(os.homedir(), ".pulseed", "plugins");
  const adapterRegistry = new AdapterRegistry();
  const dataSourceRegistry = new DataSourceRegistry();
  const pluginLoader = new PluginLoader(adapterRegistry, dataSourceRegistry, notifierRegistry, pluginsDir);
  try {
    await pluginLoader.loadAll();
  } catch (err) {
    getCliLogger().warn(`[daemon] Plugin loading failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
  const notificationDispatcher = new NotificationDispatcher(undefined, notifierRegistry);
  deps.reportingEngine.setNotificationDispatcher(notificationDispatcher);

  const daemonBaseDir = deps.stateManager.getBaseDir();

  // Create EventServer for event-driven wake-ups and SSE clients.
  const eventServer = new EventServer(
    deps.driveSystem,
    { port: resolvedDaemonConfig.event_server_port },
    logger
  );
  notificationDispatcher.setRealtimeSink(async (report) => {
    eventServer.broadcast("notification_report", report);
  });

  // Gap 4: Create CronScheduler for scheduled tasks
  const cronScheduler = new CronScheduler(daemonBaseDir);

  // Create ScheduleEngine with data source registry and LLM client
  const scheduleEngine = new ScheduleEngine({
    baseDir: daemonBaseDir,
    logger,
    dataSourceRegistry,
    llmClient: deps.llmClient,
    coreLoop: deps.coreLoop,
    stateManager: deps.stateManager,
    notificationDispatcher,
    reportingEngine: deps.reportingEngine,
    hookManager: deps.hookManager,
    memoryLifecycle: deps.memoryLifecycleManager,
    knowledgeManager: deps.knowledgeManager,
  });
  await scheduleEngine.loadEntries();

  const refreshResidentDeps = async () => {
    const freshDeps = await buildDeps(stateManager, characterConfigManager);
    freshDeps.reportingEngine.setNotificationDispatcher(notificationDispatcher);

    const freshScheduleEngine = new ScheduleEngine({
      baseDir: daemonBaseDir,
      logger,
      dataSourceRegistry,
      llmClient: freshDeps.llmClient,
      coreLoop: freshDeps.coreLoop,
      stateManager: freshDeps.stateManager,
      notificationDispatcher,
      reportingEngine: freshDeps.reportingEngine,
      hookManager: freshDeps.hookManager,
      memoryLifecycle: freshDeps.memoryLifecycleManager,
      knowledgeManager: freshDeps.knowledgeManager,
    });
    await freshScheduleEngine.loadEntries();

    return {
      coreLoop: freshDeps.coreLoop,
      curiosityEngine: freshDeps.curiosityEngine,
      goalNegotiator: freshDeps.goalNegotiator,
      llmClient: freshDeps.llmClient,
      reportingEngine: freshDeps.reportingEngine,
      scheduleEngine: freshScheduleEngine,
      memoryLifecycle: freshDeps.memoryLifecycleManager,
      knowledgeManager: freshDeps.knowledgeManager,
    };
  };

  const daemon = new DaemonRunner({
    coreLoop: deps.coreLoop,
    curiosityEngine: deps.curiosityEngine,
    goalNegotiator: deps.goalNegotiator,
    driveSystem: deps.driveSystem,
    stateManager: deps.stateManager,
    pidManager,
    logger,
    reportingEngine: deps.reportingEngine,
    config: resolvedDaemonConfig,
    eventServer,
    llmClient: deps.llmClient,
    cronScheduler,
    scheduleEngine,
    memoryLifecycle: deps.memoryLifecycleManager,
    knowledgeManager: deps.knowledgeManager,
    getProviderRuntimeFingerprint,
    refreshResidentDeps,
  });

  logger.info(`Starting PulSeed daemon for goals: ${formatGoalMode(goalIds)}`);
  await daemon.start(goalIds);
}

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

function formatRelativeTime(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

function formatRelativeTimestamp(timestamp: number): string {
  return formatRelativeTime(new Date(timestamp).toISOString());
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

type RuntimeHealthCapabilityKey = "process_alive" | "command_acceptance" | "task_execution";

function formatCapabilityLabel(
  label: string,
  kpi: RuntimeHealthKpi,
  key: RuntimeHealthCapabilityKey
): string {
  const capability = kpi[key];
  const reason = capability.reason ? `, ${capability.reason}` : "";
  return `${label.padEnd(16)} ${capability.status} (${formatRelativeTimestamp(capability.checked_at)}${reason})`;
}

function formatKpiCompactLine(kpi: RuntimeHealthKpi): string {
  const compact = compactRuntimeHealthKpi(kpi);
  if (!compact) {
    return "KPI snapshot:    unavailable";
  }
  return `KPI snapshot:    process=${compact.process_alive ? "up" : "down"} accept=${compact.can_accept_command ? "up" : "down"} execute=${compact.can_execute_task ? "up" : "down"} (${compact.status})`;
}

function isPidAlive(pidStatus: Awaited<ReturnType<PIDManager["inspect"]>>, pid?: number | null): boolean {
  return typeof pid === "number" && pidStatus.alivePids.includes(pid);
}

export async function cmdDaemonStatus(_args: string[]): Promise<void> {
  const baseDir = getPulseedDirPath();
  const statePath = path.join(baseDir, "daemon-state.json");
  const pidManager = new PIDManager(baseDir);
  const pidStatus = await pidManager.inspect();
  const runtimePid = pidStatus.runtimePid ?? pidStatus.info?.pid ?? null;
  const watchdogPid = pidStatus.info?.watchdog_pid ?? pidStatus.ownerPid ?? null;
  const runtimeAlive = isPidAlive(pidStatus, runtimePid);
  const watchdogAlive = isPidAlive(pidStatus, watchdogPid);

  const raw = await readJsonFileOrNull(statePath);
  if (raw === null) {
    if (!runtimeAlive && !watchdogAlive) {
      console.log("No daemon state found");
      return;
    }
    if (!runtimeAlive && watchdogAlive) {
      console.log(
        `Daemon watchdog is running, but runtime child is restarting (PID: ${runtimePid ?? "unknown"})`
      );
      return;
    }
    console.log("Daemon process is running, but daemon-state.json is missing");
    return;
  }
  const parsed = DaemonStateSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`Invalid daemon state: ${parsed.error.message}`);
    return;
  }
  const data: DaemonState = parsed.data;

  const resolvedRuntimePid = runtimePid ?? data.pid;
  const resolvedRuntimeAlive = isPidAlive(pidStatus, resolvedRuntimePid);

  // Load daemon config for config section display
  const configPath = path.join(baseDir, "daemon.json");
  const legacyConfigPath = path.join(baseDir, "daemon-config.json");
  const configRaw =
    (await readJsonFileOrNull(configPath)) ??
    (await readJsonFileOrNull(legacyConfigPath));
  const configParsed = configRaw !== null ? DaemonConfigSchema.safeParse(configRaw) : null;
  const cfg = configParsed?.success ? configParsed.data : DaemonConfigSchema.parse({});
  const runtimeRoot = resolveDaemonRuntimeRoot(baseDir, cfg.runtime_root);
  const runtimeHealth = await new RuntimeHealthStore(runtimeRoot).loadSnapshot();
  const taskKpis = await summarizeTaskOutcomeLedgers(baseDir);

  const status =
    !resolvedRuntimeAlive
      ? watchdogAlive
        ? "restarting"
        : data.status === "crashed"
          ? "crashed"
          : data.status === "stopping"
            ? "stopping"
            : "stopped"
      : data.status === "crashed" || data.status === "stopping"
        ? data.status
        : data.status === "idle"
          ? "idle"
          : "running";
  const lines: string[] = [
    "PulSeed Daemon Status",
    "\u2500".repeat(21),
    `Status:          ${status} (PID: ${resolvedRuntimePid})`,
  ];

  if (watchdogPid && watchdogPid !== resolvedRuntimePid) {
    lines.push(`Watchdog PID:    ${watchdogPid}${watchdogAlive ? "" : " (missing)"}`);
  }

  if (data.started_at) {
    if (resolvedRuntimeAlive) {
      lines.push(`Uptime:          ${formatUptime(data.started_at)}`);
    }
    lines.push(`Started:         ${data.started_at}`);
  }

  lines.push("");
  lines.push(`Loops:           ${data.loop_count} cycles completed`);

  if (data.last_loop_at) {
    lines.push(`Last cycle:      ${formatRelativeTime(data.last_loop_at)}`);
  }

  lines.push(`Active goals:    ${data.active_goals.join(", ") || "(none)"}`);
  if (data.resident_activity) {
    const residentAgo = formatRelativeTime(data.resident_activity.recorded_at);
    lines.push(`Resident:        ${data.resident_activity.kind} (${residentAgo})`);
    lines.push(`Resident note:   ${data.resident_activity.summary}`);
    if (data.resident_activity.goal_id) {
      lines.push(`Resident goal:   ${data.resident_activity.goal_id}`);
    }
  }

  if (runtimeHealth?.kpi) {
    lines.push("");
    lines.push("Runtime health:");
    lines.push(`  ${formatCapabilityLabel("Process alive:", runtimeHealth.kpi, "process_alive")}`);
    lines.push(`  ${formatCapabilityLabel("Accept command:", runtimeHealth.kpi, "command_acceptance")}`);
    lines.push(`  ${formatCapabilityLabel("Execute task:", runtimeHealth.kpi, "task_execution")}`);
    lines.push(`  ${formatKpiCompactLine(runtimeHealth.kpi)}`);
    if (runtimeHealth.kpi.degraded_at !== undefined) {
      lines.push(
        `  Degraded at:     ${new Date(runtimeHealth.kpi.degraded_at).toISOString()} (${formatRelativeTimestamp(runtimeHealth.kpi.degraded_at)})`
      );
    }
    if (runtimeHealth.kpi.recovered_at !== undefined) {
      lines.push(
        `  Recovered at:    ${new Date(runtimeHealth.kpi.recovered_at).toISOString()} (${formatRelativeTimestamp(runtimeHealth.kpi.recovered_at)})`
      );
    }
  }

  if (taskKpis.total_tasks > 0) {
    lines.push("");
    lines.push("Task KPIs:");
    lines.push(
      `  Success rate:    ${taskKpis.succeeded}/${taskKpis.terminal_tasks} (${formatPercent(taskKpis.success_rate)})`
    );
    lines.push(
      `  Retry rate:      ${taskKpis.retried}/${taskKpis.total_tasks} (${formatPercent(taskKpis.retry_rate)})`
    );
    lines.push(
      `  Abandoned rate:  ${taskKpis.abandoned}/${taskKpis.terminal_tasks} (${formatPercent(taskKpis.abandoned_rate)})`
    );
    if (taskKpis.p95_created_to_acked_ms !== null) {
      lines.push(`  Ack latency:     p95 ${formatDurationMs(taskKpis.p95_created_to_acked_ms)}`);
    }
    if (taskKpis.p95_started_to_completed_ms !== null) {
      lines.push(`  Run latency:     p95 ${formatDurationMs(taskKpis.p95_started_to_completed_ms)}`);
    }
    if (taskKpis.p95_created_to_completed_ms !== null) {
      lines.push(`  Total latency:   p95 ${formatDurationMs(taskKpis.p95_created_to_completed_ms)}`);
    }
  }

  // Config section
  const intervalMin = Math.round(cfg.check_interval_ms / 60000);
  const adaptiveSleep = cfg.adaptive_sleep.enabled ? "on" : "off";
  const proactive = cfg.proactive_mode ? "on" : "off";
  const crashEnabled = cfg.crash_recovery.enabled ? "enabled" : "disabled";
  const maxRetries = cfg.crash_recovery.max_retries;

  lines.push("");
  lines.push("Config:");
  lines.push(`  Interval:      ${intervalMin}m (adaptive sleep: ${adaptiveSleep})`);
  lines.push(`  Iterations:    ${cfg.iterations_per_cycle} per cycle`);
  lines.push(`  Proactive:     ${proactive}`);
  lines.push("  Runtime:       durable auto-recovery");
  if (cfg.runtime_root) {
    lines.push(`  Runtime root:  ${cfg.runtime_root}`);
  }
  lines.push(`  Crash recovery: ${crashEnabled} (${data.crash_count}/${maxRetries} retries used)`);

  lines.push("");
  lines.push(`Last error:      ${data.last_error ?? "none"}`);

  console.log(lines.join("\n"));
}

export async function cmdStop(_args: string[]): Promise<void> {
  const pidManager = new PIDManager(getPulseedDirPath());
  const stopResult = await pidManager.stopRuntime();
  if (!stopResult.info || stopResult.sentSignalsTo.length === 0) {
    console.log("No running daemon found");
    return;
  }
  const displayPid = stopResult.runtimePid ?? stopResult.ownerPid ?? stopResult.info.pid;
  console.log(`Stopping daemon (PID: ${displayPid})...`);
  if (!stopResult.stopped) {
    console.log(`Daemon still running (PIDs: ${stopResult.alivePids.join(", ")})`);
    return;
  }
  if (stopResult.forced) {
    console.log("Daemon stopped after forcing remaining runtime processes");
    return;
  }
  console.log("Daemon stopped");
}

export async function cmdCron(args: string[]): Promise<void> {
  let values: { goal?: string[]; interval?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        goal: { type: "string", multiple: true },
        interval: { type: "string", default: "60" },
      },
      strict: false,
    }) as { values: { goal?: string[]; interval?: string } });
  } catch (err) {
    getCliLogger().error(formatOperationError("parse cron command arguments", err));
    values = {};
  }

  const goalIds = (values.goal as string[]) || [];
  const intervalMinutes = parseInt(values.interval as string, 10) || 60;

  if (goalIds.length === 0) {
    getCliLogger().error("Error: at least one --goal is required");
    process.exit(1);
  }

  console.log("# PulSeed crontab entries");
  console.log("# Add these to your crontab with: crontab -e");
  for (const goalId of goalIds) {
    console.log(DaemonRunner.generateCronEntry(goalId, intervalMinutes));
  }
}
