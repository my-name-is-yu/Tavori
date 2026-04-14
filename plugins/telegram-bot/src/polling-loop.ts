import type { TelegramAPI } from "./telegram-api.js";

// ─── Types ───

type OnMessageFn = (text: string, fromUserId: number, chatId: number) => Promise<void>;
interface PollingLoopOptions {
  allowedChatId?: number;
  allowedChatIds?: number[];
  deniedChatIds?: number[];
  deniedUserIds?: number[];
  allowAll?: boolean;
}

// ─── Backoff config ───

const BACKOFF_STEPS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];

// ─── PollingLoop ───

export class PollingLoop {
  private readonly api: TelegramAPI;
  private readonly onMessage: OnMessageFn;
  private readonly allowedUserIds: number[];
  private readonly allowedChatId: number | undefined;
  private readonly allowedChatIds: number[];
  private readonly deniedChatIds: number[];
  private readonly deniedUserIds: number[];
  private readonly allowAll: boolean;

  private running = false;
  private offset = 0;
  private abortController: AbortController | null = null;

  constructor(api: TelegramAPI, onMessage: OnMessageFn, allowedUserIds: number[], options: PollingLoopOptions) {
    this.api = api;
    this.onMessage = onMessage;
    this.allowedUserIds = allowedUserIds;
    this.allowedChatId = options.allowedChatId;
    this.allowedChatIds = options.allowedChatIds ?? [];
    this.deniedChatIds = options.deniedChatIds ?? [];
    this.deniedUserIds = options.deniedUserIds ?? [];
    this.allowAll = options.allowAll ?? false;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  private async loop(): Promise<void> {
    let backoffIndex = 0;

    while (this.running) {
      try {
        const updates = await this.api.getUpdates(this.offset, 30);
        backoffIndex = 0; // reset on success

        for (const update of updates) {
          this.offset = update.update_id + 1;

          const msg = update.message;
          if (!msg?.text) continue;

          const fromId = msg.from?.id;
          const chatId = msg.chat?.id;
          if (typeof fromId !== "number" || !Number.isInteger(fromId)) continue;
          if (typeof chatId !== "number" || !Number.isInteger(chatId)) continue;
          if (this.deniedUserIds.includes(fromId)) continue;
          if (this.deniedChatIds.includes(chatId)) continue;
          if (this.allowedChatId !== undefined && chatId !== this.allowedChatId) continue;
          if (this.allowedChatIds.length > 0 && !this.allowedChatIds.includes(chatId)) continue;

          if (!this.allowAll && !this.allowedUserIds.includes(fromId)) {
            continue;
          }

          await this.onMessage(msg.text, fromId, chatId);
        }
      } catch (err) {
        if (!this.running) break;

        const delay = BACKOFF_STEPS_MS[Math.min(backoffIndex, BACKOFF_STEPS_MS.length - 1)];
        backoffIndex++;

        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[telegram-bot] polling error (retry in ${delay}ms): ${msg}`);

        await sleep(delay);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
