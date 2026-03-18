// ─── motiva goal subcommands ───

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { getArchiveDir, getReportsDir } from "../../utils/paths.js";
import { readJsonFile } from "../../utils/json-io.js";

import { StateManager } from "../../state-manager.js";
import { CharacterConfigManager } from "../../traits/character-config.js";
import { loadProviderConfig } from "../../llm/provider-config.js";
import { ReportingEngine } from "../../reporting-engine.js";
import { EthicsRejectedError, gatherNegotiationContext } from "../../goal/goal-negotiator.js";
import { buildDeps } from "../setup.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import {
  autoRegisterFileExistenceDataSources,
  autoRegisterShellDataSources,
} from "./goal-utils.js";

// Re-export everything from split modules for backward compatibility
export {
  ShellCommandConfig,
  SHELL_DIMENSION_PATTERNS,
  RawDimensionSpec,
  parseRawDim,
  buildThreshold,
  autoRegisterFileExistenceDataSources,
  autoRegisterShellDataSources,
} from "./goal-utils.js";
export { cmdGoalAddRaw } from "./goal-raw.js";

export async function cmdGoalAdd(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  description: string,
  opts: { deadline?: string; constraints?: string[]; yes?: boolean }
): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const providerConfig = await loadProviderConfig();
  const provider = providerConfig.llm_provider;
  if (!apiKey && provider !== "ollama" && provider !== "openai" && provider !== "codex") {
    getCliLogger().error(
      "Error: ANTHROPIC_API_KEY environment variable is not set.\n" +
        "Set it with: export ANTHROPIC_API_KEY=<your-key>\n" +
        "Or use OpenAI: export MOTIVA_LLM_PROVIDER=openai\n" +
        "Or use Ollama: export MOTIVA_LLM_PROVIDER=ollama\n" +
        "Or use Codex: export MOTIVA_LLM_PROVIDER=codex"
    );
    return 1;
  }

  let deps: Awaited<ReturnType<typeof buildDeps>>;
  try {
    deps = await buildDeps(stateManager, characterConfigManager, apiKey);
  } catch (err) {
    getCliLogger().error(formatOperationError("initialise goal negotiation dependencies", err));
    return 1;
  }

  const { goalNegotiator } = deps;

  console.log(`Negotiating goal: "${description}"`);
  if (opts.deadline) {
    console.log(`Deadline: ${opts.deadline}`);
  }
  if (opts.constraints && opts.constraints.length > 0) {
    console.log(`Constraints: ${opts.constraints.join(", ")}`);
  }
  console.log("This may take a moment...\n");

  try {
    const workspaceContext = await gatherNegotiationContext(description, process.cwd());
    const { goal, response } = await goalNegotiator.negotiate(description, {
      deadline: opts.deadline,
      constraints: opts.constraints,
      workspaceContext: workspaceContext || undefined,
    });

    if (response.type === "counter_propose") {
      console.log(`\nCounter-proposal: ${response.message}`);
      if (response.counter_proposal) {
        console.log(`Suggested target: ${response.counter_proposal.realistic_target}`);
        console.log(`Reasoning: ${response.counter_proposal.reasoning}`);
      }

      let accepted: boolean;
      if (opts.yes) {
        console.log("\n--- Auto-accepted counter-proposal (--yes) ---");
        accepted = true;
      } else {
        accepted = await new Promise<boolean>((resolve) => {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          process.stdout.write("\nAccept this counter-proposal and register the goal? [y/N] ");
          rl.once("line", (answer) => {
            rl?.close();
            resolve(answer.trim().toLowerCase() === "y");
          });
        });
      }

      if (!accepted) {
        await stateManager.deleteGoal(goal.id);
        console.log("Goal not registered.");
        return 0;
      }
    }

    await autoRegisterFileExistenceDataSources(stateManager, goal.dimensions, goal.description, goal.id);
    await autoRegisterShellDataSources(stateManager, goal.dimensions, goal.id);

    console.log(`Goal registered successfully!`);
    console.log(`Goal ID:    ${goal.id}`);
    console.log(`Title:      ${goal.title}`);
    console.log(`Status:     ${goal.status}`);
    console.log(`Dimensions: ${goal.dimensions.length}`);
    console.log(`\nResponse: ${response.message}`);

    if (goal.dimensions.length > 0) {
      console.log(`\nDimensions:`);
      for (const dim of goal.dimensions) {
        console.log(`  - ${dim.label} (${dim.name}): ${JSON.stringify(dim.threshold)}`);
      }
    }

    console.log(`\nTo run the loop: motiva run --goal ${goal.id}`);
    return 0;
  } catch (err) {
    if (err instanceof EthicsRejectedError) {
      getCliLogger().error(formatOperationError(`negotiate goal "${description}" via ethics gate`, err));
      getCliLogger().error(`Ethics gate reasoning: ${err.verdict.reasoning}`);
      return 1;
    }
    getCliLogger().error(formatOperationError(`negotiate goal "${description}"`, err));
    return 1;
  }
}

