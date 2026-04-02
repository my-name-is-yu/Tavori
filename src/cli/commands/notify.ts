// ─── pulseed notify commands (add, list, remove, test) ───

import { parseArgs } from "node:util";
import * as path from "node:path";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../utils/json-io.js";
import { NotificationConfigSchema } from "../../types/notification.js";
import type { NotificationConfig, NotificationChannel } from "../../types/notification.js";
import { getPulseedDirPath } from "../../utils/paths.js";

function getNotificationConfigPath(baseDir?: string): string {
  return path.join(baseDir ?? getPulseedDirPath(), "notification.json");
}

async function loadConfig(configPath: string): Promise<NotificationConfig> {
  const raw = await readJsonFileOrNull(configPath);
  if (raw === null) {
    return NotificationConfigSchema.parse({});
  }
  const result = NotificationConfigSchema.safeParse(raw);
  if (!result.success) {
    console.error(`Warning: notification config has invalid format, resetting. (${result.error.message})`);
    return NotificationConfigSchema.parse({});
  }
  return result.data;
}

async function saveConfig(configPath: string, config: NotificationConfig): Promise<void> {
  await writeJsonFileAtomic(configPath, config);
}

function formatChannel(ch: NotificationChannel, index: number): string {
  let detail = "";
  if (ch.type === "slack") {
    detail = `webhook: ${ch.webhook_url}`;
  } else if (ch.type === "webhook") {
    detail = `url: ${ch.url}`;
  } else if (ch.type === "email") {
    detail = `address: ${ch.address}, smtp: ${ch.smtp.host}:${ch.smtp.port}`;
  }

  const reports =
    ch.report_types.length > 0 ? ` (reports: ${ch.report_types.join(", ")})` : "";

  return `[${index}] ${ch.type.padEnd(7)} — ${detail}${reports}`;
}

