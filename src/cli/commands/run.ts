// ─── pulseed run command ───

import * as readline from "node:readline";

import { StateManager } from "../../state-manager.js";
import { CharacterConfigManager } from "../../traits/character-config.js";
import { ensureProviderConfig } from "../ensure-api-key.js";
import type { LoopConfig } from "../../core-loop.js";
import type { Task } from "../../types/task.js";
import { buildDeps } from "../setup.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import {
  buildAutoApprovalFn,
  buildLoopLogger,
  buildProgressHandler,
  runLoopWithSignals,
} from "../utils/loop-runner.js";

function buildApprovalFn(rl: readline.Interface): (task: Task) => Promise<boolean> {
  return (task: Task): Promise<boolean> => {
    return new Promise((resolve) => {
      rl.pause();
      process.stdout.write("\n--- Approval Required ---\n");
      process.stdout.write(`Task: ${task.work_description}\n`);
      process.stdout.write(`Rationale: ${task.rationale}\n`);
      process.stdout.write(`Reversibility: ${task.reversibility}\n`);
      rl.resume();
      rl.question("Approve this task? [y/N] ", (answer) => {
        process.stdout.write("\n");
        resolve(answer.trim().toLowerCase() === "y");
      });
    });
  };
}

export async function cmdRun(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  goalId: string,
  loopConfig?: LoopConfig,
  autoApprove?: boolean,
  verbose?: boolean,
  activeCoreLoopRef?: { value: import("../../core-loop.js").CoreLoop | null }
): Promise<number> {
  try {
    await ensureProviderConfig();
  } catch (err) {
    getCliLogger().error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const rl = autoApprove
    ? null
    : readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

  const approvalFn = autoApprove ? buildAutoApprovalFn() : buildApprovalFn(rl!);
  const logger = buildLoopLogger();
  const onProgress = buildProgressHandler();

  let deps: Awaited<ReturnType<typeof buildDeps>>;
  try {
    deps = await buildDeps(stateManager, characterConfigManager, loopConfig, approvalFn, logger, onProgress);
  } catch (err) {
    rl?.close();
    logger.error(formatOperationError("initialise dependencies", err));
    if (verbose || process.env.DEBUG) {
      logger.error(err instanceof Error ? err.stack ?? String(err) : String(err));
    }
    return 1;
  }

  const { coreLoop } = deps;

  const goal = await stateManager.loadGoal(goalId);
  if (!goal) {
    rl?.close();
    logger.error(`Error: Goal "${goalId}" not found.`);
    return 1;
  }

  console.log(`Running PulSeed loop for goal: ${goalId}`);
  console.log(`Goal: ${goal.title}`);
  if (loopConfig?.treeMode) {
    console.log("Tree mode enabled — iterating across all tree nodes");
  }
  console.log("Press Ctrl+C to stop.\n");

  if (activeCoreLoopRef) {
    activeCoreLoopRef.value = coreLoop;
  }

  let result: Awaited<ReturnType<typeof coreLoop.run>>;
  try {
    result = await runLoopWithSignals(coreLoop, goalId);
  } catch (err) {
    logger.error(formatOperationError(`run core loop for goal "${goalId}"`, err));
    logger.error(`Hint: Check ~/.pulseed/logs/ for details or re-run with DEBUG=1 for stack traces.`);
    if (verbose || process.env.DEBUG) {
      logger.error(err instanceof Error ? err.stack ?? String(err) : String(err));
    }
    if (activeCoreLoopRef) activeCoreLoopRef.value = null;
    rl?.close();
    return 1;
  }

  if (activeCoreLoopRef) activeCoreLoopRef.value = null;
  rl?.close();

  console.log(`\n--- Loop Result ---`);
  console.log(`Goal ID:          ${result.goalId}`);
  console.log(`Final status:     ${result.finalStatus}`);
  console.log(`Total iterations: ${result.totalIterations}`);
  console.log(`Started at:       ${result.startedAt}`);
  console.log(`Completed at:     ${result.completedAt}`);

  switch (result.finalStatus) {
    case "completed":
      return 0;
    case "stalled":
      logger.error("Goal stalled — escalation level reached maximum.");
      return 2;
    case "error":
      console.error(`Error: ${result.errorMessage || "Loop ended with error. Check ~/.pulseed/logs/ for details."}`);
      return 1;
    default:
      return 0;
  }
}
