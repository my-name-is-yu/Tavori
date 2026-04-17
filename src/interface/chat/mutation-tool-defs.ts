import type { StateManager } from "../../base/state/state-manager.js";
import type { ToolDefinition } from "../../base/llm/llm-client.js";
import type { PluginLoader } from "../../runtime/plugin-loader.js";
import {
  buildConfigToolDescription,
  buildMutationToolDescription,
} from "../../base/config/tool-metadata.js";

export type ApprovalLevel = "none" | "required";

export interface MutationToolDeps {
  stateManager: StateManager;
  trustManager?: {
    getBalance?(domain: string): Promise<{ balance: number }>;
    setOverride(domain: string, balance: number, reason: string): Promise<void>;
  };
  pluginLoader?: PluginLoader | {
    getPluginState?(name: string): unknown;
    updatePluginState?(name: string, state: unknown): Promise<void>;
    loadAll?(): Promise<Array<{ name: string; type?: string; enabled?: boolean }>>;
  };
  approvalFn?: (description: string) => Promise<boolean>;
  approvalConfig?: Record<string, ApprovalLevel>;
}

interface ApprovalResult {
  approved: boolean;
  error?: string;
}

const DEFAULT_APPROVAL_LEVELS: Record<string, ApprovalLevel> = {
  set_goal: "none",
  update_goal: "none",
  archive_goal: "required",
  delete_goal: "required",
  toggle_plugin: "required",
  update_config: "required",
  reset_trust: "required",
};

export async function checkApproval(
  toolName: string,
  description: string,
  deps: MutationToolDeps
): Promise<ApprovalResult> {
  const level = deps.approvalConfig?.[toolName] ?? DEFAULT_APPROVAL_LEVELS[toolName] ?? "required";
  if (level === "none") {
    return { approved: true };
  }

  if (!deps.approvalFn) {
    return {
      approved: false,
      error: "This operation requires approval but no approval handler is configured",
    };
  }

  const approved = await deps.approvalFn(description);
  return approved ? { approved: true } : { approved: false, error: "User denied the operation" };
}

/**
 * @deprecated Use ToolRegistry.listAll() + toToolDefinitions() instead.
 * This remains for older chat tests and external callers.
 */
export function getMutationToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "set_goal",
        description: "Create a new active goal from a user-provided description.",
        parameters: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "Goal description to create.",
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
        description: "Update a goal description or status. Use archive_goal for archiving.",
        parameters: {
          type: "object",
          properties: {
            goal_id: { type: "string", description: "Goal ID to update." },
            description: { type: "string", description: "Updated goal description." },
            status: {
              type: "string",
              enum: ["active", "paused", "completed"],
              description: "Updated goal status.",
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
        description: "Archive an existing goal after user approval.",
        parameters: {
          type: "object",
          properties: {
            goal_id: { type: "string", description: "Goal ID to archive." },
          },
          required: ["goal_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_goal",
        description: buildMutationToolDescription("delete_goal"),
        parameters: {
          type: "object",
          properties: {
            goal_id: { type: "string", description: "Goal ID to permanently delete." },
          },
          required: ["goal_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "toggle_plugin",
        description: "Enable or disable a plugin. This currently reports that chat-based plugin toggling is unsupported.",
        parameters: {
          type: "object",
          properties: {
            plugin_name: { type: "string", description: "Plugin name." },
            enabled: { type: "boolean", description: "Whether the plugin should be enabled." },
          },
          required: ["plugin_name", "enabled"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_config",
        description: buildConfigToolDescription(),
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Configuration key to update." },
            value: { description: "New configuration value." },
          },
          required: ["key", "value"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "reset_trust",
        description: "Set a trust balance override for a domain after explicit user approval.",
        parameters: {
          type: "object",
          properties: {
            domain: { type: "string", description: "Trust domain to override." },
            balance: {
              type: "number",
              minimum: -100,
              maximum: 100,
              description: "Trust balance from -100 to 100.",
            },
            reason: { type: "string", description: "Reason for the override." },
          },
          required: ["domain", "balance", "reason"],
        },
      },
    },
  ];
}
