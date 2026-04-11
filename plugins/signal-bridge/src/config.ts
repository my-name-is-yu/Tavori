import * as fs from "node:fs";
import * as path from "node:path";

export interface SignalBridgeConfig {
  bridge_url: string;
  account: string;
  recipient_id: string;
  identity_key: string;
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

  return {
    bridge_url: cfg["bridge_url"] as string,
    account: cfg["account"] as string,
    recipient_id: cfg["recipient_id"] as string,
    identity_key: cfg["identity_key"] as string,
    poll_interval_ms: Math.max(1000, pollInterval),
    receive_timeout_ms: Math.max(250, receiveTimeout),
  };
}
