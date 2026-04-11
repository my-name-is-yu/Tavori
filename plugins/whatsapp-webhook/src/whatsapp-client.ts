export interface WhatsAppMessage {
  to: string;
  body: string;
}

export class WhatsAppCloudClient {
  constructor(
    private readonly phoneNumberId: string,
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async sendTextMessage(message: WhatsAppMessage): Promise<void> {
    const response = await this.fetchImpl(
      `https://graph.facebook.com/v20.0/${this.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: message.to,
          type: "text",
          text: {
            body: message.body,
          },
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`whatsapp-webhook: send failed with ${response.status}: ${body}`);
    }
  }
}
