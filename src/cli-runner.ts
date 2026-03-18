#!/usr/bin/env node
// ─── CLIRunner ───
//
// Motiva CLI entry point. Wires all dependencies and exposes subcommands:
//   motiva run --goal <id>            Run CoreLoop once for a given goal
//   motiva goal add "<description>"   Negotiate and register a new goal (interactive)
//   motiva goal list                  List all registered goals
//   motiva goal archive <id>          Archive a completed goal
//   motiva goal show <id>             Show goal details
//   motiva goal reset <id>            Reset goal state for re-running
//   motiva status --goal <id>         Show current progress report
//   motiva report --goal <id>         Show latest report
//   motiva log --goal <id>            View execution/observation log
//   motiva start --goal <id>          Start daemon mode for one or more goals
//   motiva stop                       Stop the running daemon
//   motiva cron --goal <id>           Print crontab entry for a goal
//   motiva cleanup                    Archive all completed goals and remove stale data
//   motiva improve [path]             Analyze, suggest goals, and run improvement loop
//   motiva suggest "<context>"        Suggest improvement goals for a project
//   motiva capability list            List all registered capabilities
//   motiva capability remove <name>   Remove a capability by name

import { parseArgs } from "node:util";

import { getCliLogger } from "./cli/cli-logger.js";
import { StateManager } from "./state-manager.js";
import { CharacterConfigManager } from "./traits/character-config.js";
import type { CoreLoop } from "./core-loop.js";
import type { LoopConfig } from "./core-loop.js";

// Commands
import { cmdRun } from "./cli/commands/run.js";
import {
  cmdGoalAdd,
  cmdGoalAddRaw,
  cmdGoalList,
  cmdStatus,
  cmdGoalShow,
  cmdGoalReset,
  cmdLog,
  cmdGoalArchive,
  cmdCleanup,
} from "./cli/commands/goal.js";
import { cmdPluginList, cmdPluginInstall, cmdPluginRemove } from "./cli/commands/plugin.js";
import { cmdReport } from "./cli/commands/report.js";
import {
  cmdProvider,
  cmdConfigCharacter,
  cmdDatasourceAdd,
  cmdDatasourceList,
  cmdDatasourceRemove,
  cmdCapabilityList,
  cmdCapabilityRemove,
} from "./cli/commands/config.js";
import { cmdStart, cmdStop, cmdCron } from "./cli/commands/daemon.js";
import { cmdSuggest, cmdImprove } from "./cli/commands/suggest.js";
import { printUsage, formatOperationError } from "./cli/utils.js";

const logger = getCliLogger();

// ─── CLIRunner ───

/**
 * @description Coordinates CLI argument parsing, dependency wiring, and subcommand execution for the Motiva command-line interface.
 */
export class CLIRunner {
  private readonly stateManager: StateManager;
  private readonly characterConfigManager: CharacterConfigManager;
  private activeCoreLoop: CoreLoop | null = null;

