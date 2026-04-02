// ─── pulseed daemon commands (start, stop, cron, status) ───

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { readJsonFileOrNull } from "../../utils/json-io.js";
import { DaemonStateSchema, DaemonConfigSchema } from "../../types/daemon.js";
import type { DaemonState, DaemonConfig } from "../../types/daemon.js";

import { StateManager } from "../../state-manager.js";
import { CharacterConfigManager } from "../../traits/character-config.js";
import { Logger } from "../../runtime/logger.js";
import { DaemonRunner } from "../../runtime/daemon-runner.js";
import { PIDManager } from "../../runtime/pid-manager.js";
import { EventServer } from "../../runtime/event-server.js";
import { CronScheduler } from "../../runtime/cron-scheduler.js";
import { PluginLoader } from "../../runtime/plugin-loader.js";
import { NotifierRegistry } from "../../runtime/notifier-registry.js";
import { NotificationDispatcher } from "../../runtime/notification-dispatcher.js";
import { AdapterRegistry } from "../../execution/adapter-layer.js";
import { DataSourceRegistry } from "../../observation/data-source-adapter.js";
import { buildDeps } from "../setup.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import { getPulseedDirPath, getLogsDir } from "../../utils/paths.js";

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

  if (goalIds.length === 0) {
    getCliLogger().error("Error: at least one --goal is required for daemon mode");
    process.exit(1);
  }

  // --detach: spawn a detached child and exit immediately
  if (values.detach) {
    const scriptPath = process.argv[1]!;
    // Reconstruct args from parsed values (never include --detach)
    const childArgs = ["start"];
    for (const g of goalIds) childArgs.push("--goal", g);
    if (values["check-interval-ms"]) childArgs.push("--check-interval-ms", values["check-interval-ms"]);
    if (values["iterations-per-cycle"]) childArgs.push("--iterations-per-cycle", values["iterations-per-cycle"]);

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

  const baseDir = deps.stateManager.getBaseDir();
  const pidManager = new PIDManager(baseDir);
  const logger = new Logger({
    dir: getLogsDir(baseDir),
  });

  if (await pidManager.isRunning()) {
    const info = await pidManager.readPID();
    logger.error(`Daemon already running (PID: ${info?.pid})`);
    process.exit(1);
  }

  // Gap 2: Create EventServer for event-driven wake-ups (only if config specifies a port)
  let eventServer: EventServer | undefined;
  if (daemonConfig && typeof (daemonConfig as Record<string, unknown>).event_server_port === "number") {
    eventServer = new EventServer(
      deps.driveSystem,
      { port: (daemonConfig as Record<string, unknown>).event_server_port as number },
      logger
    );
  }

  // Gap 4: Create CronScheduler for scheduled tasks
  const cronScheduler = new CronScheduler(baseDir);

  const daemon = new DaemonRunner({
    coreLoop: deps.coreLoop,
    driveSystem: deps.driveSystem,
    stateManager: deps.stateManager,
    pidManager,
    logger,
    config: daemonConfig,
    ...(eventServer ? { eventServer } : {}),
    llmClient: deps.llmClient,
    cronScheduler,
  });

  logger.info(`Starting PulSeed daemon for goals: ${goalIds.join(", ")}`);
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

export async function cmdDaemonStatus(_args: string[]): Promise<void> {
  const baseDir = getPulseedDirPath();
  const statePath = path.join(baseDir, "daemon-state.json");

  const raw = await readJsonFileOrNull(statePath);
  if (raw === null) {
    console.log("No daemon state found");
    return;
  }
  const parsed = DaemonStateSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`Invalid daemon state: ${parsed.error.message}`);
    return;
  }
  const data: DaemonState = parsed.data;

  // Check if the PID is actually running
  let alive = false;
  try {
    process.kill(data.pid, 0);
    alive = true;
  } catch {
    alive = false;
  }

  // Load daemon config for config section display
  const configPath = path.join(baseDir, "daemon-config.json");
  const configRaw = await readJsonFileOrNull(configPath);
  const configParsed = configRaw !== null ? DaemonConfigSchema.safeParse(configRaw) : null;
  const cfg = configParsed?.success ? configParsed.data : DaemonConfigSchema.parse({});

  const status = alive ? "running" : "stopped";
  const lines: string[] = [
    "PulSeed Daemon Status",
    "\u2500".repeat(21),
    `Status:          ${status} (PID: ${data.pid})`,
  ];

  if (data.started_at) {
    if (alive) {
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
  lines.push(`  Crash recovery: ${crashEnabled} (${data.crash_count}/${maxRetries} retries used)`);

  lines.push("");
  lines.push(`Last error:      ${data.last_error ?? "none"}`);

  console.log(lines.join("\n"));
}

export async function cmdStop(_args: string[]): Promise<void> {
  const pidManager = new PIDManager(getPulseedDirPath());

  if (!(await pidManager.isRunning())) {
    console.log("No running daemon found");
    return;
  }

  const info = await pidManager.readPID();
  if (info) {
    console.log(`Stopping daemon (PID: ${info.pid})...`);
    try {
      process.kill(info.pid, "SIGTERM");
      console.log("Stop signal sent");
    } catch (err) {
      // ESRCH means the process no longer exists (died between isRunning check and kill)
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        await pidManager.cleanup();
        console.log("No running daemon found");
      } else {
        getCliLogger().error(formatOperationError(`stop daemon process ${info.pid}`, err));
        await pidManager.cleanup();
      }
    }
  }
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
