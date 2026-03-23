// ─── goal-raw.ts: cmdGoalAddRaw — add a goal without LLM negotiation ───

import { StateManager } from "../../state-manager.js";
import { getCliLogger } from "../cli-logger.js";
import {
  RawDimensionSpec,
  parseRawDim,
  buildThreshold,
  autoRegisterFileExistenceDataSources,
  autoRegisterShellDataSources,
} from "./goal-utils.js";

export async function cmdGoalAddRaw(
  stateManager: StateManager,
  opts: { title?: string; description?: string; rawDimensions: string[]; parent_id?: string }
): Promise<number> {
  const title = opts.title || opts.description;
  if (!title) {
    getCliLogger().error("Error: --title or description is required for raw goal add.");
    return 1;
  }

  // Parse and validate all dim specs upfront
  const dimSpecs: RawDimensionSpec[] = [];
  for (const raw of opts.rawDimensions) {
    const spec = parseRawDim(raw);
    if (!spec) {
      getCliLogger().error(`Error: invalid --dim format "${raw}". Expected "name:type:value" (e.g. "tsc_error_count:min:0")`);
      return 1;
    }
    const threshold = buildThreshold(spec);
    if (!threshold) {
      getCliLogger().error(`Error: invalid value in --dim "${raw}". Check type/value combination.`);
      return 1;
    }
    dimSpecs.push(spec);
  }

  const now = new Date().toISOString();
  const goalId = `goal_${Date.now()}`;

  const dimensions = dimSpecs.map((spec) => {
    const threshold = buildThreshold(spec)!;
    return {
      name: spec.name,
      label: spec.name.replace(/_/g, " "),
      current_value: null,
      threshold,
      confidence: 0,
      observation_method: {
        type: "mechanical" as const,
        source: "auto",
        schedule: null,
        endpoint: null,
        confidence_tier: "mechanical" as const,
      },
      last_updated: null,
      history: [],
      weight: 1.0,
      uncertainty_weight: null,
      state_integrity: "ok" as const,
      dimension_mapping: null,
    };
  });

  const goal = {
    id: goalId,
    parent_id: opts.parent_id ?? null,
    node_type: "goal" as const,
    title,
    description: opts.description || title,
    status: "active" as const,
    loop_status: "idle" as const,
    dimensions,
    gap_aggregation: "max" as const,
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: "manual" as const,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: 0,
    specificity_score: null,
    created_at: now,
    updated_at: now,
  };

  await stateManager.saveGoal(goal);

  if (opts.parent_id) {
    const parent = await stateManager.loadGoal(opts.parent_id);
    if (parent) {
      await stateManager.saveGoal({
        ...parent,
        children_ids: [...parent.children_ids, goalId],
        updated_at: now,
      });
    } else {
      getCliLogger().warn(`Warning: parent goal not found: ${opts.parent_id}. Goal saved without parent link.`);
    }
  }

  await autoRegisterFileExistenceDataSources(stateManager, dimensions, title, goalId);
  await autoRegisterShellDataSources(stateManager, dimensions, goalId);

  console.log(`Goal registered successfully!`);
  console.log(`Goal ID:    ${goalId}`);
  console.log(`Title:      ${title}`);
  console.log(`Status:     active`);
  console.log(`Dimensions: ${dimensions.length}`);

  if (dimensions.length > 0) {
    console.log(`\nDimensions:`);
    for (const dim of dimensions) {
      console.log(`  - ${dim.label} (${dim.name}): ${JSON.stringify(dim.threshold)}`);
    }
  }

  console.log(`\nTo run the loop: tavori run --goal ${goalId}`);
  return 0;
}
