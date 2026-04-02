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
  private readonly chatId: number;

  constructor(api: TelegramAPI, chatId: number) {
    this.api = api;
    this.chatId = chatId;
  }

  supports(_eventType: string): boolean {
    return true;
  }

  async notify(event: NotificationEvent): Promise<void> {
    const text = formatNotification(event);
    await this.api.sendMessage(this.chatId, text);
  }
}
