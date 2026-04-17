import { configChangeRequiresApproval } from "../../base/config/config-metadata.js";
import { getConfigKeys, updateGlobalConfig } from "../../base/config/global-config.js";

export type { ApprovalLevel, MutationToolDeps } from "./mutation-tool-defs.js";
/**
 * @deprecated Use ToolRegistry.listAll() + toToolDefinitions() instead.
 */
export { getMutationToolDefinitions } from "./mutation-tool-defs.js";

import type { MutationToolDeps } from "./mutation-tool-defs.js";
import { checkApproval } from "./mutation-tool-defs.js";

// ─── Handlers ───

async function handleSetGoal(
  args: Record<string, unknown>,
  deps: MutationToolDeps
): Promise<string> {
  const description = args.description;
  if (typeof description !== "string" || !description.trim()) {
    return JSON.stringify({ error: "description is required and must be a non-empty string" });
  }

  const approval = await checkApproval("set_goal", `Create new goal: "${description}"`, deps);
  if (!approval.approved) {
    return JSON.stringify({ error: approval.error });
  }

  const now = new Date().toISOString();
  const goalId = crypto.randomUUID();

  const goal = {
    id: goalId,
    parent_id: null,
    node_type: "goal" as const,
    title: description.slice(0, 120),
    description,
    status: "active" as const,
    dimensions: [],
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
    loop_status: "idle" as const,
    created_at: now,
    updated_at: now,
  };

  try {
    await deps.stateManager.saveGoal(goal);
    return JSON.stringify({ success: true, goal_id: goalId, message: `Goal created: ${description}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: `Failed to create goal: ${message}` });
  }
}

async function handleUpdateGoal(
  args: Record<string, unknown>,
  deps: MutationToolDeps
): Promise<string> {
  const goalId = args.goal_id;
  if (typeof goalId !== "string" || !goalId.trim()) {
    return JSON.stringify({ error: "goal_id is required" });
  }

  if (args.status === "archived") {
    return JSON.stringify({ error: "Use archive_goal to archive a goal" });
  }

  const approval = await checkApproval("update_goal", `Update goal: ${goalId}`, deps);
  if (!approval.approved) {
    return JSON.stringify({ error: approval.error });
  }

  let goal;
  try {
    goal = await deps.stateManager.loadGoal(goalId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: `Failed to load goal: ${message}` });
  }

  if (!goal) {
    return JSON.stringify({ error: `Goal not found: ${goalId}` });
  }

  const updated = { ...goal, updated_at: new Date().toISOString() };

  if (typeof args.description === "string") {
    updated.description = args.description;
  }
  const validStatuses = ["active", "paused", "completed"];
  if (typeof args.status === "string" && validStatuses.includes(args.status)) {
    (updated as Record<string, unknown>).status = args.status;
  }

  try {
    await deps.stateManager.saveGoal(updated);
    return JSON.stringify({ success: true, goal_id: goalId, message: "Goal updated." });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: `Failed to update goal: ${message}` });
  }
}

async function handleArchiveGoal(
  args: Record<string, unknown>,
  deps: MutationToolDeps
): Promise<string> {
  const goalId = args.goal_id;
  if (typeof goalId !== "string" || !goalId.trim()) {
    return JSON.stringify({ error: "goal_id is required" });
  }

  const approval = await checkApproval("archive_goal", `Archive goal: ${goalId}`, deps);
  if (!approval.approved) {
    return JSON.stringify({ error: approval.error });
  }

  try {
    const archived = await deps.stateManager.archiveGoal(goalId);
    if (!archived) {
      return JSON.stringify({ error: `Goal not found: ${goalId}` });
    }
    return JSON.stringify({ success: true, goal_id: goalId, message: "Goal archived." });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: `Failed to archive goal: ${message}` });
  }
}

async function handleDeleteGoal(
  args: Record<string, unknown>,
  deps: MutationToolDeps
): Promise<string> {
  const goalId = args.goal_id;
  if (typeof goalId !== "string" || !goalId.trim()) {
    return JSON.stringify({ error: "goal_id is required" });
  }

  const approval = await checkApproval(
    "delete_goal",
    `Delete goal permanently: ${goalId}`,
    deps
  );
  if (!approval.approved) {
    return JSON.stringify({ error: approval.error });
  }

  try {
    const deleted = await deps.stateManager.deleteGoal(goalId);
    if (!deleted) {
      return JSON.stringify({ error: `Goal not found: ${goalId}` });
    }
    return JSON.stringify({ success: true, goal_id: goalId, message: "Goal deleted." });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: `Failed to delete goal: ${message}` });
  }
}

async function handleTogglePlugin(
  args: Record<string, unknown>,
  deps: MutationToolDeps
): Promise<string> {
  const pluginName = args.plugin_name;
  const enabled = args.enabled;

  if (typeof pluginName !== "string" || !pluginName.trim()) {
    return JSON.stringify({ error: "plugin_name is required" });
  }
  if (typeof enabled !== "boolean") {
    return JSON.stringify({ error: "enabled must be a boolean" });
  }

  const approval = await checkApproval(
    "toggle_plugin",
    `${enabled ? "Enable" : "Disable"} plugin: ${pluginName}`,
    deps
  );
  if (!approval.approved) {
    return JSON.stringify({ error: approval.error });
  }

  return JSON.stringify({
    error: "Plugin enable/disable is not yet supported via chat tools. Use CLI instead.",
  });
}

async function handleUpdateConfig(
  args: Record<string, unknown>,
  deps: MutationToolDeps
): Promise<string> {
  const key = args.key;
  const value = args.value;

  if (typeof key !== "string" || !key.trim()) {
    return JSON.stringify({ error: "key is required" });
  }
  if (value === undefined) {
    return JSON.stringify({ error: "value is required" });
  }

  // Validate key against known config keys
  const validKeys = getConfigKeys();
  if (!validKeys.includes(key)) {
    return JSON.stringify({
      error: `Unknown config key: "${key}". Available: ${validKeys.join(", ")}`,
    });
  }

  if (configChangeRequiresApproval(key)) {
    const level = deps.approvalConfig?.["update_config"] ?? "required";
    if (level === "required") {
      if (!deps.approvalFn) {
        return JSON.stringify({
          error: "This operation requires approval but no approval handler is configured",
        });
      }
      const approved = await deps.approvalFn(
        `Update high-impact config "${key}" to ${JSON.stringify(value)}`
      );
      if (!approved) {
        return JSON.stringify({ error: "User denied the operation" });
      }
    }
  }

  try {
    const updated = await updateGlobalConfig({ [key]: value });
    const newValue = (updated as Record<string, unknown>)[key];

    const { CONFIG_METADATA } = await import("../../base/config/config-metadata.js");
    const meta = CONFIG_METADATA[key];
    const timing = meta?.appliesAt === "next_session" ? "次回起動時" : "即座に";

    return JSON.stringify({
      success: true,
      key,
      value: newValue,
      message: `${key}を${JSON.stringify(newValue)}に変更しました。${timing}から適用されます。`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: `Failed to update config: ${message}` });
  }
}

async function handleResetTrust(
  args: Record<string, unknown>,
  deps: MutationToolDeps
): Promise<string> {
  const domain = args.domain;
  const balance = args.balance;
  const reason = args.reason;

  if (typeof domain !== "string" || !domain.trim()) {
    return JSON.stringify({ error: "domain is required" });
  }
  if (typeof balance !== "number" || balance < -100 || balance > 100) {
    return JSON.stringify({ error: "balance must be a number between -100 and 100" });
  }
  if (typeof reason !== "string" || !reason.trim()) {
    return JSON.stringify({ error: "reason is required" });
  }

  const approval = await checkApproval(
    "reset_trust",
    `Reset trust balance for domain "${domain}" to ${balance}: ${reason}`,
    deps
  );
  if (!approval.approved) {
    return JSON.stringify({ error: approval.error });
  }

  if (!deps.trustManager) {
    return JSON.stringify({ error: "Trust manager is not available" });
  }

  try {
    await deps.trustManager.setOverride(domain, balance, reason);
    return JSON.stringify({
      success: true,
      domain,
      balance,
      message: `Trust balance for domain "${domain}" set to ${balance}.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: `Failed to reset trust: ${message}` });
  }
}

// ─── Dispatcher ───

/**
 * @deprecated Use ToolRegistry.get(name).call() via ChatRunner instead.
 * This function is a backward-compatibility shim.
 */
export async function handleMutationToolCall(
  toolName: string,
  args: Record<string, unknown>,
  deps: MutationToolDeps
): Promise<string> {
  switch (toolName) {
    case "set_goal":
      return handleSetGoal(args, deps);
    case "update_goal":
      return handleUpdateGoal(args, deps);
    case "archive_goal":
      return handleArchiveGoal(args, deps);
    case "delete_goal":
      return handleDeleteGoal(args, deps);
    case "toggle_plugin":
      return handleTogglePlugin(args, deps);
    case "update_config":
      return handleUpdateConfig(args, deps);
    case "reset_trust":
      return handleResetTrust(args, deps);
    default:
      return JSON.stringify({ error: `Unknown mutation tool: ${toolName}` });
  }
}
