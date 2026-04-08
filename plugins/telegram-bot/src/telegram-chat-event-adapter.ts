import type { TelegramAPI } from "./telegram-api.js";
import type { ChatEvent } from "pulseed";

interface RenderedMessage {
  messageId: number;
  text: string;
}

function toMarkdownSafeText(text: string): string {
  return text;
}

export class TelegramChatEventAdapter {
  private readonly api: TelegramAPI;
  private readonly chatId: number;
  private assistantMessage: RenderedMessage | null = null;
  private readonly toolMessages = new Map<string, RenderedMessage>();
  private hasAssistantOutput = false;

  constructor(api: TelegramAPI, chatId: number) {
    this.api = api;
    this.chatId = chatId;
  }

  get renderedAssistantOutput(): boolean {
    return this.hasAssistantOutput;
  }

  async handle(event: ChatEvent): Promise<void> {
    switch (event.type) {
      case "lifecycle_start":
        this.assistantMessage = null;
        this.toolMessages.clear();
        this.hasAssistantOutput = false;
        return;

      case "assistant_delta":
        await this.upsertAssistantMessage(event.text);
        return;

      case "assistant_final":
        await this.upsertAssistantMessage(event.text);
        return;

      case "tool_start":
        await this.upsertToolMessage(event.toolCallId, `[tool] ${event.toolName} started`);
        return;

      case "tool_update":
        await this.upsertToolMessage(event.toolCallId, `[tool] ${event.toolName} ${event.status}: ${event.message}`);
        return;

      case "tool_end":
        await this.upsertToolMessage(
          event.toolCallId,
          `[tool] ${event.toolName} ${event.success ? "done" : "failed"}: ${event.summary}`
        );
        return;

      case "lifecycle_error":
        if (this.assistantMessage) {
          await this.api.editMessageText(
            this.chatId,
            this.assistantMessage.messageId,
            toMarkdownSafeText(event.partialText ? `${event.partialText}\n\n[interrupted: ${event.error}]` : `Error: ${event.error}`)
          );
          this.hasAssistantOutput = true;
          this.assistantMessage.text = event.partialText ? `${event.partialText}\n\n[interrupted: ${event.error}]` : `Error: ${event.error}`;
          return;
        }
        await this.api.sendPlainMessage(
          this.chatId,
          toMarkdownSafeText(event.partialText ? `${event.partialText}\n\n[interrupted: ${event.error}]` : `Error: ${event.error}`)
        );
        this.hasAssistantOutput = true;
        return;

      case "lifecycle_end":
        return;
    }
  }

  async sendFinalFallback(text: string): Promise<void> {
    if (!text.trim()) return;
    await this.upsertAssistantMessage(text);
  }

  private async upsertAssistantMessage(text: string): Promise<void> {
    const cleanText = toMarkdownSafeText(text);
    if (!this.assistantMessage) {
      const messageId = await this.api.sendPlainMessage(this.chatId, cleanText);
      this.assistantMessage = { messageId, text: cleanText };
      this.hasAssistantOutput = true;
      return;
    }

    await this.api.editMessageText(this.chatId, this.assistantMessage.messageId, cleanText);
    this.assistantMessage.text = cleanText;
    this.hasAssistantOutput = true;
  }

  private async upsertToolMessage(toolCallId: string, text: string): Promise<void> {
    const existing = this.toolMessages.get(toolCallId);
    if (!existing) {
      const messageId = await this.api.sendPlainMessage(this.chatId, text);
      this.toolMessages.set(toolCallId, { messageId, text });
      return;
    }

    await this.api.editMessageText(this.chatId, existing.messageId, text);
    existing.text = text;
  }
}
