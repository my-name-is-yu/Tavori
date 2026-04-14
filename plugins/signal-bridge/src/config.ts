import * as fs from "node:fs";
import * as path from "node:path";

export interface SignalBridgeConfig {
  bridge_url: string;
  account: string;
  recipient_id: string;
  identity_key: string;
  allowed_sender_ids: string[];
  denied_sender_ids: string[];
  allowed_conversation_ids: string[];
  denied_conversation_ids: string[];
  runtime_control_allowed_sender_ids: string[];
  conversation_goal_map: Record<string, string>;
  sender_goal_map: Record<string, string>;
  default_goal_id?: string;
  poll_interval_ms: number;
  receive_timeout_ms: number;
}

export function loadConfig(pluginDir: string): SignalBridgeConfig {
  const configPath = path.join(pluginDir, "config.json");
  let raw: unknown;

  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`signal-bridge: failed to read config.json — ${msg}`);
  }

  return validateConfig(raw);
}

function validateConfig(raw: unknown): SignalBridgeConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("signal-bridge: config must be a JSON object");
  }

  const cfg = raw as Record<string, unknown>;
  const pollInterval = cfg["poll_interval_ms"] ?? 5000;
  const receiveTimeout = cfg["receive_timeout_ms"] ?? 2000;
  const runtimeControlAllowedSenderIds = cfg["runtime_control_allowed_sender_ids"] ?? [];
  const allowedSenderIds = cfg["allowed_sender_ids"] ?? cfg["allow_from"] ?? [];
  const deniedSenderIds = cfg["denied_sender_ids"] ?? cfg["deny_from"] ?? [];
  const allowedConversationIds = cfg["allowed_conversation_ids"] ?? [];
  const deniedConversationIds = cfg["denied_conversation_ids"] ?? [];
  const conversationGoalMap = cfg["conversation_goal_map"] ?? cfg["goal_routes"] ?? {};
  const senderGoalMap = cfg["sender_goal_map"] ?? {};

  if (typeof cfg["bridge_url"] !== "string" || cfg["bridge_url"].length === 0) {
    throw new Error("signal-bridge: bridge_url must be a non-empty string");
  }
  if (typeof cfg["account"] !== "string" || cfg["account"].length === 0) {
    throw new Error("signal-bridge: account must be a non-empty string");
  }
  if (typeof cfg["recipient_id"] !== "string" || cfg["recipient_id"].length === 0) {
    throw new Error("signal-bridge: recipient_id must be a non-empty string");
  }
  if (typeof cfg["identity_key"] !== "string" || cfg["identity_key"].length === 0) {
    throw new Error("signal-bridge: identity_key must be a non-empty string");
  }
  if (typeof pollInterval !== "number" || !Number.isInteger(pollInterval)) {
    throw new Error("signal-bridge: poll_interval_ms must be an integer");
  }
  if (typeof receiveTimeout !== "number" || !Number.isInteger(receiveTimeout)) {
    throw new Error("signal-bridge: receive_timeout_ms must be an integer");
  }
  if (
    !Array.isArray(runtimeControlAllowedSenderIds) ||
    !runtimeControlAllowedSenderIds.every((id) => typeof id === "string" && id.length > 0)
  ) {
    throw new Error("signal-bridge: runtime_control_allowed_sender_ids must be an array of non-empty strings");
  }
  for (const [key, value] of Object.entries({
    allowed_sender_ids: allowedSenderIds,
    denied_sender_ids: deniedSenderIds,
    allowed_conversation_ids: allowedConversationIds,
    denied_conversation_ids: deniedConversationIds,
  })) {
    if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0)) {
      throw new Error(`signal-bridge: ${key} must be an array of non-empty strings`);
    }
  }
  for (const [key, value] of Object.entries({
    conversation_goal_map: conversationGoalMap,
    sender_goal_map: senderGoalMap,
  })) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Object.values(value).every((goalId) => typeof goalId === "string" && goalId.length > 0)
    ) {
      throw new Error(`signal-bridge: ${key} must be an object mapping IDs to goal IDs`);
    }
  }
  if (cfg["default_goal_id"] !== undefined && (typeof cfg["default_goal_id"] !== "string" || cfg["default_goal_id"].length === 0)) {
    throw new Error("signal-bridge: default_goal_id must be a non-empty string when set");
  }

  return {
    bridge_url: cfg["bridge_url"] as string,
    account: cfg["account"] as string,
    recipient_id: cfg["recipient_id"] as string,
    identity_key: cfg["identity_key"] as string,
    allowed_sender_ids: allowedSenderIds as string[],
    denied_sender_ids: deniedSenderIds as string[],
    allowed_conversation_ids: allowedConversationIds as string[],
    denied_conversation_ids: deniedConversationIds as string[],
    runtime_control_allowed_sender_ids: runtimeControlAllowedSenderIds as string[],
    conversation_goal_map: conversationGoalMap as Record<string, string>,
    sender_goal_map: senderGoalMap as Record<string, string>,
    default_goal_id: cfg["default_goal_id"] as string | undefined,
    poll_interval_ms: Math.max(1000, pollInterval),
    receive_timeout_ms: Math.max(250, receiveTimeout),
  };
}