  /**
   * @description Creates a CLI runner with state and character configuration managers rooted at the optional base directory.
   * @param {string} [baseDir] Optional base directory for Motiva state storage.
   * @returns {void} Does not return a value.
   */
  constructor(baseDir?: string) {
    this.stateManager = new StateManager(baseDir);
    this.characterConfigManager = new CharacterConfigManager(this.stateManager);
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
   * @description Parses CLI arguments, dispatches the matching Motiva subcommand, and returns the resulting exit code.
   * @param {string[]} argv Raw subcommand arguments, excluding the `node` executable and script path.
   * @returns {Promise<number>} A promise that resolves to `0` for success, `1` for errors, or `2` for stall escalation.
   */
  async run(argv: string[]): Promise<number> {
    if (argv.length === 0) {
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
      let values: { goal?: string; "max-iterations"?: string; adapter?: string; tree?: boolean; yes?: boolean; verbose?: boolean };
      try {
        ({ values } = parseArgs({
          args: argv.slice(1),
          options: {
            goal: { type: "string" },
            "max-iterations": { type: "string" },
            adapter: { type: "string" },
            tree: { type: "boolean" },
            yes: { type: "boolean", short: "y" },
            verbose: { type: "boolean" },
          },
          strict: false,
        }) as { values: { goal?: string; "max-iterations"?: string; adapter?: string; tree?: boolean; yes?: boolean; verbose?: boolean } });
      } catch (err) {
        logger.error(formatOperationError("parse run command arguments", err));
        values = {};
      }

      const goalId = values.goal;
      if (!goalId || typeof goalId !== "string") {
        logger.error("Error: --goal <id> is required for `motiva run`.");
        return 1;
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
      const goalSubcommand = argv[1];

      if (!goalSubcommand) {
        logger.error("Error: goal subcommand required. Available: goal add, goal list, goal archive, goal remove, goal show, goal reset");
        return 1;
      }

      if (goalSubcommand === "add") {
        // Parse all goal add flags from argv.slice(2) with allowPositionals
        let positionals: string[] = [];
        let addValues: {
          negotiate?: boolean;
          dim?: string[];
          title?: string;
          deadline?: string;
          constraint?: string[];
          yes?: boolean;
        } = {};
        try {
          const parsed = parseArgs({
            args: argv.slice(2),
            options: {
              negotiate: { type: "boolean" },
              dim: { type: "string", multiple: true },
              title: { type: "string" },
              deadline: { type: "string" },
              constraint: { type: "string", multiple: true },
              yes: { type: "boolean", short: "y" },
            },
            allowPositionals: true,
            strict: false,
          }) as { values: typeof addValues; positionals: string[] };
          addValues = parsed.values;
          positionals = parsed.positionals;
        } catch (err) {
          logger.error(formatOperationError("parse goal add arguments", err));
          return 1;
        }

        const description = positionals[0];
        const yes = globalYes || (addValues.yes ?? false);
        const rawDimensions = addValues.dim ?? [];

        // Raw mode: --dim provided and --negotiate not set
        if (rawDimensions.length > 0 && !addValues.negotiate) {
          const title = addValues.title || description;
          if (!title) {
            logger.error("Error: --title or description is required. Usage: motiva goal add --title \"tsc zero\" --dim \"tsc_error_count:min:0\"");
            return 1;
          }
          return await cmdGoalAddRaw(this.stateManager, { title, description, rawDimensions });
        }

        // Negotiate mode: requires description
        if (!description) {
          logger.error('Error: description is required. Usage: motiva goal add "<description>" [--negotiate]');
          return 1;
        }

        const deadline = addValues.deadline;
        const constraints = addValues.constraint ?? [];
        return await cmdGoalAdd(this.stateManager, this.characterConfigManager, description, { deadline, constraints, yes });
      }

      if (goalSubcommand === "list") {
        let listValues: { archived?: boolean } = {};
        try {
          ({ values: listValues } = parseArgs({
            args: argv.slice(2),
            options: { archived: { type: "boolean" } },
            strict: false,
          }) as { values: { archived?: boolean } });
        } catch (err) {
          logger.error(formatOperationError("parse goal list arguments", err));
          listValues = {};
        }
        return cmdGoalList(this.stateManager, { archived: listValues.archived });
      }

      if (goalSubcommand === "archive") {
        const goalId = argv[2];
        if (!goalId) {
          logger.error("Error: goal ID is required. Usage: motiva goal archive <id>");
          return 1;
        }
        let archiveValues: { yes?: boolean; force?: boolean } = {};
        try {
          ({ values: archiveValues } = parseArgs({
            args: argv.slice(3),
            options: {
              yes: { type: "boolean", short: "y" },
              force: { type: "boolean" },
            },
            strict: false,
          }) as { values: { yes?: boolean; force?: boolean } });
        } catch (err) {
          logger.error(formatOperationError("parse goal archive arguments", err));
          archiveValues = {};
        }
        return await cmdGoalArchive(this.stateManager, goalId, { ...archiveValues, yes: globalYes || archiveValues.yes });
      }

      if (goalSubcommand === "remove") {
        const goalId = argv[2];
        if (!goalId) {
          logger.error("Error: goal ID is required. Usage: motiva goal remove <id>");
          return 1;
        }
        const deleted = await this.stateManager.deleteGoal(goalId);
        if (deleted) {
          console.log(`Goal ${goalId} removed.`);
          return 0;
        } else {
          logger.error(`Goal not found: ${goalId}`);
          return 1;
        }
      }

      if (goalSubcommand === "show") {
        const goalId = argv[2];
        if (!goalId) {
          logger.error("Error: goal ID is required. Usage: motiva goal show <id>");
          return 1;
        }
        return await cmdGoalShow(this.stateManager, goalId);
      }

      if (goalSubcommand === "reset") {
        const goalId = argv[2];
        if (!goalId) {
          logger.error("Error: goal ID is required. Usage: motiva goal reset <id>");
          return 1;
        }
        return await cmdGoalReset(this.stateManager, goalId);
      }

      logger.error(`Unknown goal subcommand: "${goalSubcommand}"`);
      logger.error("Available: goal add, goal list, goal archive, goal remove, goal show, goal reset");
      return 1;
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
        logger.error("Error: --goal <id> is required for `motiva status`.");
        return 1;
      }

      return cmdStatus(this.stateManager, goalId);
    }

    if (subcommand === "report") {
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
        logger.error(formatOperationError("parse report command arguments", err));
        values = {};
      }

      const goalId = values.goal;
      if (!goalId || typeof goalId !== "string") {
        logger.error("Error: --goal <id> is required for `motiva report`.");
        return 1;
      }

      return cmdReport(this.stateManager, goalId);
    }

    if (subcommand === "log") {
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
        logger.error(formatOperationError("parse log command arguments", err));
        values = {};
      }

      const goalId = values.goal;
      if (!goalId || typeof goalId !== "string") {
        logger.error("Error: --goal <id> is required for `motiva log`.");
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
        logger.error("Error: datasource subcommand required. Available: datasource add, datasource list, datasource remove");
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

      logger.error(`Unknown datasource subcommand: "${dsSubcommand}"`);
      logger.error("Available: datasource add, datasource list, datasource remove");
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

      logger.error(`Unknown plugin subcommand: "${pluginSubcommand}"`);
      logger.error("Available: plugin list, plugin install, plugin remove");
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
        return cmdConfigCharacter(this.stateManager, this.characterConfigManager, argv.slice(2));
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
