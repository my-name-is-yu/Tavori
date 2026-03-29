// ─── pulseed goal write commands (state-modifying) ───

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getReportsDir, getDatasourcesDir } from "../../utils/paths.js";
import { readJsonFile } from "../../utils/json-io.js";

import { StateManager } from "../../state-manager.js";
import { CharacterConfigManager } from "../../traits/character-config.js";
import { ensureProviderConfig } from "../ensure-api-key.js";
import { EthicsRejectedError } from "../../goal/goal-negotiator.js";
import { collectLeafGoalIds } from "../../goal/goal-refiner.js";
import { buildDeps } from "../setup.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import {
  autoRegisterFileExistenceDataSources,
  autoRegisterShellDataSources,
} from "./goal-utils.js";
import { cmdDatasourceDedup } from "./config.js";
import type { RefineResult } from "../../types/goal-refiner.js";

// ─── Display helpers ───

function printRefineResult(result: RefineResult, indent = 0): void {
  const pad = "  ".repeat(indent);
  const { goal } = result;
  console.log(`${pad}Goal ID:    ${goal.id}`);
  console.log(`${pad}Title:      ${goal.title}`);
  console.log(`${pad}Status:     ${goal.status}`);
  console.log(`${pad}Leaf:       ${result.leaf}`);
  console.log(`${pad}Reason:     ${result.reason}`);
  if (goal.dimensions.length > 0) {
    console.log(`${pad}Dimensions:`);
    for (const dim of goal.dimensions) {
      console.log(`${pad}  - ${dim.label} (${dim.name}): ${JSON.stringify(dim.threshold)}`);
    }
  }
  if (result.feasibility && result.feasibility.length > 0) {
    console.log(`${pad}Feasibility:`);
    for (const f of result.feasibility) {
      console.log(`${pad}  - ${f.dimension}: ${f.assessment} (${f.reasoning.slice(0, 80)}...)`);
    }
  }
  if (result.children && result.children.length > 0) {
    console.log(`${pad}Children (${result.children.length}):`);
    for (const child of result.children) {
      printRefineResult(child, indent + 1);
    }
  }
}

