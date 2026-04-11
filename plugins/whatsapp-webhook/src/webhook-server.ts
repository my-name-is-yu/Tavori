import * as crypto from "node:crypto";
import * as http from "node:http";
import { WhatsAppCloudClient } from "./whatsapp-client.js";
import { dispatchChatInput, type ChatContinuationInput } from "./shared-manager.js";
import type { WhatsAppWebhookConfig } from "./config.js";

interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
}

export class WhatsAppWebhookServer {
  private server: http.Server | null = null;

  constructor(
    private readonly config: WhatsAppWebhookConfig,
    private readonly client: WhatsAppCloudClient,
    private readonly fetchChatReply: typeof dispatchChatInput = dispatchChatInput
  ) {}

  async start(): Promise<void> {
    if (this.server !== null) {
      return;
    }

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.config.port, this.config.host, resolve);
    });
  }

  async stop(): Promise<void> {
    if (this.server === null) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? this.config.host}`);

    if (req.method === "GET" && url.pathname === this.config.path) {
      this.handleVerification(req, res, url);
      return;
    }

    if (req.method !== "POST" || url.pathname !== this.config.path) {
      this.respondJson(res, 404, { error: "not_found" });
      return;
    }

    const body = await this.readBody(req);
    if (body === null) {
      this.respondJson(res, 400, { error: "invalid_body" });
      return;
    }

    if (!(await this.verifySignature(req, body))) {
      this.respondJson(res, 401, { error: "invalid_signature" });
      return;
    }

    let payload: WhatsAppWebhookPayload;
    try {
      payload = JSON.parse(body) as WhatsAppWebhookPayload;
    } catch {
      this.respondJson(res, 400, { error: "invalid_json" });
      return;
    }

    const messages = this.extractMessages(payload);
    for (const message of messages) {
      void this.processMessage(message).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[whatsapp-webhook] failed to process message: ${msg}`);
      });
    }

    this.respondJson(res, 200, { ok: true });
  }

  private handleVerification(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === this.config.verify_token && challenge !== null) {
      res.statusCode = 200;
      res.end(challenge);
      return;
    }

    this.respondJson(res, 403, { error: "verification_failed" });
  }

  private async processMessage(message: {
    id?: string;
    from?: string;
    timestamp?: string;
    text?: { body?: string };
    type?: string;
  }): Promise<void> {
    if (message.from === undefined || message.text?.body === undefined || message.text.body.trim().length === 0) {
      return;
    }

    const input: ChatContinuationInput = {
      platform: "whatsapp",
      identity_key: this.config.identity_key,
      conversation_id: message.from,
      sender_id: message.from,
      message_id: message.id,
      text: message.text.body,
      metadata: {
        message_type: message.type,
        timestamp: message.timestamp,
      },
    };

    const reply = await this.fetchChatReply(input);
    const content = reply ?? "Received.";
    await this.client.sendTextMessage({
      to: message.from,
      body: content,
    });
  }

  private extractMessages(payload: WhatsAppWebhookPayload): Array<{
    id?: string;
    from?: string;
    timestamp?: string;
    type?: string;
    text?: { body?: string };
  }> {
    const messages: Array<{
      id?: string;
      from?: string;
      timestamp?: string;
      type?: string;
      text?: { body?: string };
    }> = [];

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          messages.push(message);
        }
      }
    }

    return messages;
  }

  private async verifySignature(req: http.IncomingMessage, body: string): Promise<boolean> {
    if (this.config.app_secret === undefined || this.config.app_secret.length === 0) {
      return true;
    }

    const header = req.headers["x-hub-signature-256"];
    if (typeof header !== "string" || !header.startsWith("sha256=")) {
      return false;
    }

    const expected = crypto
      .createHmac("sha256", this.config.app_secret)
      .update(body)
      .digest("hex");
    const actual = header.slice("sha256=".length);
    if (expected.length !== actual.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
  }

  private async readBody(req: http.IncomingMessage): Promise<string | null> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  private respondJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  }
}
