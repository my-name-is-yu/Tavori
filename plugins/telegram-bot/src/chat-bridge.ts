// ─── ChatBridge ───
//
import type { ChatEvent, ChatEventHandler } from "pulseed";
import { TelegramChatEventAdapter } from "./telegram-chat-event-adapter.js";

// Thin adapter between the Telegram polling loop and the message processor.
// Processors may emit chat events via the provided handler.

type ProcessMessageFn = (text: string, chatId: number, emit: ChatEventHandler) => Promise<string | void> | string | void;

export class ChatBridge {
  private processMessage: ProcessMessageFn;
  private readonly apiFactory: (chatId: number) => TelegramChatEventAdapter;

  constructor(
    processMessage: ProcessMessageFn,
    apiFactory: (chatId: number) => TelegramChatEventAdapter
  ) {
    this.processMessage = processMessage;
    this.apiFactory = apiFactory;
  }

  setProcessMessage(processMessage: ProcessMessageFn): void {
    this.processMessage = processMessage;
  }

  async handleMessage(text: string, fromUserId: number, chatId: number): Promise<void> {
    // fromUserId and chatId are available for future routing/logging
    void fromUserId;
    const adapter = this.apiFactory(chatId);
    let eventQueue = Promise.resolve();
    const emit: ChatEventHandler = (event) => {
      const next = eventQueue.then(() => adapter.handle(event)).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[telegram-bot] chat event handling failed for chat ${chatId}: ${message}`);
      });
      eventQueue = next;
      return next;
    };

    let response: string | void = undefined;
    let processError: unknown = null;
    try {
      response = await this.processMessage(text, chatId, emit);
    } catch (err) {
      processError = err;
    }

    await eventQueue;

    if (processError !== null) {
      if (adapter.renderedAssistantOutput) {
        return;
      }

      const message = processError instanceof Error ? processError.message : String(processError);
      await adapter.sendFinalFallback(`Error: ${message}`);
      return;
    }

    if (!adapter.renderedAssistantOutput && typeof response === "string" && response.trim().length > 0) {
      await adapter.sendFinalFallback(response);
    }
  }
}