export async function cmdGoalAdd(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  description: string,
  opts: { deadline?: string; constraints?: string[]; yes?: boolean; noRefine?: boolean }
): Promise<number> {
  try {
    await ensureProviderConfig();
  } catch (err) {
    getCliLogger().error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let deps: Awaited<ReturnType<typeof buildDeps>>;
  try {
    deps = await buildDeps(stateManager, characterConfigManager);
  } catch (err) {
    getCliLogger().error(formatOperationError("initialise goal refinement dependencies", err));
    return 1;
  }

  const { goalNegotiator } = deps;

  // --no-refine: skip refinement, use legacy negotiate() path
  if (opts.noRefine) {
    return cmdGoalAddLegacyNegotiate(stateManager, goalNegotiator, description, opts);
  }

  // Default: use GoalRefiner.refine()
  console.log(`Refining goal: "${description}"`);
  if (opts.deadline) {
    console.log(`Deadline: ${opts.deadline}`);
  }
  if (opts.constraints && opts.constraints.length > 0) {
    console.log(`Constraints: ${opts.constraints.join(", ")}`);
  }
  console.log("This may take a moment...\n");

  // Build a stub goal so refiner has something to work with
  const now = new Date().toISOString();
  const goalId = `goal_${Date.now()}`;
  const stubGoal = {
    id: goalId,
    parent_id: null,
    node_type: "goal" as const,
    title: description.slice(0, 120),
    description,
    status: "active" as const,
    loop_status: "idle" as const,
    dimensions: [],
    gap_aggregation: "max" as const,
    dimension_mapping: null,
    constraints: opts.constraints ?? [],
    children_ids: [],
    target_date: opts.deadline ?? null,
    origin: "negotiation" as const,
    pace_snapshot: null,
    deadline: opts.deadline ?? null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: 0,
    specificity_score: null,
    created_at: now,
    updated_at: now,
  };
  await stateManager.saveGoal(stubGoal);

  const { goalRefiner: refiner } = deps;

  let result: RefineResult;
  try {
    result = await refiner.refine(goalId, { feasibilityCheck: true });
  } catch (err) {
    if (err instanceof EthicsRejectedError) {
      getCliLogger().error(formatOperationError(`refine goal "${description}" via ethics gate`, err));
      getCliLogger().error(`Ethics gate reasoning: ${err.verdict.reasoning}`);
      await stateManager.deleteGoal(goalId).catch(() => {});
      return 1;
    }
    getCliLogger().warn(`[goal add] Refinement failed, saving goal without refinement: ${err instanceof Error ? err.message : String(err)}`);
    // Graceful fallback: goal stub was already saved, register as-is
    console.log(`Goal registered (unrefined — refinement failed).`);
    console.log(`Goal ID:    ${goalId}`);
    console.log(`Title:      ${stubGoal.title}`);
    console.log(`\nTo run the loop: pulseed run --goal ${goalId}`);
    return 0;
  }

  // Auto-register data sources for all leaf goals
  const leafIds = collectLeafGoalIds(result);
  for (const leafId of leafIds) {
    const leafGoal = await stateManager.loadGoal(leafId);
    if (leafGoal && leafGoal.dimensions.length > 0) {
      await autoRegisterFileExistenceDataSources(stateManager, leafGoal.dimensions, leafGoal.description, leafId);
      await autoRegisterShellDataSources(stateManager, leafGoal.dimensions, leafId);
    }
  }

  console.log(`Goal registered successfully!`);
  console.log(`Tokens used: ${result.tokensUsed}`);
  console.log();
  printRefineResult(result);

  const runId = result.leaf ? result.goal.id : goalId;
  console.log(`\nTo run the loop: pulseed run --goal ${runId}${!result.leaf ? " --tree" : ""}`);
  return 0;
}

// ─── Legacy negotiate path (--no-refine) ───

async function cmdGoalAddLegacyNegotiate(
  stateManager: StateManager,
  goalNegotiator: import("../../goal/goal-negotiator.js").GoalNegotiator,
  description: string,
  opts: { deadline?: string; constraints?: string[]; yes?: boolean }
): Promise<number> {
  const { gatherNegotiationContext } = await import("../../goal/goal-negotiator.js");

  console.log(`Negotiating goal (legacy): "${description}"`);
  if (opts.deadline) console.log(`Deadline: ${opts.deadline}`);
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
        const { promptYesNo } = await import("../utils.js");
        accepted = await promptYesNo("\nAccept this counter-proposal and register the goal? [y/N] ");
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

    console.log(`\nTo run the loop: pulseed run --goal ${goal.id}`);
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
  console.log(`\nRun \`pulseed run --goal ${goalId}\` to restart the loop.`);

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

  if (goal.status !== "completed" && goal.status !== "archived") {
    await stateManager.saveGoal({
      ...goal,
      status: "abandoned",
      updated_at: new Date().toISOString(),
    });
  }

  const archived = await stateManager.archiveGoal(goalId);
  if (!archived) {
    getCliLogger().error(`Error: Failed to archive goal "${goalId}".`);
    return 1;
  }

  console.log(`Goal "${goalId}" archived successfully.`);
  console.log(`  Title:  ${goal.title}`);
  console.log(`  Status: archived`);
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
    console.log("(These can be removed manually from ~/.pulseed/reports/)");
  }

  // Remove orphaned datasources (scoped to deleted goals)
  const datasourcesDir = getDatasourcesDir(baseDir);
  let datasourcesDirExists = false;
  try { await fsp.access(datasourcesDir); datasourcesDirExists = true; } catch { /* not found */ }

  if (datasourcesDirExists) {
    let orphanedCount = 0;
    try {
      const dsFiles = (await fsp.readdir(datasourcesDir)).filter((f) => f.endsWith(".json"));
      for (const file of dsFiles) {
        const filePath = path.join(datasourcesDir, file);
        try {
          const raw = JSON.parse(await fsp.readFile(filePath, "utf-8")) as { scope_goal_id?: string };
          if (raw.scope_goal_id && !activeGoalIds.has(raw.scope_goal_id)) {
            await fsp.unlink(filePath);
            orphanedCount++;
          }
        } catch (err) {
          getCliLogger().error(formatOperationError(`read datasource "${file}"`, err));
        }
      }
    } catch (err) {
      getCliLogger().error(formatOperationError(`scan datasources directory "${datasourcesDir}"`, err));
    }
    if (orphanedCount > 0) {
      console.log(`\nRemoved ${orphanedCount} orphaned datasource(s) for deleted goals.`);
    }
  }

  // Deduplicate datasources
  await cmdDatasourceDedup(stateManager);

  return 0;
}