async function cmdNotifyAdd(args: string[], configPath: string): Promise<number> {
  const positionals = args.filter((a) => !a.startsWith("-"));
  const channelType = positionals[0];

  if (!channelType) {
    console.error("Usage: pulseed notify add <slack|webhook|email> [options]");
    return 1;
  }

  if (channelType === "slack") {
    let values: { "webhook-url"?: string };
    try {
      ({ values } = parseArgs({
        args,
        options: {
          "webhook-url": { type: "string" },
        },
        strict: false,
      }) as { values: { "webhook-url"?: string } });
    } catch {
      values = {};
    }

    if (!values["webhook-url"]) {
      console.error("Error: --webhook-url is required for slack channel");
      return 1;
    }

    const config = await loadConfig(configPath);
    const channel: NotificationChannel = {
      type: "slack",
      webhook_url: values["webhook-url"],
      report_types: [],
      format: "compact",
    };
    config.channels.push(channel);
    await saveConfig(configPath, config);
    console.log(`Added slack channel (index ${config.channels.length - 1})`);
    return 0;
  }

  if (channelType === "webhook") {
    let values: { url?: string; header?: string[] };
    try {
      ({ values } = parseArgs({
        args,
        options: {
          url: { type: "string" },
          header: { type: "string", multiple: true },
        },
        strict: false,
      }) as { values: { url?: string; header?: string[] } });
    } catch {
      values = {};
    }

    if (!values.url) {
      console.error("Error: --url is required for webhook channel");
      return 1;
    }

    const headers: Record<string, string> = {};
    for (const h of values.header ?? []) {
      const colonIdx = h.indexOf(":");
      if (colonIdx === -1) {
        console.error(`Error: invalid header format "${h}", expected "Key: Value"`);
        return 1;
      }
      const key = h.slice(0, colonIdx).trim();
      const val = h.slice(colonIdx + 1).trim();
      headers[key] = val;
    }

    const config = await loadConfig(configPath);
    const channel: NotificationChannel = {
      type: "webhook",
      url: values.url,
      report_types: [],
      format: "json",
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
    config.channels.push(channel);
    await saveConfig(configPath, config);
    console.log(`Added webhook channel (index ${config.channels.length - 1})`);
    return 0;
  }

  if (channelType === "email") {
    let values: { address?: string; "smtp-host"?: string; "smtp-port"?: string };
    try {
      ({ values } = parseArgs({
        args,
        options: {
          address: { type: "string" },
          "smtp-host": { type: "string" },
          "smtp-port": { type: "string" },
        },
        strict: false,
      }) as { values: { address?: string; "smtp-host"?: string; "smtp-port"?: string } });
    } catch {
      values = {};
    }

    if (!values.address) {
      console.error("Error: --address is required for email channel");
      return 1;
    }
    if (!values["smtp-host"]) {
      console.error("Error: --smtp-host is required for email channel");
      return 1;
    }

    const smtpPort = values["smtp-port"] ? parseInt(values["smtp-port"], 10) : 587;
    if (isNaN(smtpPort) || smtpPort <= 0) {
      console.error("Error: --smtp-port must be a positive integer");
      return 1;
    }

    const config = await loadConfig(configPath);
    const channel: NotificationChannel = {
      type: "email",
      address: values.address,
      smtp: {
        host: values["smtp-host"],
        port: smtpPort,
        secure: true,
        auth: { user: "", pass: "" },
      },
      report_types: [],
      format: "full",
    };
    config.channels.push(channel);
    await saveConfig(configPath, config);
    console.log(`Added email channel (index ${config.channels.length - 1})`);
    return 0;
  }

  console.error(`Error: unknown channel type "${channelType}". Use: slack, webhook, email`);
  return 1;
}

async function cmdNotifyList(configPath: string): Promise<number> {
  const config = await loadConfig(configPath);

  if (config.channels.length === 0) {
    console.log("No channels configured");
    return 0;
  }

  console.log("Notification Channels:");
  for (let i = 0; i < config.channels.length; i++) {
    console.log(formatChannel(config.channels[i]!, i));
  }
  return 0;
}

async function cmdNotifyRemove(args: string[], configPath: string): Promise<number> {
  const indexStr = args[0];
  if (!indexStr) {
    console.error("Usage: pulseed notify remove <index>");
    return 1;
  }

  const index = parseInt(indexStr, 10);
  if (isNaN(index) || index < 0) {
    console.error("Error: index must be a non-negative integer");
    return 1;
  }

  const config = await loadConfig(configPath);

  if (index >= config.channels.length) {
    console.error(
      `Error: index ${index} out of bounds (${config.channels.length} channel(s) configured)`
    );
    return 1;
  }

  const removed = config.channels.splice(index, 1)[0]!;
  await saveConfig(configPath, config);
  console.log(`Removed ${removed.type} channel at index ${index}`);
  return 0;
}

async function cmdNotifyTest(args: string[], configPath: string): Promise<number> {
  const config = await loadConfig(configPath);

  if (config.channels.length === 0) {
    console.log("No channels configured");
    return 0;
  }

  const indexStr = args[0];
  let targets: { index: number; channel: NotificationChannel }[];

  if (indexStr !== undefined) {
    const index = parseInt(indexStr, 10);
    if (isNaN(index) || index < 0) {
      console.error("Error: index must be a non-negative integer");
      return 1;
    }
    if (index >= config.channels.length) {
      console.error(
        `Error: index ${index} out of bounds (${config.channels.length} channel(s) configured)`
      );
      return 1;
    }
    targets = [{ index, channel: config.channels[index]! }];
  } else {
    targets = config.channels.map((ch, i) => ({ index: i, channel: ch }));
  }

  const testPayload = {
    type: "test",
    message: "PulSeed notification test",
    timestamp: new Date().toISOString(),
  };

  console.log("Test notification payload (dry-run — daemon must be running for actual delivery):");
  console.log(JSON.stringify(testPayload, null, 2));
  console.log("");

  for (const { index, channel } of targets) {
    console.log(`[${index}] ${channel.type} — would send to:`);
    if (channel.type === "slack") {
      console.log(`  webhook_url: ${channel.webhook_url}`);
    } else if (channel.type === "webhook") {
      console.log(`  url: ${channel.url}`);
      if (channel.headers && Object.keys(channel.headers).length > 0) {
        for (const [k, v] of Object.entries(channel.headers)) {
          console.log(`  header: ${k}: ${v}`);
        }
      }
    } else if (channel.type === "email") {
      console.log(`  address: ${channel.address}`);
      console.log(`  smtp: ${channel.smtp.host}:${channel.smtp.port}`);
    }
  }

  return 0;
}

export async function cmdNotify(args: string[]): Promise<number> {
  const subcommand = args[0];
  const rest = args.slice(1);
  const configPath = getNotificationConfigPath();

  switch (subcommand) {
    case "add":
      return cmdNotifyAdd(rest, configPath);

    case "list":
      return cmdNotifyList(configPath);

    case "remove":
      return cmdNotifyRemove(rest, configPath);

    case "test":
      return cmdNotifyTest(rest, configPath);

    default:
      console.error(
        "Usage: pulseed notify <add|list|remove|test>\n" +
          "  add slack --webhook-url <url>\n" +
          "  add webhook --url <url> [--header 'Key: Value']\n" +
          "  add email --address <email> --smtp-host <host> [--smtp-port <port>]\n" +
          "  list\n" +
          "  remove <index>\n" +
          "  test [index]"
      );
      return 1;
  }
}
