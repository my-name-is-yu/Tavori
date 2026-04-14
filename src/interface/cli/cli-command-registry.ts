// ─── CLI Command Registry ───
//
// Standalone command dispatch for PulSeed CLI subcommands.
// Called by CLIRunner.run() after init and --yes flag extraction.

import { parseArgs } from "node:util";

import { getCliLogger } from "./cli-logger.js";
import { StateManager } from "../../base/state/state-manager.js";
import { CharacterConfigManager } from "../../platform/traits/character-config.js";
import type { CoreLoop } from "../../orchestrator/loop/core-loop.js";
import type { LoopConfig } from "../../orchestrator/loop/core-loop.js";

// Commands
import { cmdRun } from "./commands/run.js";
import { cmdStatus, cmdLog, cmdCleanup } from "./commands/goal.js";
import { dispatchGoalCommand } from "./commands/goal-dispatch.js";
import { cmdPluginList, cmdPluginInstall, cmdPluginRemove, cmdPluginUpdate, cmdPluginSearch } from "./commands/plugin.js";
import { cmdReport } from "./commands/report.js";
import { cmdApprovalList } from "./commands/approval.js";
import {
  cmdProvider,
  cmdConfigCharacter,
  cmdConfigShow,
  cmdConfigSet,
  cmdConfigGet,
  cmdDatasourceAdd,
  cmdDatasourceList,
  cmdDatasourceRemove,
  cmdDatasourceDedup,
  cmdCapabilityList,
  cmdCapabilityRemove,
} from "./commands/config.js";
import { cmdStart, cmdStop, cmdCron, cmdDaemonStatus, cmdDaemonPing } from "./commands/daemon.js";
import { cmdSuggest, cmdImprove } from "./commands/suggest.js";
import { cmdSetup } from "./commands/setup.js";
import { cmdKnowledgeList, cmdKnowledgeSearch, cmdKnowledgeStats } from "./commands/knowledge.js";
import { cmdTaskList, cmdTaskShow } from "./commands/task-read.js";
import { cmdChat } from "./commands/chat.js";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdLogs } from "./commands/logs.js";
import { cmdInstall, cmdUninstall } from "./commands/install.js";
import { cmdNotify } from "./commands/notify.js";
import { cmdTelegramSetup } from "./commands/telegram.js";
import { cmdSchedule } from "./commands/schedule.js";
import { printUsage, formatOperationError } from "./utils.js";
import { ensureProviderConfig } from "./ensure-api-key.js";

const logger = getCliLogger();

function formatGoalRequiredError(command: string, usage: string): string {
  return `Error: --goal <id> is required for pulseed ${command}.\nUsage: ${usage}`;
}

function formatMultiGoalError(command: string, usage: string): string {
  return `Error: only one --goal is supported per pulseed ${command}. Run separately for each goal, or use --tree for tree traversal.\nUsage: ${usage}`;
}

/**
 * @description Dispatches a PulSeed CLI subcommand and returns an exit code.
 * @param {string[]} argv Filtered arguments (--yes/-y already removed), first element is the subcommand.
 * @param {boolean} globalYes Whether --yes/-y was present globally.
 * @param {StateManager} stateManager Initialised state manager instance.
 * @param {CharacterConfigManager} characterConfigManager Character config manager instance.
 * @param {{ value: CoreLoop | null }} activeCoreLoopRef Mutable ref updated by cmdRun.
 * @returns {Promise<number>} Exit code: 0 for success, 1 for errors, 2 for stall escalation.
 */
