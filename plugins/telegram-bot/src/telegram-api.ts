// ─── Types ───

export interface TelegramMessage {
  message_id: number;
  from: { id: number };
  chat: { id: number };
  text?: string;
}

interface SendMessageResult {
  message_id: number;
}

export interface Update {
  update_id: number;
  message?: TelegramMessage;
}

interface BotInfo {
  id: number;
  first_name: string;
  username: string;
}

// ─── TelegramAPI ───

export class TelegramAPI {
  private readonly baseUrl: string;

  constructor(botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  async getMe(): Promise<BotInfo> {
    const data = await this.call<BotInfo>("getMe");
    return data;
  }

  async getUpdates(offset: number, timeout: number): Promise<Update[]> {
    const data = await this.call<Update[]>("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message"],
    });
    return data;
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.sendMessageInternal(chatId, text, "Markdown");
  }

  async sendPlainMessage(chatId: number, text: string): Promise<number> {
    return this.sendMessageInternal(chatId, text, null);
  }

  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    const chunks = splitMessage(text, 4096);
    if (chunks.length === 0) return;

    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: chunks[0]!,
    });

    for (const chunk of chunks.slice(1)) {
      await this.call("sendMessage", {
        chat_id: chatId,
        text: chunk,
      });
    }
  }

  private async sendMessageInternal(chatId: number, text: string, parseMode: "Markdown" | null): Promise<number> {
    const chunks = splitMessage(text, 4096);
    let firstMessageId = -1;
    for (const [index, chunk] of chunks.entries()) {
      const result = await this.call<SendMessageResult>("sendMessage", {
        chat_id: chatId,
        text: chunk,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
      if (index === 0) {
        firstMessageId = result.message_id;
      }
    }
    return firstMessageId;
  }

  private async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}/${method}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: params !== undefined ? JSON.stringify(params) : undefined,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`telegram-api: ${method} returned ${response.status}: ${body}`);
    }

    const json = (await response.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) {
      throw new Error(`telegram-api: ${method} error: ${json.description ?? "unknown"}`);
    }

    return json.result;
  }
}

// ─── Helpers ───

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Find the last newline before the limit
    const slice = remaining.slice(0, maxLen);
    const lastNewline = slice.lastIndexOf("\n");
    const splitAt = lastNewline > 0 ? lastNewline + 1 : maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