export async function cmdGoalList(
  stateManager: StateManager,
  opts: { archived?: boolean } = {}
): Promise<number> {
  const goalsDir = path.join(stateManager.getBaseDir(), "goals");

  let goalsDirEntries: string[] = [];
  try {
    await fsp.access(goalsDir);
    goalsDirEntries = await fsp.readdir(goalsDir);
  } catch { /* dir doesn't exist or unreadable */ }

  if (goalsDirEntries.length === 0) {
    console.log("No goals registered. Use `motiva goal add` to create one.");
  } else {
    const goalDirs: string[] = [];
    for (const e of goalsDirEntries) {
      try {
        const stat = await fsp.stat(path.join(goalsDir, e));
        if (stat.isDirectory()) goalDirs.push(e);
      } catch (err) {
        getCliLogger().error(formatOperationError(`inspect goal directory entry "${e}"`, err));
      }
    }

    if (goalDirs.length === 0) {
      console.log("No goals registered. Use `motiva goal add` to create one.");
    } else {
      console.log(`Found ${goalDirs.length} goal(s):\n`);
      for (const goalId of goalDirs) {
        const goal = await stateManager.loadGoal(goalId);
        if (!goal) {
          console.log(`[${goalId}] (could not load)`);
          continue;
        }
        console.log(
          `[${goalId}] status: ${goal.status} — ${goal.title} (dimensions: ${goal.dimensions.length})`
        );
      }
    }
  }

  const archivedIds = await stateManager.listArchivedGoals();
  if (opts.archived && archivedIds.length > 0) {
    console.log(`\nArchived goals (${archivedIds.length}):\n`);
    for (const goalId of archivedIds) {
      const archivedGoalPath = path.join(
        getArchiveDir(stateManager.getBaseDir()),
        goalId,
        "goal",
        "goal.json"
      );
      let title = "(could not load)";
      let status = "unknown";
      let dimCount = 0;
      try {
        await fsp.access(archivedGoalPath);
        const raw = await readJsonFile<{
          title?: string;
          status?: string;
          dimensions?: unknown[];
        }>(archivedGoalPath);
        title = raw.title ?? title;
        status = raw.status ?? status;
        dimCount = raw.dimensions?.length ?? 0;
      } catch (err) {
        getCliLogger().error(formatOperationError(`read archived goal metadata for "${goalId}"`, err));
      }
      console.log(`[${goalId}] status: ${status} — ${title} (dimensions: ${dimCount})`);
    }
  } else {
    console.log(`\nArchived goals: ${archivedIds.length} (use \`motiva goal list --archived\` to show)`);
  }

  return 0;
}

