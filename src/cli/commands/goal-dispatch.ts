// ─── pulseed goal subcommand dispatcher ───
//
// Parses args for each `pulseed goal <subcommand>` and delegates to the
// individual command functions in goal.ts / goal-raw.ts.

import { parseArgs } from "node:util";

import { StateManager } from "../../state-manager.js";
import { CharacterConfigManager } from "../../traits/character-config.js";
import { getCliLogger } from "../cli-logger.js";
import { formatOperationError } from "../utils.js";
import {
  cmdGoalAdd,
  cmdGoalList,
  cmdGoalShow,
  cmdGoalReset,
  cmdGoalArchive,
} from "./goal.js";
import { cmdGoalAddRaw } from "./goal-raw.js";

const logger = getCliLogger();

/**
 * Dispatch a `pulseed goal <subCmd> [args…]` invocation.
 *
 * @param subCmd  - The word after "goal" (e.g. "add", "list", …)
 * @param args    - Everything after the subcommand (argv.slice(2))
 * @param globalYes - Whether --yes/-y was set globally
 * @param stateManager - Injected state manager
 * @param characterConfigManager - Injected character-config manager
 */
export async function dispatchGoalCommand(
  subCmd: string | undefined,
  args: string[],
  globalYes: boolean,
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
): Promise<number> {
  if (!subCmd) {
    logger.error(
      "Error: goal subcommand required. Available: goal add, goal list, goal archive, goal remove, goal show, goal reset",
    );
    return 1;
  }

  if (subCmd === "add") {
    let positionals: string[] = [];
    let addValues: {
      negotiate?: boolean;
      "no-refine"?: boolean;
      dim?: string[];
      title?: string;
      deadline?: string;
      constraint?: string[];
      yes?: boolean;
      parent?: string;
    } = {};
    try {
      const parsed = parseArgs({
        args,
        options: {
          negotiate: { type: "boolean" },
          "no-refine": { type: "boolean" },
          dim: { type: "string", multiple: true },
          title: { type: "string" },
          deadline: { type: "string" },
          constraint: { type: "string", multiple: true },
          yes: { type: "boolean", short: "y" },
          parent: { type: "string" },
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

    // Auto-infer mode: title provided, no --dim, no --negotiate, no --no-refine
    const inferTitle = addValues.title || description;
    if (inferTitle && rawDimensions.length === 0 && !addValues.negotiate && !addValues["no-refine"]) {
      const { buildLLMClient } = await import("../../llm/provider-factory.js");
      const { inferDimensionsFromTitle, formatInferredDimensions } = await import("./goal-infer.js");

      let llmClient;
      try {
        llmClient = await buildLLMClient();
      } catch {
        // No LLM configured — fall through to refine mode
        llmClient = null;
      }

      if (llmClient) {
        const inferred = await inferDimensionsFromTitle(inferTitle, llmClient);

        if (inferred.length > 0) {
          console.log("\n--- Inferred dimensions ---");
          console.log(formatInferredDimensions(inferred));

          let accepted = yes;
          if (!yes) {
            const { promptYesNo } = await import("../utils.js");
            accepted = await promptYesNo("\nAccept these dimensions? [y/N] ");
          } else {
            console.log("--- Auto-accepted (--yes) ---");
          }

          if (accepted) {
            const rawDims = inferred.map((d) => `${d.name}:${d.type}:${d.value}`);
            return await cmdGoalAddRaw(stateManager, {
              title: inferTitle,
              description: description || inferTitle,
              rawDimensions: rawDims,
              parent_id: addValues.parent,
            });
          }
          // If rejected, fall through to refine mode
        }
      }
    }

    // Raw mode: --dim provided and --negotiate not set
    if (rawDimensions.length > 0 && !addValues.negotiate) {
      const title = addValues.title || description;
      if (!title) {
        logger.error(
          'Error: --title or description is required. Usage: pulseed goal add --title "tsc zero" --dim "tsc_error_count:min:0"',
        );
        return 1;
      }
      return await cmdGoalAddRaw(stateManager, { title, description, rawDimensions, parent_id: addValues.parent });
    }

    // Refine/negotiate mode: requires description
    if (!description) {
      logger.error('Error: description is required. Usage: pulseed goal add "<description>" [--no-refine]');
      return 1;
    }

    const deadline = addValues.deadline;
    const constraints = addValues.constraint ?? [];
    const noRefine = addValues["no-refine"] ?? false;
    return await cmdGoalAdd(stateManager, characterConfigManager, description, {
      deadline,
      constraints,
      yes,
      noRefine,
    });
  }

  if (subCmd === "list") {
    let listValues: { archived?: boolean } = {};
    try {
      ({ values: listValues } = parseArgs({
        args,
        options: { archived: { type: "boolean" } },
        strict: false,
      }) as { values: { archived?: boolean } });
    } catch (err) {
      logger.error(formatOperationError("parse goal list arguments", err));
      listValues = {};
    }
    return cmdGoalList(stateManager, { archived: listValues.archived });
  }

  if (subCmd === "archive") {
    const goalId = args[0];
    if (!goalId) {
      logger.error("Error: goal ID is required. Usage: pulseed goal archive <id>");
      return 1;
    }
    let archiveValues: { yes?: boolean; force?: boolean } = {};
    try {
      ({ values: archiveValues } = parseArgs({
        args: args.slice(1),
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
    return await cmdGoalArchive(stateManager, goalId, {
      ...archiveValues,
      yes: globalYes || archiveValues.yes,
    });
  }

  if (subCmd === "remove") {
    const goalId = args[0];
    if (!goalId) {
      logger.error("Error: goal ID is required. Usage: pulseed goal remove <id>");
      return 1;
    }
    const deleted = await stateManager.deleteGoal(goalId);
    if (deleted) {
      console.log(`Goal ${goalId} removed.`);
      return 0;
    } else {
      logger.error(`Goal not found: ${goalId}`);
      return 1;
    }
  }

  if (subCmd === "show") {
    const goalId = args[0];
    if (!goalId) {
      logger.error("Error: goal ID is required. Usage: pulseed goal show <id>");
      return 1;
    }
    return await cmdGoalShow(stateManager, goalId);
  }

  if (subCmd === "reset") {
    const goalId = args[0];
    if (!goalId) {
      logger.error("Error: goal ID is required. Usage: pulseed goal reset <id>");
      return 1;
    }
    return await cmdGoalReset(stateManager, goalId);
  }

  logger.error(`Unknown goal subcommand: "${subCmd}"`);
  logger.error("Available: goal add, goal list, goal archive, goal remove, goal show, goal reset");
  return 1;
}
