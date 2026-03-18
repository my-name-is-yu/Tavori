// ─── motiva daemon commands (start, stop, cron) ───

import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { StateManager } from "../../state-manager.js";
import { CharacterConfigManager } from "../../traits/character-config.js";
import { Logger } from "../../runtime/logger.js";
import { DaemonRunner } from "../../runtime/daemon-runner.js";
import { PIDManager } from "../../runtime/pid-manager.js";
import { buildDeps } from "../setup.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";

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

  const apiKey = (values["api-key"] as string) || process.env.ANTHROPIC_API_KEY || "";
  const goalIds = (values.goal as string[]) || [];

  if (goalIds.length === 0) {
    getCliLogger().error("Error: at least one --goal is required for daemon mode");
    process.exit(1);
  }

  const deps = await buildDeps(stateManager, characterConfigManager, apiKey);

  const pidManager = new PIDManager(deps.stateManager.getBaseDir());
  const logger = new Logger({
    dir: path.join(deps.stateManager.getBaseDir(), "logs"),
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

  console.log(`Starting Motiva daemon for goals: ${goalIds.join(", ")}`);
  await daemon.start(goalIds);
}

export async function cmdStop(_args: string[]): Promise<void> {
  const baseDir = path.join(os.homedir(), ".motiva");
  const pidManager = new PIDManager(baseDir);

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
      getCliLogger().error(formatOperationError(`stop daemon process ${info.pid}`, err));
      await pidManager.cleanup();
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

  console.log("# Motiva crontab entries");
  console.log("# Add these to your crontab with: crontab -e");
  for (const goalId of goalIds) {
    console.log(DaemonRunner.generateCronEntry(goalId, intervalMinutes));
  }
}
