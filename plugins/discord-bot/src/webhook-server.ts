import * as http from "node:http";
import { createHash, webcrypto } from "node:crypto";
import { DiscordAPI } from "./discord-api.js";
import { dispatchChatInput, type ChatContinuationInput } from "./shared-manager.js";
import type { DiscordBotConfig } from "./config.js";

interface DiscordInteractionOption {
  name: string;
  value?: unknown;
}

interface DiscordInteractionPayload {
  id?: string;
  type?: number;
  token?: string;
  application_id?: string;
  channel_id?: string;
  guild_id?: string;
  member?: {
    user?: {
      id?: string;
      username?: string;
    };
  };
  user?: {
    id?: string;
    username?: string;
  };
  data?: {
    name?: string;
    options?: DiscordInteractionOption[];
  };
}

export class DiscordWebhookServer {
  private server: http.Server | null = null;

  constructor(
    private readonly config: DiscordBotConfig,
    private readonly api: DiscordAPI,
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
    if (req.method !== "POST") {
      this.respondJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    const body = await this.readBody(req);
    if (body === null) {
      this.respondJson(res, 400, { error: "invalid_body" });
      return;
    }

    if (!(await this.verifyRequest(req, body))) {
      this.respondJson(res, 401, { error: "invalid_signature" });
      return;
    }

    let payload: DiscordInteractionPayload;
    try {
      payload = JSON.parse(body) as DiscordInteractionPayload;
    } catch {
      this.respondJson(res, 400, { error: "invalid_json" });
      return;
    }

    if (payload.type === 1) {
      this.respondJson(res, 200, { type: 1 });
      return;
    }

    if (
      payload.type !== 2 ||
      payload.token === undefined ||
      payload.application_id === undefined ||
      payload.data?.name !== this.config.command_name
    ) {
      this.respondJson(res, 400, { error: "unsupported_interaction" });
      return;
    }

    const text = this.extractCommandText(payload);
    if (text === null) {
      this.respondJson(res, 400, { error: "missing_message_text" });
      return;
    }

    const senderId = payload.member?.user?.id ?? payload.user?.id ?? "discord-user";
    const conversationId = payload.channel_id ?? payload.guild_id ?? payload.id ?? senderId;
    const runtimeControlApproved =
      this.config.runtime_control_allowed_sender_ids.includes(senderId);
    const input: ChatContinuationInput = {
      platform: "discord",
      identity_key: this.config.identity_key,
      conversation_id: conversationId,
      sender_id: senderId,
      message_id: payload.id,
      text,
      metadata: {
        interaction_type: payload.type,
        command_name: payload.data?.name,
        channel_id: payload.channel_id,
        guild_id: payload.guild_id,
        ...(runtimeControlApproved ? { runtime_control_approved: true } : {}),
      },
    };

    void this.processIncomingMessage(payload, input).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[discord-bot] failed to process interaction: ${msg}`);
    });
    this.respondJson(res, 200, { type: 5, data: this.config.ephemeral ? { flags: 64 } : undefined });
  }

  private async processIncomingMessage(
    payload: DiscordInteractionPayload,
    input: ChatContinuationInput
  ): Promise<void> {
    const reply = await this.fetchChatReply(input);
    const content = reply ?? "Received.";

    if (payload.application_id !== undefined && payload.token !== undefined) {
      await this.api.sendInteractionFollowUp(payload.application_id, payload.token, content);
    }
  }

  private extractCommandText(payload: DiscordInteractionPayload): string | null {
    const options = payload.data?.options ?? [];
    for (const option of options) {
      if (option.name === "message" || option.name === "text" || option.name === "content") {
        if (typeof option.value === "string" && option.value.trim().length > 0) {
          return option.value;
        }
      }
    }
    return null;
  }

  private async verifyRequest(req: http.IncomingMessage, body: string): Promise<boolean> {
    if (this.config.public_key_hex === undefined || this.config.public_key_hex.length === 0) {
      return true;
    }

    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];
    if (typeof signature !== "string" || typeof timestamp !== "string") {
      return false;
    }

    const publicKeyBytes = Uint8Array.from(Buffer.from(this.config.public_key_hex, "hex"));
    let key: CryptoKey;
    try {
      key = await webcrypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"]);
    } catch {
      return false;
    }

    const messageBytes = new TextEncoder().encode(timestamp + body);
    try {
      return await webcrypto.subtle.verify(
        { name: "Ed25519" },
        key,
        Buffer.from(signature, "hex"),
        messageBytes
      );
    } catch {
      return false;
    }
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
