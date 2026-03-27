#!/usr/bin/env node
// ─── CLIRunner ───
//
// SeedPulse CLI entry point. Wires all dependencies and exposes subcommands:
//   seedpulse run --goal <id>            Run CoreLoop once for a given goal
//   seedpulse goal add "<description>"   Negotiate and register a new goal (interactive)
//   seedpulse goal list                  List all registered goals
//   seedpulse goal archive <id>          Archive a completed goal
//   seedpulse goal show <id>             Show goal details
//   seedpulse goal reset <id>            Reset goal state for re-running
//   seedpulse status --goal <id>         Show current progress report
//   seedpulse report --goal <id>         Show latest report
//   seedpulse log --goal <id>            View execution/observation log
//   seedpulse start --goal <id>          Start daemon mode for one or more goals
//   seedpulse stop                       Stop the running daemon
//   seedpulse cron --goal <id>           Print crontab entry for a goal
//   seedpulse cleanup                    Archive all completed goals and remove stale data
//   seedpulse improve [path]             Analyze, suggest goals, and run improvement loop
//   seedpulse suggest "<context>"        Suggest improvement goals for a project
//   seedpulse capability list            List all registered capabilities
//   seedpulse capability remove <name>   Remove a capability by name
//   seedpulse knowledge list             List all shared knowledge entries
//   seedpulse knowledge search <query>   Search knowledge entries by keyword
//   seedpulse knowledge stats            Show knowledge base statistics

import { parseArgs } from "node:util";

import { getCliLogger } from "./cli/cli-logger.js";
import { StateManager } from "./state-manager.js";
import { CharacterConfigManager } from "./traits/character-config.js";
import type { CoreLoop } from "./core-loop.js";
import type { LoopConfig } from "./core-loop.js";

// Commands
import { cmdRun } from "./cli/commands/run.js";
import { cmdStatus, cmdLog, cmdCleanup } from "./cli/commands/goal.js";
import { dispatchGoalCommand } from "./cli/commands/goal-dispatch.js";
import { cmdPluginList, cmdPluginInstall, cmdPluginRemove, cmdPluginUpdate, cmdPluginSearch } from "./cli/commands/plugin.js";
import { cmdReport } from "./cli/commands/report.js";
import {
  cmdProvider,
  cmdConfigCharacter,
  cmdDatasourceAdd,
  cmdDatasourceList,
  cmdDatasourceRemove,
  cmdDatasourceDedup,
  cmdCapabilityList,
  cmdCapabilityRemove,
} from "./cli/commands/config.js";
import { cmdStart, cmdStop, cmdCron } from "./cli/commands/daemon.js";
import { cmdSuggest, cmdImprove } from "./cli/commands/suggest.js";
import { cmdSetup } from "./cli/commands/setup.js";
import { cmdKnowledgeList, cmdKnowledgeSearch, cmdKnowledgeStats } from "./cli/commands/knowledge.js";
import { printUsage, formatOperationError } from "./cli/utils.js";
import { ensureProviderConfig } from "./cli/ensure-api-key.js";

const logger = getCliLogger();

// ─── CLIRunner ───

/**
 * @description Coordinates CLI argument parsing, dependency wiring, and subcommand execution for the SeedPulse command-line interface.
 */
export class CLIRunner {
  private readonly stateManager: StateManager;
  private readonly characterConfigManager: CharacterConfigManager;
  private activeCoreLoop: CoreLoop | null = null;

  /**
   * @description Creates a CLI runner with state and character configuration managers rooted at the optional base directory.
   * @param {string} [baseDir] Optional base directory for SeedPulse state storage.
   * @returns {void} Does not return a value.
   */
  constructor(baseDir?: string) {
    this.stateManager = new StateManager(baseDir);
    this.characterConfigManager = new CharacterConfigManager(this.stateManager);
  }

  /**
   * @description Initialises the state directory structure. Must be awaited before issuing any subcommands.
   * @returns {Promise<void>}
   */
  async init(): Promise<void> {
    await this.stateManager.init();
  }

  /**
   * @description Stops the active core loop if one is currently running. Safe to call before `run()` or when no loop is active.
   * @returns {void} Does not return a value.
   */
  stop(): void {
    if (this.activeCoreLoop) {
      this.activeCoreLoop.stop();
    }
  }

  // ─── Main dispatch ───

