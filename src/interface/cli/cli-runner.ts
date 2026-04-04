#!/usr/bin/env node
// ─── CLIRunner ───
//
// PulSeed CLI entry point. Wires all dependencies and exposes subcommands:
//   pulseed run --goal <id>            Run CoreLoop once for a given goal
//   pulseed goal add "<description>"   Negotiate and register a new goal (interactive)
//   pulseed goal list                  List all registered goals
//   pulseed goal archive <id>          Archive a completed goal
//   pulseed goal show <id>             Show goal details
//   pulseed goal reset <id>            Reset goal state for re-running
//   pulseed status --goal <id>         Show current progress report
//   pulseed report --goal <id>         Show latest report
//   pulseed log --goal <id>            View execution/observation log
//   pulseed start --goal <id>          Start daemon mode for one or more goals
//   pulseed stop                       Stop the running daemon
//   pulseed cron --goal <id>           Print crontab entry for a goal
//   pulseed cleanup                    Archive all completed goals and remove stale data
//   pulseed improve [path]             Analyze, suggest goals, and run improvement loop
//   pulseed suggest "<context>"        Suggest improvement goals for a project
//   pulseed capability list            List all registered capabilities
//   pulseed capability remove <name>   Remove a capability by name
//   pulseed knowledge list             List all shared knowledge entries
//   pulseed knowledge search <query>   Search knowledge entries by keyword
//   pulseed knowledge stats            Show knowledge base statistics
//   pulseed task list --goal <id>      List tasks for a goal
//   pulseed task show <taskId> --goal <id>  Show task details

import { getCliLogger } from "./cli-logger.js";
import { StateManager } from "../base/state/state-manager.js";
import { CharacterConfigManager } from "../platform/traits/character-config.js";
import type { CoreLoop } from "../orchestrator/loop/core-loop.js";
import { dispatchCommand } from "./cli-command-registry.js";
import { formatOperationError } from "./utils.js";

const logger = getCliLogger();

// ─── CLIRunner ───

/**
 * @description Coordinates CLI argument parsing, dependency wiring, and subcommand execution for the PulSeed command-line interface.
 */
export class CLIRunner {
  private readonly stateManager: StateManager;
  private readonly characterConfigManager: CharacterConfigManager;
  private activeCoreLoop: CoreLoop | null = null;

  /**
   * @description Creates a CLI runner with state and character configuration managers rooted at the optional base directory.
   * @param {string} [baseDir] Optional base directory for PulSeed state storage.
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
   * @description Parses CLI arguments, dispatches the matching PulSeed subcommand, and returns the resulting exit code.
   * @param {string[]} argv Raw subcommand arguments, excluding the `node` executable and script path.
   * @returns {Promise<number>} A promise that resolves to `0` for success, `1` for errors, or `2` for stall escalation.
   */
  async run(argv: string[]): Promise<number> {
    await this.init();

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

    const activeCoreLoopRef = { value: this.activeCoreLoop };
    const result = await dispatchCommand(
      filteredArgv,
      globalYes,
      this.stateManager,
      this.characterConfigManager,
      activeCoreLoopRef,
    );
    this.activeCoreLoop = activeCoreLoopRef.value;
    return result;
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
