// ─── pulseed daemon commands (start, stop, cron) ───

import { parseArgs } from "node:util";

import { StateManager } from "../../state-manager.js";
import { CharacterConfigManager } from "../../traits/character-config.js";
import { Logger } from "../../runtime/logger.js";
import { DaemonRunner } from "../../runtime/daemon-runner.js";
import { PIDManager } from "../../runtime/pid-manager.js";
import { buildDeps } from "../setup.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import { getPulseedDirPath, getLogsDir } from "../../utils/paths.js";

export async function cmdStart(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  args: string[]
): Promise<void> {
  let values: { "api-key"?: string; config?: string; goal?: string[] };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        "api-key": { type: "string" },
        config: { type: "string" },
        goal: { type: "string", multiple: true },
      },
      strict: false,
    }) as { values: { "api-key"?: string; config?: string; goal?: string[] } });
  } catch (err) {
    getCliLogger().error(formatOperationError("parse start command arguments", err));
    values = {};
  }

  const goalIds = (values.goal as string[]) || [];

  if (goalIds.length === 0) {
    getCliLogger().error("Error: at least one --goal is required for daemon mode");
    process.exit(1);
  }

  const deps = await buildDeps(stateManager, characterConfigManager);

  const pidManager = new PIDManager(deps.stateManager.getBaseDir());
  const logger = new Logger({
    dir: getLogsDir(deps.stateManager.getBaseDir()),
  });

  if (await pidManager.isRunning()) {
    const info = await pidManager.readPID();
    logger.error(`Daemon already running (PID: ${info?.pid})`);
    process.exit(1);
  }

  const daemon = new DaemonRunner({
    coreLoop: deps.coreLoop,
    driveSystem: deps.driveSystem,
    stateManager: deps.stateManager,
    pidManager,
    logger,
  });

  logger.info(`Starting PulSeed daemon for goals: ${goalIds.join(", ")}`);
  await daemon.start(goalIds);
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
