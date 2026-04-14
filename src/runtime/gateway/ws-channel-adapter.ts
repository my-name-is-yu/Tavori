import type { ChannelAdapter, EnvelopeHandler, ReplyChannel } from "./channel-adapter.js";
import { createEnvelope, EnvelopeTypeSchema, EnvelopePrioritySchema } from "../types/envelope.js";
import {
  evaluateChannelAccess,
  resolveChannelRoute,
  type ChannelAccessPolicy,
  type ChannelRoutingPolicy,
} from "./channel-policy.js";

export interface WsChannelAdapterConfig {
  security?: ChannelAccessPolicy;
  routing?: ChannelRoutingPolicy;
}

/** Minimal interface for a WebSocket-like socket */
export interface WsSocketLike {
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  send(data: string): void;
  close(): void;
}

/** Minimal interface for a WebSocket-like server */
export interface WsLike {
  on(event: "connection", cb: (socket: WsSocketLike) => void): void;
  on(event: "close", cb: () => void): void;
  close(cb?: () => void): void;
}

/**
 * WsChannelAdapter wraps a WebSocket server (WsLike) and converts
 * incoming messages into Envelopes for the IngressGateway.
 *
 * The ws package (or any compatible WS server) can be injected;
 * no direct dependency on "ws" is required.
 */
export class WsChannelAdapter implements ChannelAdapter {
  readonly name = "websocket";
  private handler: EnvelopeHandler | null = null;
  private wss: WsLike;
  private config: WsChannelAdapterConfig;

  constructor(wss: WsLike, config: WsChannelAdapterConfig = {}) {
    this.wss = wss;
    this.config = config;
  }

  onEnvelope(handler: EnvelopeHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.wss.on("connection", (socket) => {
      this.handleConnection(socket);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
  }

  private handleConnection(socket: WsSocketLike): void {
    socket.on("message", (data) => {
      this.handleMessage(data, socket);
    });

    socket.on("close", () => {
      // no-op: socket lifecycle is managed externally
    });

    socket.on("error", (err) => {
      console.warn("WsChannelAdapter: socket error:", err.message);
    });
  }

  private handleMessage(data: unknown, socket: WsSocketLike): void {
    let parsed: Record<string, unknown>;

    try {
      const raw = typeof data === "string" ? data : String(data);
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.warn("WsChannelAdapter: failed to parse message, ignoring");
      return;
    }

    if (!this.handler) {
      console.warn("WsChannelAdapter: no handler registered, dropping message");
      return;
    }

    const typeParsed = EnvelopeTypeSchema.safeParse(parsed["type"]);
    const priorityParsed = EnvelopePrioritySchema.safeParse(parsed["priority"]);
    const senderId = typeof parsed["sender_id"] === "string"
      ? parsed["sender_id"]
      : typeof parsed["principal"] === "string"
        ? parsed["principal"]
        : undefined;
    const channelId = typeof parsed["channel_id"] === "string" ? parsed["channel_id"] : undefined;
    const conversationId = typeof parsed["conversation_id"] === "string"
      ? parsed["conversation_id"]
      : channelId;
    const context = {
      platform: "websocket",
      senderId,
      conversationId,
      channelId,
    };
    const access = evaluateChannelAccess(this.config.security, context);
    if (!access.allowed) {
      socket.send(JSON.stringify({ error: access.reason ?? "forbidden" }));
      return;
    }
    const route = resolveChannelRoute(this.config.routing, context);

    const envelope = createEnvelope({
      type: typeParsed.success ? typeParsed.data : "event",
      name: String(parsed["name"] ?? "ws_message"),
      source: "websocket",
      goal_id: (parsed["goal_id"] as string | undefined) ?? route.goalId,
      priority: priorityParsed.success ? priorityParsed.data : "normal",
      payload: parsed["payload"] ?? parsed,
      auth: senderId ? { principal: senderId } : undefined,
    });
    (envelope as Record<string, unknown>)["metadata"] = {
      ...route.metadata,
      ...(access.runtimeControlApproved ? { runtime_control_approved: true } : {}),
    };

    const reply: ReplyChannel = {
      send(responseData: unknown): void {
        socket.send(JSON.stringify(responseData));
      },
      close(): void {
        socket.close();
      },
    };

    void this.handler(envelope, reply);
  }
}
