import type { ToolDefinition } from "../llm/llm-client.js";

// ─── Approval ───

export type ApprovalLevel = "none" | "required";

export const DEFAULT_APPROVAL: Record<string, ApprovalLevel> = {
  set_goal: "none",
  update_goal: "none",
  archive_goal: "required",
  delete_goal: "required",
  toggle_plugin: "required",
  update_config: "required",
  reset_trust: "required",
};

// ─── Dependencies ───

import type { StateManager } from "../state/state-manager.js";
import type { TrustManager } from "../traits/trust-manager.js";
import type { PluginLoader } from "../runtime/plugin-loader.js";

export interface MutationToolDeps {
  stateManager: StateManager;
  trustManager?: TrustManager;
  pluginLoader?: PluginLoader;
  approvalFn?: (description: string) => Promise<boolean>;
  approvalConfig?: Record<string, ApprovalLevel>;
}

// ─── Approval Helper ───

export async function checkApproval(
  toolName: string,
  description: string,
  deps: MutationToolDeps
): Promise<{ approved: boolean; error?: string }> {
  const level = deps.approvalConfig?.[toolName] ?? DEFAULT_APPROVAL[toolName] ?? "required";

  if (level === "none") {
    return { approved: true };
  }

  // level === "required"
  if (!deps.approvalFn) {
    return {
      approved: false,
      error: "This operation requires approval but no approval handler is configured",
    };
  }

  const approved = await deps.approvalFn(description);
  if (!approved) {
    return { approved: false, error: "User denied the operation" };
  }

  return { approved: true };
}

// ─── Tool Definitions ───

export function getMutationToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "set_goal",
        description: "Create a new goal with the given description.",
        parameters: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "Goal description",
            },
          },
          required: ["description"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_goal",
        description: "Update fields on an existing goal (description or status).",
        parameters: {
          type: "object",
          properties: {
            goal_id: { type: "string" },
            description: { type: "string" },
            status: {
              type: "string",
              enum: ["active", "paused", "completed"],
            },
          },
          required: ["goal_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "archive_goal",
        description: "Archive a goal (moves it to archive storage). Requires user approval.",
        parameters: {
          type: "object",
          properties: {
            goal_id: { type: "string" },
          },
          required: ["goal_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_goal",
        description: "Permanently delete a goal and all its children. Requires user approval.",
        parameters: {
          type: "object",
          properties: {
            goal_id: { type: "string" },
          },
          required: ["goal_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "toggle_plugin",
        description: "Enable or disable a plugin by name. Requires user approval.",
        parameters: {
          type: "object",
          properties: {
            plugin_name: { type: "string" },
            enabled: { type: "boolean" },
          },
          required: ["plugin_name", "enabled"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_config",
        description: "Update provider configuration (provider, model, or api_key). Requires user approval.",
        parameters: {
          type: "object",
          properties: {
            provider: { type: "string" },
            model: { type: "string" },
            api_key: { type: "string" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "reset_trust",
        description: "Override the trust balance for a domain. Requires user approval.",
        parameters: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Trust domain to reset",
            },
            balance: {
              type: "number",
              description: "New trust balance (-100 to 100)",
            },
            reason: {
              type: "string",
              description: "Reason for reset",
            },
          },
          required: ["domain", "balance", "reason"],
        },
      },
    },
  ];
}