  /**
   * @description Parses CLI arguments, dispatches the matching SeedPulse subcommand, and returns the resulting exit code.
   * @param {string[]} argv Raw subcommand arguments, excluding the `node` executable and script path.
   * @returns {Promise<number>} A promise that resolves to `0` for success, `1` for errors, or `2` for stall escalation.
   */
  async run(argv: string[]): Promise<number> {
    await this.init();

    if (argv.length === 0) {
      await ensureProviderConfig();
      printUsage();
      return 1;
    }

    // Extract --yes / -y globally so it works regardless of position
    let globalYes = false;
    const filteredArgv: string[] = [];
    for (const arg of argv) {
      if (arg === "--yes" || arg === "-y") {
        globalYes = true;
      } else {
        filteredArgv.push(arg);
      }
    }
    argv = filteredArgv;

    const subcommand = argv[0];

    if (subcommand === "run") {
      let values: { goal?: string[]; "max-iterations"?: string; adapter?: string; tree?: boolean; yes?: boolean; verbose?: boolean };
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
          },
          strict: false,
        }) as { values: { goal?: string[]; "max-iterations"?: string; adapter?: string; tree?: boolean; yes?: boolean; verbose?: boolean } });
      } catch (err) {
        logger.error(formatOperationError("parse run command arguments", err));
        values = {};
      }

      const goalIds = values.goal ?? [];
      if (goalIds.length === 0) {
        logger.error("Error: --goal <id> is required for `seedpulse run`.");
        return 1;
      }
      if (goalIds.length > 1) {
        logger.error("Error: only one --goal is supported per `seedpulse run`. Run separately for each goal, or use --tree for tree traversal.");
        return 1;
      }
      const goalId = goalIds[0];

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

      const activeCoreLoopRef = { value: this.activeCoreLoop };
      const result = await cmdRun(
        this.stateManager,
        this.characterConfigManager,
        goalId,
        loopConfig,
        globalYes || values.yes,
        values.verbose,
        activeCoreLoopRef
      );
      this.activeCoreLoop = activeCoreLoopRef.value;
      return result;
    }

    if (subcommand === "goal") {
      return dispatchGoalCommand(
        argv[1],
        argv.slice(2),
        globalYes,
        this.stateManager,
        this.characterConfigManager,
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
        logger.error("Error: --goal <id> is required for `seedpulse status`.");
        return 1;
      }

      return cmdStatus(this.stateManager, goalId);
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
        logger.error("Error: goal ID is required. Usage: seedpulse report --goal <id>  or  seedpulse report <id>");
        return 1;
      }

      return cmdReport(this.stateManager, goalId);
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
        logger.error("Error: goal ID is required. Usage: seedpulse log --goal <id>  or  seedpulse log <id>");
        return 1;
      }

      return await cmdLog(this.stateManager, goalId);
    }

    if (subcommand === "start") {
      await cmdStart(this.stateManager, this.characterConfigManager, argv.slice(1));
      return 0;
    }

    if (subcommand === "stop") {
      await cmdStop(argv.slice(1));
      return 0;
    }

    if (subcommand === "cron") {
      await cmdCron(argv.slice(1));
      return 0;
    }

    if (subcommand === "datasource") {
      const dsSubcommand = argv[1];

      if (!dsSubcommand) {
        logger.error("Error: datasource subcommand required. Available: datasource add, datasource list, datasource remove, datasource dedup");
        return 1;
      }

      if (dsSubcommand === "add") {
        return await cmdDatasourceAdd(this.stateManager, argv.slice(2));
      }

      if (dsSubcommand === "list") {
        return cmdDatasourceList(this.stateManager);
      }

      if (dsSubcommand === "remove") {
        return cmdDatasourceRemove(this.stateManager, argv.slice(2));
      }

      if (dsSubcommand === "dedup") {
        return cmdDatasourceDedup(this.stateManager);
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
        return await cmdCapabilityList(this.stateManager);
      }

      if (capSubcommand === "remove") {
        return await cmdCapabilityRemove(this.stateManager, argv.slice(2));
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
      return cmdCleanup(this.stateManager);
    }

    if (subcommand === "provider") {
      return cmdProvider(argv.slice(1));
    }

    if (subcommand === "config") {
      const configSubcommand = argv[1];

      if (!configSubcommand) {
        logger.error("Error: config subcommand required. Available: config character");
        return 1;
      }

      if (configSubcommand === "character") {
        return cmdConfigCharacter(this.characterConfigManager, argv.slice(2));
      }

      logger.error(`Unknown config subcommand: "${configSubcommand}"`);
      logger.error("Available: config character");
      return 1;
    }

    if (subcommand === "suggest") {
      return await cmdSuggest(this.stateManager, this.characterConfigManager, argv.slice(1));
    }

    if (subcommand === "improve") {
      const improveArgs = globalYes ? [...argv.slice(1), "--yes"] : argv.slice(1);
      return await cmdImprove(this.stateManager, this.characterConfigManager, improveArgs);
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
        return await cmdKnowledgeList(this.stateManager);
      }

      if (knowledgeSubcommand === "search") {
        return await cmdKnowledgeSearch(this.stateManager, argv.slice(2));
      }

      if (knowledgeSubcommand === "stats") {
        return await cmdKnowledgeStats(this.stateManager);
      }

      logger.error(`Unknown knowledge subcommand: "${knowledgeSubcommand}"`);
      logger.error("Available: knowledge list, knowledge search, knowledge stats");
      return 1;
    }

    if (subcommand === "tui") {
      // Dynamically import to avoid bundling Ink into the CLI when not needed
      const { startTUI } = await import("./tui/entry.js");
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
}

// ─── Entry point (when run directly as a binary) ───

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const runner = new CLIRunner();
  try {
    const code = await runner.run(argv);
    process.exit(code);
  } catch (err) {
    logger.error(formatOperationError("execute CLI entry point", err));
    process.exit(1);
  }
}

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const isMain = (() => {
  if (typeof process === "undefined" || !process.argv[1]) return false;
  try {
    const thisFile = realpathSync(fileURLToPath(import.meta.url));
    const entryFile = realpathSync(process.argv[1]);
    return thisFile === entryFile;
  } catch (err) {
    logger.error(formatOperationError("resolve CLI entry point path", err));
    return false;
  }
})();

if (isMain) {
  main();
}
