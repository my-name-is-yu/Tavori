import type { TelegramAPI } from "./telegram-api.js";
import { formatNotification, type NotificationEvent } from "./message-formatter.js";

// ─── Local INotifier interface (mirrors pulseed INotifier) ───

export interface INotifier {
  name: string;
  notify(event: NotificationEvent): Promise<void>;
  supports(eventType: string): boolean;
}

// ─── TelegramNotifier ───

export class TelegramNotifier implements INotifier {
  readonly name = "telegram-bot";

  private readonly api: TelegramAPI;
  private readonly resolveChatId: () => number | undefined;

  constructor(api: TelegramAPI, chatId: number | (() => number | undefined)) {
    this.api = api;
    this.resolveChatId = typeof chatId === "function" ? chatId : () => chatId;
  }

  supports(_eventType: string): boolean {
    return true;
  }

  async notify(event: NotificationEvent): Promise<void> {
    const chatId = this.resolveChatId();
    if (chatId === undefined) {
      throw new Error("telegram-bot: no home chat configured. Send /sethome to the bot from the target Telegram chat.");
    }
    const text = formatNotification(event);
    await this.api.sendMessage(chatId, text);
  }
}
