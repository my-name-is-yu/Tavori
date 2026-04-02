// ─── pulseed telegram setup — Telegram Bot plugin configuration wizard ───
//
// Guides the user through configuring the Telegram Bot plugin:
//   1. Bot token (from @BotFather) — verified via getMe API
//   2. chat_id (number) — instruct user to message the bot and use getUpdates
//   3. allowed_user_ids (optional, comma-separated)
//
// Writes config to ~/.pulseed/plugins/telegram-bot/config.json
// Copies plugin.yaml from the repo if available.

import * as readline from "node:readline";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getPulseedDirPath } from "../../utils/paths.js";

// ─── Readline helpers ───

function createInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

// ─── Telegram API verification ───

interface TelegramUser {
  id: number;
  username?: string;
  first_name: string;
}

interface TelegramGetMeResponse {
  ok: boolean;
  result?: TelegramUser;
  description?: string;
}

async function verifyBotToken(token: string): Promise<TelegramUser | null> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await resp.json()) as TelegramGetMeResponse;
    if (data.ok && data.result) {
      return data.result;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Plugin directory helpers ───

function getPluginDir(): string {
  return path.join(getPulseedDirPath(), "plugins", "telegram-bot");
}

async function ensurePluginDir(pluginDir: string): Promise<void> {
  await fsp.mkdir(pluginDir, { recursive: true });
}

async function copyPluginYaml(pluginDir: string): Promise<void> {
  // Resolve repo root relative to this compiled file (dist/cli/commands/telegram.js → project root)
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(thisFile), "..", "..", "..", "..");
  const repoYaml = path.join(repoRoot, "plugins", "telegram-bot", "plugin.yaml");

  const destYaml = path.join(pluginDir, "plugin.yaml");

  // Skip if already exists
  try {
    await fsp.access(destYaml);
    return;
  } catch {
    // does not exist yet — proceed
  }

  try {
    await fsp.copyFile(repoYaml, destYaml);
  } catch {
    // Write a minimal plugin.yaml as fallback
    const minimal = [
      "name: telegram-bot",
      "version: 1.0.0",
      'description: "Telegram Bot notifier plugin for PulSeed"',
      "main: src/index.js",
      "type: notifier",
      "notifier_id: telegram",
    ].join("\n") + "\n";
    await fsp.writeFile(destYaml, minimal, "utf8");
  }
}

// ─── Public entry point ───

export async function cmdTelegramSetup(_args: string[]): Promise<number> {
  console.log("\nPulSeed — Telegram Bot Setup\n");

  const rl = createInterface();

  try {
    // Step 1: Bot token
    console.log("Step 1: Bot token");
    console.log("  Create a bot via @BotFather on Telegram and copy the token.\n");

    const token = await ask(rl, "Enter bot token: ");
    if (!token) {
      console.error("Error: bot token cannot be empty.");
      return 1;
    }

    process.stdout.write("  Verifying token...");
    const botInfo = await verifyBotToken(token);
    if (!botInfo) {
      console.log(" failed.");
      console.error("Error: token verification failed. Check the token and try again.");
      return 1;
    }
    console.log(` OK (@${botInfo.username ?? botInfo.first_name})\n`);

    // Step 2: chat_id
    console.log("Step 2: Chat ID");
    console.log("  To find your chat_id:");
    console.log("    1. Send any message to your bot in Telegram.");
    console.log(`    2. Open: https://api.telegram.org/bot${token}/getUpdates`);
    console.log('    3. Copy the numeric "id" from result[0].message.chat.id');
    console.log("    Alternatively, forward a message to @userinfobot.\n");

    const chatIdStr = await ask(rl, "Enter chat_id (number): ");
    const chatId = parseInt(chatIdStr, 10);
    if (isNaN(chatId)) {
      console.error("Error: chat_id must be a number.");
      return 1;
    }

    // Step 3: allowed_user_ids (optional)
    console.log("\nStep 3: Allowed user IDs (optional)");
    console.log("  Comma-separated Telegram user IDs that may send commands to the bot.");
    console.log("  Leave empty to allow all users.\n");

    const allowedStr = await ask(rl, "Allowed user IDs (e.g. 123456,789012) or press Enter to skip: ");
    const allowedUserIds: number[] = [];
    if (allowedStr) {
      for (const part of allowedStr.split(",")) {
        const n = parseInt(part.trim(), 10);
        if (!isNaN(n)) {
          allowedUserIds.push(n);
        }
      }
    }

    // Step 4: Write config
    const pluginDir = getPluginDir();
    await ensurePluginDir(pluginDir);

    const config = {
      bot_token: token,
      chat_id: chatId,
      allowed_user_ids: allowedUserIds,
      polling_timeout: 30,
    };

    const configPath = path.join(pluginDir, "config.json");
    await fsp.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    await copyPluginYaml(pluginDir);

    // Summary
    console.log("\nTelegram Bot setup complete!");
    console.log(`  Config: ${configPath}`);
    console.log(`  Bot:    @${botInfo.username ?? botInfo.first_name}`);
    console.log(`  Chat:   ${chatId}`);
    if (allowedUserIds.length > 0) {
      console.log(`  Allowed users: ${allowedUserIds.join(", ")}`);
    } else {
      console.log("  Allowed users: (all)");
    }
    console.log("\nRun 'pulseed plugin install' to activate the plugin.");

    return 0;
  } finally {
    rl.close();
  }
}
