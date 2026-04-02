// ─── ChatBridge ───
//
// Thin adapter between the Telegram polling loop and the message processor.
// Does not import ChatRunner directly — takes a processMessage callback
// so that index.ts can wire the actual ChatRunner integration.

type ProcessMessageFn = (text: string) => Promise<string>;

export class ChatBridge {
  private readonly processMessage: ProcessMessageFn;

  constructor(processMessage: ProcessMessageFn) {
    this.processMessage = processMessage;
  }

  async handleMessage(text: string, fromUserId: number, chatId: number): Promise<string> {
    // fromUserId and chatId are available for future routing/logging
    void fromUserId;
    void chatId;

    const response = await this.processMessage(text);
    return response;
  }
}
