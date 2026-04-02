// ─── Types ───

export interface TelegramMessage {
  message_id: number;
  from: { id: number };
  chat: { id: number };
  text?: string;
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
    const chunks = splitMessage(text, 4096);
    for (const chunk of chunks) {
      await this.call("sendMessage", {
        chat_id: chatId,
        text: chunk,
        parse_mode: "Markdown",
      });
    }
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