export async function cmdStatus(stateManager: StateManager, goalId: string): Promise<number> {
  const reportingEngine = new ReportingEngine(stateManager);

  const goal = await stateManager.loadGoal(goalId);
  if (!goal) {
    getCliLogger().error(`Error: Goal "${goalId}" not found.`);
    return 1;
  }

  console.log(`# Status: ${goal.title}`);
  console.log(`\n**Goal ID**: ${goalId}`);
  console.log(`**Status**: ${goal.status}`);
  if (goal.deadline) {
    console.log(`**Deadline**: ${goal.deadline}`);
  }
  console.log(`\n## Dimensions\n`);
  for (const dim of goal.dimensions) {
    const progress =
      typeof dim.current_value === "number"
        ? `${(dim.current_value * 100).toFixed(1)}%`
        : dim.current_value !== null
        ? String(dim.current_value)
        : "not yet measured";
    const confidence = `${(dim.confidence * 100).toFixed(1)}%`;
    console.log(`- **${dim.label}** (${dim.name})`);
    console.log(`  Progress: ${progress}  Confidence: ${confidence}`);
    console.log(`  Target: ${JSON.stringify(dim.threshold)}`);
  }

  const reports = await reportingEngine.listReports(goalId);
  const execReports = reports
    .filter((r) => r.report_type === "execution_summary")
    .sort((a, b) => (a.generated_at < b.generated_at ? 1 : -1));

  if (execReports.length > 0) {
    const latest = execReports[0];
    console.log(`\n## Latest Execution Summary\n`);
    console.log(latest.content);
  } else {
    console.log(`\n_No execution reports yet. Run \`motiva run --goal ${goalId}\` to start._`);
  }

  return 0;
}

export async function cmdGoalShow(stateManager: StateManager, goalId: string): Promise<number> {
  const goal = await stateManager.loadGoal(goalId);
  if (!goal) {
    getCliLogger().error(`Error: Goal "${goalId}" not found.`);
    return 1;
  }

  console.log(`# Goal: ${goal.title}`);
  console.log(`\nID:          ${goal.id}`);
  console.log(`Status:      ${goal.status}`);
  console.log(`Description: ${goal.description || "(none)"}`);
  if (goal.deadline) {
    console.log(`Deadline:    ${goal.deadline}`);
  }
  console.log(`Created at:  ${goal.created_at}`);

  if (goal.dimensions.length > 0) {
    console.log(`\nDimensions:`);
    for (const dim of goal.dimensions) {
      console.log(`  - ${dim.label} (${dim.name})`);
      console.log(`    Threshold type:  ${dim.threshold.type}`);
      console.log(`    Threshold value: ${JSON.stringify((dim.threshold as { value?: unknown }).value ?? dim.threshold)}`);
    }
  } else {
    console.log(`\nDimensions: (none)`);
  }

  if (goal.constraints.length > 0) {
    console.log(`\nConstraints:`);
    for (const c of goal.constraints) {
      console.log(`  - ${c}`);
    }
  }

  return 0;
}

export async function cmdGoalReset(stateManager: StateManager, goalId: string): Promise<number> {
  const goal = await stateManager.loadGoal(goalId);
  if (!goal) {
    getCliLogger().error(`Error: Goal "${goalId}" not found.`);
    return 1;
  }

  const now = new Date().toISOString();
  const resetDimensions = goal.dimensions.map((dim) => ({
    ...dim,
    current_value: null,
    confidence: 0,
    last_updated: null,
    history: [],
  }));

  const resetGoal = {
    ...goal,
    status: "active" as const,
    loop_status: "idle" as const,
    dimensions: resetDimensions,
    updated_at: now,
  };

  await stateManager.saveGoal(resetGoal);

  console.log(`Goal "${goalId}" reset to active.`);
  console.log(`  Status:      active`);
  console.log(`  Dimensions:  ${resetDimensions.length} dimension(s) cleared`);
  console.log(`\nRun \`motiva run --goal ${goalId}\` to restart the loop.`);

  return 0;
}

