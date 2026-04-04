import { loadProviderConfig, saveProviderConfig } from "../base/llm/provider-config.js";

export type { ApprovalLevel, MutationToolDeps } from "./mutation-tool-defs.js";
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

  const approval = await checkApproval("delete_goal", `Permanently delete goal: ${goalId}`, deps);
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
  const hasAnyField =
    typeof args.provider === "string" ||
    typeof args.model === "string" ||
    typeof args.api_key === "string";

  if (!hasAnyField) {
    return JSON.stringify({ error: "At least one field (provider, model, api_key) is required" });
  }

  const approval = await checkApproval(
    "update_config",
    "Update provider configuration",
    deps
  );
  if (!approval.approved) {
    return JSON.stringify({ error: approval.error });
  }

  try {
    const current = await loadProviderConfig();
    const updated = { ...current };

    if (typeof args.provider === "string") {
      const validProviders = ["openai", "anthropic", "ollama"];
      if (!validProviders.includes(args.provider)) {
        return JSON.stringify({
          error: `Invalid provider: ${args.provider}. Must be one of: ${validProviders.join(", ")}`,
        });
      }
      updated.provider = args.provider as typeof updated.provider;
    }
    if (typeof args.model === "string") {
      updated.model = args.model;
    }
    if (typeof args.api_key === "string") {
      updated.api_key = args.api_key;
    }

    await saveProviderConfig(updated);

    const changed: Record<string, string> = {};
    if (typeof args.provider === "string") changed.provider = args.provider;
    if (typeof args.model === "string") changed.model = args.model;
    if (typeof args.api_key === "string") changed.api_key_updated = "true";

    return JSON.stringify({ success: true, updated_fields: changed, message: "Provider configuration updated." });
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
