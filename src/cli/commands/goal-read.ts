// ─── tavori goal read commands (read-only) ───

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getArchiveDir, getGoalsDir } from "../../utils/paths.js";
import { readJsonFile } from "../../utils/json-io.js";

import { StateManager } from "../../state-manager.js";
import { ReportingEngine } from "../../reporting-engine.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import { dimensionProgress } from "../../drive/gap-calculator.js";

async function printActiveGoals(
  stateManager: StateManager,
  goalsDir: string
): Promise<void> {
  let goalsDirEntries: string[] = [];
  try {
    goalsDirEntries = await fsp.readdir(goalsDir);
  } catch { /* dir doesn't exist or unreadable */ }

  if (goalsDirEntries.length === 0) {
    console.log("No goals registered. Use `tavori goal add` to create one.");
    return;
  }

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
    console.log("No goals registered. Use `tavori goal add` to create one.");
    return;
  }

  const allGoals: Array<{ id: string; title: string; status: string; dimensions: number; isSubgoal: boolean }> = [];
  for (const goalId of goalDirs) {
    const goal = await stateManager.loadGoal(goalId);
    if (!goal) {
      allGoals.push({ id: goalId, title: "(could not load)", status: "unknown", dimensions: 0, isSubgoal: false });
    } else {
      allGoals.push({
        id: goalId,
        title: goal.title,
        status: goal.status,
        dimensions: goal.dimensions.length,
        isSubgoal: !!goal.parent_id,
      });
    }
  }

  const rootGoals = allGoals.filter((g) => !g.isSubgoal);
  const subgoalCount = allGoals.length - rootGoals.length;

  if (rootGoals.length === 0) {
    console.log("No root goals found.");
  } else {
    console.log(`Found ${rootGoals.length} root goal(s):\n`);
    for (const g of rootGoals) {
      console.log(`[${g.id}] status: ${g.status} — ${g.title} (dimensions: ${g.dimensions})`);
    }
  }

  if (subgoalCount > 0) {
    console.log(`\n(${subgoalCount} subgoal(s) hidden — use \`tavori goal show <id>\` for tree details)`);
  }
}

async function printArchivedGoals(stateManager: StateManager, archivedIds: string[]): Promise<void> {
  if (archivedIds.length === 0) {
    console.log(`\nNo archived goals found.`);
    return;
  }

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
}

export async function cmdGoalList(
  stateManager: StateManager,
  opts: { archived?: boolean } = {}
): Promise<number> {
  const goalsDir = getGoalsDir(stateManager.getBaseDir());
  const archivedIds = await stateManager.listArchivedGoals();

  if (opts.archived) {
    await printArchivedGoals(stateManager, archivedIds);
  } else {
    await printActiveGoals(stateManager, goalsDir);
    console.log(`\nArchived goals: ${archivedIds.length} (use \`tavori goal list --archived\` to show)`);
  }

  return 0;
}

export async function cmdStatus(
  stateManager: StateManager,
  goalId: string,
  reportingEngine?: ReportingEngine
): Promise<number> {
  const engine = reportingEngine ?? new ReportingEngine(stateManager);

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
    let progress: string;
    const prog = dimensionProgress(dim.current_value, dim.threshold);
    if (prog === null) {
      progress = "not yet measured";
    } else {
      const rawDisplay = typeof dim.current_value === "number"
        ? dim.current_value.toFixed(1)
        : String(dim.current_value);
      progress = `${prog.toFixed(3)} (raw: ${rawDisplay})`;
    }
    const confidence = `${(dim.confidence * 100).toFixed(1)}%`;
    console.log(`- **${dim.label}** (${dim.name})`);
    console.log(`  Progress: ${progress}  Confidence: ${confidence}`);
    console.log(`  Target: ${JSON.stringify(dim.threshold)}`);
  }

  const reports = await engine.listReports(goalId);
  const execReports = reports
    .filter((r) => r.report_type === "execution_summary")
    .sort((a, b) => (a.generated_at < b.generated_at ? 1 : -1));

  if (execReports.length > 0) {
    const latest = execReports[0];
    console.log(`\n## Latest Execution Summary\n`);
    console.log(latest.content);
  } else {
    console.log(`\n_No execution reports yet. Run \`tavori run --goal ${goalId}\` to start._`);
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

  // Tree structure info
  if (goal.parent_id) {
    console.log(`\nParent:      ${goal.parent_id}`);
  }
  if (goal.node_type && goal.node_type !== "goal") {
    console.log(`Node type:   ${goal.node_type}`);
  }
  if (goal.children_ids && goal.children_ids.length > 0) {
    console.log(`Children:    ${goal.children_ids.length} subgoal(s)`);
    for (const childId of goal.children_ids) {
      const shortId = childId.substring(0, 8);
      let childTitle = "(error reading goal)";
      try {
        const childGoal = await stateManager.loadGoal(childId);
        if (childGoal) childTitle = childGoal.title;
        else childTitle = "(unknown)";
      } catch {
        // keep fallback title
      }
      console.log(`  - ${shortId}... — ${childTitle}`);
    }
  }

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