export async function cmdLog(stateManager: StateManager, goalId: string): Promise<number> {
  const observationLog = await stateManager.loadObservationLog(goalId);
  const gapHistory = await stateManager.loadGapHistory(goalId);

  if ((!observationLog || observationLog.entries.length === 0) && gapHistory.length === 0) {
    console.log(`No logs found for goal ${goalId}`);
    return 0;
  }

  if (observationLog && observationLog.entries.length > 0) {
    console.log(`# Observation Log (${observationLog.entries.length} entries, newest first)\n`);
    const sorted = [...observationLog.entries].sort((a, b) =>
      a.timestamp < b.timestamp ? 1 : -1
    );
    for (const entry of sorted) {
      console.log(`[${entry.timestamp}]`);
      console.log(`  Dimension:  ${entry.dimension_name}`);
      console.log(`  Confidence: ${(entry.confidence * 100).toFixed(1)}%`);
      console.log(`  Layer:      ${entry.layer}`);
      console.log(`  Trigger:    ${entry.trigger}`);
      console.log();
    }
  }

  if (gapHistory.length > 0) {
    console.log(`# Gap History (${gapHistory.length} entries, newest first)\n`);
    const sorted = [...gapHistory].sort((a, b) =>
      a.timestamp < b.timestamp ? 1 : -1
    );
    for (const entry of sorted) {
      const avgGap =
        entry.gap_vector.length > 0
          ? entry.gap_vector.reduce((sum, g) => sum + g.normalized_weighted_gap, 0) /
            entry.gap_vector.length
          : 0;
      console.log(`[${entry.timestamp}]`);
      console.log(`  Iteration: ${entry.iteration}`);
      console.log(`  Avg gap:   ${avgGap.toFixed(4)} (across ${entry.gap_vector.length} dimension(s))`);
      console.log();
    }
  }

  return 0;
}

export async function cmdGoalArchive(
  stateManager: StateManager,
  goalId: string,
  opts: { yes?: boolean; force?: boolean }
): Promise<number> {
  const goal = await stateManager.loadGoal(goalId);
  if (!goal) {
    getCliLogger().error(`Error: Goal "${goalId}" not found.`);
    return 1;
  }

  if (goal.status !== "completed" && !opts.force && !opts.yes) {
    getCliLogger().warn(`Warning: Goal "${goalId}" is not completed (status: ${goal.status}).`);
    getCliLogger().warn("Archive anyway? Use --yes or --force to skip this check.");
    return 1;
  }

  const archived = await stateManager.archiveGoal(goalId);
  if (!archived) {
    getCliLogger().error(`Error: Failed to archive goal "${goalId}".`);
    return 1;
  }

  console.log(`Goal "${goalId}" archived successfully.`);
  console.log(`  Title:  ${goal.title}`);
  console.log(`  Status: ${goal.status}`);
  return 0;
}

export async function cmdCleanup(stateManager: StateManager): Promise<number> {
  const goalIds = await stateManager.listGoalIds();

  const completed: string[] = [];
  for (const goalId of goalIds) {
    const goal = await stateManager.loadGoal(goalId);
    if (goal && goal.status === "completed") {
      completed.push(goalId);
    }
  }

  if (completed.length === 0) {
    console.log("No completed goals to archive.");
  } else {
    for (const goalId of completed) {
      await stateManager.archiveGoal(goalId);
    }
    console.log(`Archived ${completed.length} completed goal(s).`);
  }

  const activeGoalIds = new Set(await stateManager.listGoalIds());
  const baseDir = stateManager.getBaseDir();
  const staleReports: string[] = [];

  const reportsDir = getReportsDir(baseDir);
  let reportsDirExists = false;
  try { await fsp.access(reportsDir); reportsDirExists = true; } catch { /* not found */ }

  if (reportsDirExists) {
    try {
      const reportFiles = (await fsp.readdir(reportsDir)).filter((f) => f.endsWith(".json"));
      for (const file of reportFiles) {
        try {
          const raw = await readJsonFile<{ goal_id?: string }>(path.join(reportsDir, file));
          if (raw.goal_id && !activeGoalIds.has(raw.goal_id)) {
            staleReports.push(file);
          }
        } catch (err) {
          getCliLogger().error(formatOperationError(`read report metadata from "${file}"`, err));
        }
      }
    } catch (err) {
      getCliLogger().error(formatOperationError(`scan reports directory "${reportsDir}"`, err));
    }
  }

  if (staleReports.length > 0) {
    console.log(`\nOrphaned report files (no matching active goal): ${staleReports.length}`);
    for (const f of staleReports) {
      console.log(`  ${f}`);
    }
    console.log("(These can be removed manually from ~/.motiva/reports/)");
  }

  return 0;
}
