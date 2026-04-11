import * as fs from "node:fs";
import * as path from "node:path";

export interface WhatsAppWebhookConfig {
  phone_number_id: string;
  access_token: string;
  verify_token: string;
  recipient_id: string;
  identity_key: string;
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

  return {
    phone_number_id: cfg["phone_number_id"] as string,
    access_token: cfg["access_token"] as string,
    verify_token: cfg["verify_token"] as string,
    recipient_id: cfg["recipient_id"] as string,
    identity_key: cfg["identity_key"] as string,
    host,
    port,
    path: pathValue,
    app_secret: cfg["app_secret"] as string | undefined,
  };
}
