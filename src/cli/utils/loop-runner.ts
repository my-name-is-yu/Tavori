// ─── Shared loop utilities for CLI commands ───

import { getLogsDir } from "../../utils/paths.js";
import { Logger } from "../../runtime/logger.js";
import type { CoreLoop, LoopResult, ProgressEvent } from "../../loop/core-loop.js";
import type { Task } from "../../types/task.js";

export function buildAutoApprovalFn(): (task: Task) => Promise<boolean> {
  return async (task: Task): Promise<boolean> => {
    console.log(`\n--- Auto-approved (--yes) ---`);
    console.log(`Task: ${task.work_description.split("\n")[0]}`);
    return true;
  };
}

export function buildLoopLogger(): Logger {
  return new Logger({
    dir: getLogsDir(),
    level: "debug",
    consoleOutput: false,
  });
}

export function buildProgressHandler(): (event: ProgressEvent) => void {
  let lastIterationLogged = -1;
  return (event: ProgressEvent): void => {
    const prefix = `[${event.iteration}/${event.maxIterations}]`;
    if (event.phase === "Observing...") {
      if (event.iteration !== lastIterationLogged) {
        lastIterationLogged = event.iteration;
        const gapStr = event.gap !== undefined ? ` gap=${event.gap.toFixed(2)}` : "";
        process.stdout.write(`${prefix} Observing...${gapStr}\n`);
      }
    } else if (event.phase === "Generating task...") {
      const gapStr = event.gap !== undefined ? ` gap=${event.gap.toFixed(2)}` : "";
      const confStr = event.confidence !== undefined ? ` confidence=${Math.round(event.confidence * 100)}%` : "";
      process.stdout.write(`${prefix} Generating task...${gapStr}${confStr}\n`);
    } else if (event.phase === "Skipped") {
      const reason = event.skipReason ?? "unknown";
      process.stdout.write(`${prefix} Skipped — ${reason.replace(/_/g, " ")}\n`);
    } else if (event.phase === "Executing task...") {
      if (event.taskDescription) {
        process.stdout.write(`${prefix} Executing task: "${event.taskDescription}"\n`);
      } else {
        process.stdout.write(`${prefix} Executing task...\n`);
      }
    } else if (event.phase === "Verifying result...") {
      if (event.taskDescription) {
        process.stdout.write(`${prefix} Verifying: "${event.taskDescription}"\n`);
      } else {
        process.stdout.write(`${prefix} Verifying result...\n`);
      }
    } else if (event.phase === "Skipped (no state change)") {
      process.stdout.write(`${prefix} Skipped (no state change detected)\n`);
    }
  };
}

export async function runLoopWithSignals(
  coreLoop: CoreLoop,
  goalId: string
): Promise<LoopResult> {
  const shutdown = () => {
    console.log("\nStopping loop...");
    coreLoop.stop();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    return await coreLoop.run(goalId);
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}