export async function dispatchCommand(
  argv: string[],
  globalYes: boolean,
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  activeCoreLoopRef: { value: CoreLoop | null },
): Promise<number> {
  if (argv.length === 0) {
    await ensureProviderConfig({ requireInteractiveSetup: true });
    const { startTUI } = await import("../tui/entry.js");
    await startTUI();
    return 0;
  }

  const subcommand = argv[0];

  if (subcommand === "run") {
    let values: { goal?: string[]; "max-iterations"?: string; adapter?: string; tree?: boolean; yes?: boolean; verbose?: boolean; workspace?: string };
    try {
      ({ values } = parseArgs({
        args: argv.slice(1),
        options: {
          goal: { type: "string", multiple: true },
          "max-iterations": { type: "string" },
          adapter: { type: "string" },
          tree: { type: "boolean" },
          yes: { type: "boolean", short: "y" },
          verbose: { type: "boolean" },
          workspace: { type: "string" },
        },
        strict: false,
      }) as { values: { goal?: string[]; "max-iterations"?: string; adapter?: string; tree?: boolean; yes?: boolean; verbose?: boolean; workspace?: string } });
    } catch (err) {
      logger.error(formatOperationError("parse run command arguments", err));
      values = {};
    }

    const goalIds = values.goal ?? [];
    if (goalIds.length === 0) {
      logger.error(formatGoalRequiredError("run", "pulseed run --goal <id> [--max-iterations <n>] [--adapter <type>] [--tree] [--workspace <path>] [--yes]"));
      return 1;
    }
    if (goalIds.length > 1) {
      logger.error(formatMultiGoalError("run", "pulseed run --goal <id> [--max-iterations <n>] [--adapter <type>] [--tree] [--workspace <path>] [--yes]"));
      return 1;
    }
    const goalId = goalIds[0];

    // Add workspace_path constraint to goal if --workspace is provided
    let resolvedWorkspace = values.workspace;
    if (resolvedWorkspace) {
      const goal = await stateManager.loadGoal(goalId);
      if (goal) {
        const wpPrefix = "workspace_path:";
        const existingIdx = goal.constraints.findIndex((c) => c.startsWith(wpPrefix));
        if (existingIdx >= 0) {
          goal.constraints[existingIdx] = `${wpPrefix}${resolvedWorkspace}`;
        } else {
          goal.constraints.push(`${wpPrefix}${resolvedWorkspace}`);
        }
        await stateManager.saveGoal(goal);
      }
    } else {
      // No --workspace flag: auto-detect from cwd or use existing constraint
      const goal = await stateManager.loadGoal(goalId);
      if (goal) {
        const wpPrefix = "workspace_path:";
        const existing = goal.constraints.find((c) => c.startsWith(wpPrefix));
        if (existing) {
          resolvedWorkspace = existing.slice(wpPrefix.length);
        } else {
          // Auto-add workspace_path from cwd so observation can read real files
          goal.constraints.push(`${wpPrefix}${process.cwd()}`);
          await stateManager.saveGoal(goal);
          resolvedWorkspace = process.cwd();
        }
      }
    }

    const loopConfig: LoopConfig = {};
    if (values["max-iterations"] !== undefined) {
      const parsed = parseInt(values["max-iterations"], 10);
      if (!isNaN(parsed)) {
        loopConfig.maxIterations = parsed;
      }
    }
    if (values.adapter !== undefined) {
      loopConfig.adapterType = values.adapter;
    }
    if (values.tree) {
      loopConfig.treeMode = true;
    }

    const result = await cmdRun(
      stateManager,
      characterConfigManager,
      goalId,
      loopConfig,
      globalYes || values.yes,
      values.verbose,
      activeCoreLoopRef,
      resolvedWorkspace,
    );
    return result;
  }

  if (subcommand === "goal") {
    return dispatchGoalCommand(
      argv[1],
      argv.slice(2),
      globalYes,
      stateManager,
      characterConfigManager,
    );
  }

  if (subcommand === "status") {
    let values: { goal?: string | undefined };
    try {
      ({ values } = parseArgs({
        args: argv.slice(1),
        options: {
          goal: { type: "string" },
        },
        strict: false,
      }) as { values: { goal?: string } });
    } catch (err) {
      logger.error(formatOperationError("parse status command arguments", err));
      values = {};
    }

    const goalId = values.goal;
    if (!goalId || typeof goalId !== "string") {
      logger.error(formatGoalRequiredError("status", "pulseed status --goal <id>"));
      return 1;
    }

    return cmdStatus(stateManager, goalId);
  }

  if (subcommand === "report") {
    let values: { goal?: string | undefined };
    let reportPositionals: string[] = [];
    try {
      const parsed = parseArgs({
        args: argv.slice(1),
        options: {
          goal: { type: "string" },
        },
        allowPositionals: true,
        strict: false,
      }) as { values: { goal?: string }; positionals: string[] };
      values = parsed.values;
      reportPositionals = parsed.positionals;
    } catch (err) {
      logger.error(formatOperationError("parse report command arguments", err));
      values = {};
    }

    const goalId = values.goal ?? reportPositionals[0];
    if (!goalId || typeof goalId !== "string") {
      logger.error("Error: goal ID is required. Usage: pulseed report --goal <id>  or  pulseed report <id>");
      return 1;
    }

    return cmdReport(stateManager, goalId);
  }

  if (subcommand === "approval") {
    const approvalSubcommand = argv[1];

    if (!approvalSubcommand) {
      logger.error("Error: approval subcommand required. Available: approval list");
      return 1;
    }

    if (approvalSubcommand === "list") {
      return await cmdApprovalList(stateManager, argv.slice(2));
    }

    logger.error(`Unknown approval subcommand: "${approvalSubcommand}"`);
    logger.error("Available: approval list");
    return 1;
  }

  if (subcommand === "log") {
    let values: { goal?: string | undefined };
    let logPositionals: string[] = [];
    try {
      const parsed = parseArgs({
        args: argv.slice(1),
        options: {
          goal: { type: "string" },
        },
        allowPositionals: true,
        strict: false,
      }) as { values: { goal?: string }; positionals: string[] };
      values = parsed.values;
      logPositionals = parsed.positionals;
    } catch (err) {
      logger.error(formatOperationError("parse log command arguments", err));
      values = {};
    }

    const goalId = values.goal ?? logPositionals[0];
    if (!goalId || typeof goalId !== "string") {
      logger.error("Error: goal ID is required. Usage: pulseed log --goal <id>  or  pulseed log <id>");
      return 1;
    }

    return await cmdLog(stateManager, goalId);
  }

  if (subcommand === "start") {
    await cmdStart(stateManager, characterConfigManager, argv.slice(1));
    return 0;
  }

  if (subcommand === "daemon") {
    const daemonSubcommand = argv[1];

    if (daemonSubcommand === "start") {
      await cmdStart(stateManager, characterConfigManager, argv.slice(2));
      return 0;
    }

    if (daemonSubcommand === "stop") {
      await cmdStop(argv.slice(2));
      return 0;
    }

    if (daemonSubcommand === "status") {
      await cmdDaemonStatus(argv.slice(2));
      return 0;
    }

    if (daemonSubcommand === "ping") {
      return await cmdDaemonPing(argv.slice(2));
    }

    if (daemonSubcommand === "cron") {
      await cmdCron(argv.slice(2));
      return 0;
    }

    logger.error(`Unknown daemon subcommand: "${daemonSubcommand ?? ""}"`);
    logger.error("Available: daemon start, daemon stop, daemon status, daemon ping, daemon cron");
    return 1;
  }

  if (subcommand === "stop") {
    await cmdStop(argv.slice(1));
    return 0;
  }

  if (subcommand === "cron") {
    await cmdCron(argv.slice(1));
    return 0;
  }

  if (subcommand === "schedule") {
    await cmdSchedule(stateManager, argv.slice(1));
    return 0;
  }

  if (subcommand === "datasource") {
    const dsSubcommand = argv[1];

    if (!dsSubcommand) {
      logger.error("Error: datasource subcommand required. Available: datasource add, datasource list, datasource remove, datasource dedup");
      return 1;
    }

    if (dsSubcommand === "add") {
      return await cmdDatasourceAdd(stateManager, argv.slice(2));
    }

    if (dsSubcommand === "list") {
      return cmdDatasourceList(stateManager);
    }

    if (dsSubcommand === "remove") {
      return cmdDatasourceRemove(stateManager, argv.slice(2));
    }

    if (dsSubcommand === "dedup") {
      return cmdDatasourceDedup(stateManager);
    }

    logger.error(`Unknown datasource subcommand: "${dsSubcommand}"`);
    logger.error("Available: datasource add, datasource list, datasource remove, datasource dedup");
    return 1;
  }

  if (subcommand === "capability") {
    const capSubcommand = argv[1];

    if (!capSubcommand) {
      logger.error("Error: capability subcommand required. Available: capability list, capability remove");
      return 1;
    }

    if (capSubcommand === "list") {
      return await cmdCapabilityList(stateManager);
    }

    if (capSubcommand === "remove") {
      return await cmdCapabilityRemove(stateManager, argv.slice(2));
    }

    logger.error(`Unknown capability subcommand: "${capSubcommand}"`);
    logger.error("Available: capability list, capability remove");
    return 1;
  }

  if (subcommand === "plugin") {
    const pluginSubcommand = argv[1];

    if (!pluginSubcommand) {
      logger.error("Error: plugin subcommand required. Available: plugin list, plugin install, plugin remove");
      return 1;
    }

    if (pluginSubcommand === "list") {
      return await cmdPluginList();
    }

    if (pluginSubcommand === "install") {
      return await cmdPluginInstall(undefined, argv.slice(2));
    }

    if (pluginSubcommand === "remove") {
      return await cmdPluginRemove(undefined, argv.slice(2));
    }

    if (pluginSubcommand === "update") {
      return await cmdPluginUpdate(undefined, argv.slice(2));
    }

    if (pluginSubcommand === "search") {
      return await cmdPluginSearch(undefined, argv.slice(2));
    }

    logger.error(`Unknown plugin subcommand: "${pluginSubcommand}"`);
    logger.error("Available: plugin list, plugin install, plugin remove, plugin update, plugin search");
    return 1;
  }

  if (subcommand === "cleanup") {
    return cmdCleanup(stateManager);
  }

  if (subcommand === "provider") {
    return cmdProvider(argv.slice(1));
  }

  if (subcommand === "config") {
    const configSubcommand = argv[1];

    if (!configSubcommand) {
      logger.error("Error: config subcommand required. Available: config show, config set, config get, config character");
      return 1;
    }

    if (configSubcommand === "show") {
      return cmdConfigShow();
    }

    if (configSubcommand === "set") {
      return cmdConfigSet(argv.slice(2));
    }

    if (configSubcommand === "get") {
      return cmdConfigGet(argv.slice(2));
    }

    if (configSubcommand === "character") {
      return cmdConfigCharacter(characterConfigManager, argv.slice(2));
    }

    logger.error(`Unknown config subcommand: "${configSubcommand}"`);
    logger.error("Available: config show, config set, config get, config character");
    return 1;
  }

  if (subcommand === "suggest") {
    return await cmdSuggest(stateManager, characterConfigManager, argv.slice(1));
  }

  if (subcommand === "improve") {
    const improveArgs = globalYes ? [...argv.slice(1), "--yes"] : argv.slice(1);
    return await cmdImprove(stateManager, characterConfigManager, improveArgs);
  }

  if (subcommand === "setup") {
    return await cmdSetup(argv.slice(1));
  }

  if (subcommand === "knowledge") {
    const knowledgeSubcommand = argv[1];

    if (!knowledgeSubcommand) {
      logger.error("Error: knowledge subcommand required. Available: knowledge list, knowledge search, knowledge stats");
      return 1;
    }

    if (knowledgeSubcommand === "list") {
      return await cmdKnowledgeList(stateManager);
    }

    if (knowledgeSubcommand === "search") {
      return await cmdKnowledgeSearch(stateManager, argv.slice(2));
    }

    if (knowledgeSubcommand === "stats") {
      return await cmdKnowledgeStats(stateManager);
    }

    logger.error(`Unknown knowledge subcommand: "${knowledgeSubcommand}"`);
    logger.error("Available: knowledge list, knowledge search, knowledge stats");
    return 1;
  }

  if (subcommand === "task") {
    const taskSubcommand = argv[1];

    if (!taskSubcommand) {
      logger.error("Error: task subcommand required. Available: task list, task show");
      return 1;
    }

    if (taskSubcommand === "list") {
      return await cmdTaskList(stateManager, argv.slice(2));
    }

    if (taskSubcommand === "show") {
      return await cmdTaskShow(stateManager, argv.slice(2));
    }

    logger.error(`Unknown task subcommand: "${taskSubcommand}"`);
    logger.error("Available: task list, task show");
    return 1;
  }

  if (subcommand === "mcp-server") {
    const { startMCPServer } = await import("../mcp-server/index.js");
    await startMCPServer({ stateManager, baseDir: stateManager.getBaseDir() });
    return 0;
  }

  if (subcommand === "doctor") {
    return await cmdDoctor(argv.slice(1));
  }

  if (subcommand === "logs") {
    return await cmdLogs(argv.slice(1));
  }

  if (subcommand === "install") {
    return await cmdInstall(argv.slice(1));
  }

  if (subcommand === "uninstall") {
    return await cmdUninstall(argv.slice(1));
  }

  if (subcommand === "notify") {
    return await cmdNotify(argv.slice(1));
  }

  if (subcommand === "chat") {
    return await cmdChat(stateManager, argv.slice(1));
  }

  if (subcommand === "telegram") {
    const telegramSubcommand = argv[1];

    if (telegramSubcommand === "setup") {
      return await cmdTelegramSetup(argv.slice(2));
    }

    logger.error(`Unknown telegram subcommand: "${telegramSubcommand ?? ""}"`);
    logger.error("Available: telegram setup");
    return 1;
  }

  if (subcommand === "tui") {
    // Dynamically import to avoid bundling Ink into the CLI when not needed
    const { startTUI } = await import("../tui/entry.js");
    await startTUI();
    return 0;
  }

  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    printUsage();
    return 0;
  }

  logger.error(`Unknown subcommand: "${subcommand}"`);
  printUsage();
  return 1;
}
