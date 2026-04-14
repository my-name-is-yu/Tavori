import * as fs from "node:fs";
import * as path from "node:path";

export interface WhatsAppWebhookConfig {
  phone_number_id: string;
  access_token: string;
  verify_token: string;
  recipient_id: string;
  identity_key: string;
  allowed_sender_ids: string[];
  denied_sender_ids: string[];
  runtime_control_allowed_sender_ids: string[];
  sender_goal_map: Record<string, string>;
  default_goal_id?: string;
  host: string;
  port: number;
  path: string;
  app_secret?: string;
}

export function loadConfig(pluginDir: string): WhatsAppWebhookConfig {
  const configPath = path.join(pluginDir, "config.json");
  let raw: unknown;

  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`whatsapp-webhook: failed to read config.json — ${msg}`);
  }

  return validateConfig(raw);
}

function validateConfig(raw: unknown): WhatsAppWebhookConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("whatsapp-webhook: config must be a JSON object");
  }

  const cfg = raw as Record<string, unknown>;
  const host = cfg["host"] ?? "127.0.0.1";
  const port = cfg["port"] ?? 8788;
  const pathValue = cfg["path"] ?? "/webhook";
  const runtimeControlAllowedSenderIds = cfg["runtime_control_allowed_sender_ids"] ?? [];
  const allowedSenderIds = cfg["allowed_sender_ids"] ?? cfg["allow_from"] ?? [];
  const deniedSenderIds = cfg["denied_sender_ids"] ?? cfg["deny_from"] ?? [];
  const senderGoalMap = cfg["sender_goal_map"] ?? cfg["goal_routes"] ?? {};

  if (typeof cfg["phone_number_id"] !== "string" || cfg["phone_number_id"].length === 0) {
    throw new Error("whatsapp-webhook: phone_number_id must be a non-empty string");
  }
  if (typeof cfg["access_token"] !== "string" || cfg["access_token"].length === 0) {
    throw new Error("whatsapp-webhook: access_token must be a non-empty string");
  }
  if (typeof cfg["verify_token"] !== "string" || cfg["verify_token"].length === 0) {
    throw new Error("whatsapp-webhook: verify_token must be a non-empty string");
  }
  if (typeof cfg["recipient_id"] !== "string" || cfg["recipient_id"].length === 0) {
    throw new Error("whatsapp-webhook: recipient_id must be a non-empty string");
  }
  if (typeof cfg["identity_key"] !== "string" || cfg["identity_key"].length === 0) {
    throw new Error("whatsapp-webhook: identity_key must be a non-empty string");
  }
  if (typeof host !== "string" || host.length === 0) {
    throw new Error("whatsapp-webhook: host must be a non-empty string");
  }
  if (typeof port !== "number" || !Number.isInteger(port)) {
    throw new Error("whatsapp-webhook: port must be an integer");
  }
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    throw new Error("whatsapp-webhook: path must be a non-empty string");
  }
  if (cfg["app_secret"] !== undefined && typeof cfg["app_secret"] !== "string") {
    throw new Error("whatsapp-webhook: app_secret must be a string when set");
  }
  if (
    !Array.isArray(runtimeControlAllowedSenderIds) ||
    !runtimeControlAllowedSenderIds.every((id) => typeof id === "string" && id.length > 0)
  ) {
    throw new Error("whatsapp-webhook: runtime_control_allowed_sender_ids must be an array of non-empty strings");
  }
  for (const [key, value] of Object.entries({
    allowed_sender_ids: allowedSenderIds,
    denied_sender_ids: deniedSenderIds,
  })) {
    if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0)) {
      throw new Error(`whatsapp-webhook: ${key} must be an array of non-empty strings`);
    }
  }
  if (
    typeof senderGoalMap !== "object" ||
    senderGoalMap === null ||
    Array.isArray(senderGoalMap) ||
    !Object.values(senderGoalMap).every((goalId) => typeof goalId === "string" && goalId.length > 0)
  ) {
    throw new Error("whatsapp-webhook: sender_goal_map must be an object mapping IDs to goal IDs");
  }
  if (cfg["default_goal_id"] !== undefined && (typeof cfg["default_goal_id"] !== "string" || cfg["default_goal_id"].length === 0)) {
    throw new Error("whatsapp-webhook: default_goal_id must be a non-empty string when set");
  }

  return {
    phone_number_id: cfg["phone_number_id"] as string,
    access_token: cfg["access_token"] as string,
    verify_token: cfg["verify_token"] as string,
    recipient_id: cfg["recipient_id"] as string,
    identity_key: cfg["identity_key"] as string,
    allowed_sender_ids: allowedSenderIds as string[],
    denied_sender_ids: deniedSenderIds as string[],
    runtime_control_allowed_sender_ids: runtimeControlAllowedSenderIds as string[],
    sender_goal_map: senderGoalMap as Record<string, string>,
    default_goal_id: cfg["default_goal_id"] as string | undefined,
    host,
    port,
    path: pathValue,
    app_secret: cfg["app_secret"] as string | undefined,
  };
}
