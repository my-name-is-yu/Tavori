export interface SignalOutboundMessage {
  recipient: string;
  body: string;
}

export interface SignalReceivedMessage {
  id?: string;
  sender?: string;
  sender_number?: string;
  source?: string;
  message?: string;
  body?: string;
  timestamp?: number;
  conversationId?: string;
  groupId?: string;
}

export class SignalBridgeClient {
  constructor(
    private readonly bridgeUrl: string,
    private readonly account: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async sendTextMessage(message: SignalOutboundMessage): Promise<void> {
    const response = await this.fetchImpl(`${this.bridgeUrl}/v2/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: message.body,
        recipients: [message.recipient],
        number: this.account,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`signal-bridge: send failed with ${response.status}: ${body}`);
    }
  }

  async receiveMessages(timeoutMs: number): Promise<SignalReceivedMessage[]> {
    const endpoints = [
      `${this.bridgeUrl}/v1/receive/${encodeURIComponent(this.account)}?timeout=${timeoutMs}`,
      `${this.bridgeUrl}/v2/receive/${encodeURIComponent(this.account)}?timeout=${timeoutMs}`,
      `${this.bridgeUrl}/v1/receive`,
    ];

    for (const endpoint of endpoints) {
      const response = await this.fetchImpl(endpoint, {
        method: endpoint.endsWith("/v1/receive") ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
        },
        body: endpoint.endsWith("/v1/receive")
          ? JSON.stringify({ number: this.account, timeout: timeoutMs })
          : undefined,
      });

      if (!response.ok) {
        continue;
      }

      const payload = (await response.json().catch(() => null)) as unknown;
      const messages = normalizeReceiveResponse(payload);
      if (messages !== null) {
        return messages;
      }
    }

    return [];
  }
}

function normalizeReceiveResponse(payload: unknown): SignalReceivedMessage[] | null {
  if (Array.isArray(payload)) {
    return payload as SignalReceivedMessage[];
  }
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    const messages = record["messages"];
    if (Array.isArray(messages)) {
      return messages as SignalReceivedMessage[];
    }
    if (Array.isArray(record["data"])) {
      return record["data"] as SignalReceivedMessage[];
    }
    if (typeof record["message"] === "string" || typeof record["sender"] === "string") {
      return [record as SignalReceivedMessage];
    }
  }
  return null;
}
