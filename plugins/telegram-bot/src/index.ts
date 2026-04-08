import { loadConfig } from "./config.js";
import { TelegramAPI } from "./telegram-api.js";
import { TelegramNotifier, type INotifier } from "./notifier.js";
import { PollingLoop } from "./polling-loop.js";
import { ChatBridge } from "./chat-bridge.js";
import { TelegramChatEventAdapter } from "./telegram-chat-event-adapter.js";
import { TelegramChatRunnerProcessor, type ProcessMessageFn } from "./telegram-chat-runner-processor.js";
import type { ChatEventHandler } from "pulseed";

type LegacyProcessMessageFn = (text: string, emit: ChatEventHandler) => Promise<string | void> | string | void;

// ─── TelegramBotPlugin ───

export class TelegramBotPlugin {
  private readonly pluginDir: string;
  private api: TelegramAPI | null = null;
  private notifier: TelegramNotifier | null = null;
  private polling: PollingLoop | null = null;
  private bridge: ChatBridge | null = null;
  private processor: TelegramChatRunnerProcessor | null = null;

  constructor(pluginDir: string) {
    this.pluginDir = pluginDir;
  }

  async init(): Promise<void> {
    const config = loadConfig(this.pluginDir);

    this.api = new TelegramAPI(config.bot_token);

    // Verify credentials
    const botInfo = await this.api.getMe();
    console.log(`[telegram-bot] connected as @${botInfo.username} (id: ${botInfo.id})`);

    this.notifier = new TelegramNotifier(this.api, config.chat_id);

    this.processor = new TelegramChatRunnerProcessor(this.pluginDir);

    this.bridge = new ChatBridge(
      (text, chatId, emit) => this.processor!.processMessage(text, chatId, emit),
      (chatId) => new TelegramChatEventAdapter(this.api!, chatId)
    );

    const api = this.api;
    const bridge = this.bridge;

    this.polling = new PollingLoop(
      api,
      async (text, fromUserId, chatId) => {
        await bridge.handleMessage(text, fromUserId, chatId);
      },
      config.allowed_user_ids
    );
  }

  getNotifier(): INotifier | null {
    return this.notifier;
  }

  setMessageProcessor(
    processMessage: ProcessMessageFn | LegacyProcessMessageFn
  ): void {
    if (!this.bridge) return;
    this.bridge.setProcessMessage((text, chatId, emit) => {
      if (processMessage.length >= 3) {
        return (processMessage as ProcessMessageFn)(text, chatId, emit);
      }
      return (processMessage as LegacyProcessMessageFn)(text, emit);
    });
  }

  startPolling(): void {
    this.polling?.start();
  }

  stopPolling(): void {
    this.polling?.stop();
  }
}

// ─── Default export (required by PluginLoader) ───
//
// Returns an initialized TelegramNotifier for the PluginLoader's notifier registry.
// If config.json is missing or invalid, returns null (PluginLoader handles this gracefully).

const _pluginDir = process.env["TELEGRAM_PLUGIN_DIR"] ?? "";

let _defaultExport: INotifier | null = null;

if (_pluginDir) {
  try {
    const plugin = new TelegramBotPlugin(_pluginDir);
    await plugin.init();
    _defaultExport = plugin.getNotifier();
    plugin.startPolling();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[telegram-bot] init failed, plugin disabled: ${msg}`);
    _defaultExport = null;
  }
}

export default _defaultExport;
