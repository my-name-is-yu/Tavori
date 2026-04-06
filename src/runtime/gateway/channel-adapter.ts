import type { Envelope } from "../types/envelope.js";

export interface ReplyChannel {
  send(data: unknown): void;
  close(): void;
}

export type EnvelopeHandler = (envelope: Envelope, reply?: ReplyChannel) => void | Promise<void>;

/**
 * A ChannelAdapter receives protocol-specific input and emits Envelopes.
 * Each adapter handles one external protocol (HTTP, WebSocket, CLI, MCP, Slack, etc.).
 */
export interface ChannelAdapter {
  /** Unique adapter name (e.g., "http", "websocket", "cli", "slack") */
  readonly name: string;

  /** Start accepting input from this channel */
  start(): Promise<void>;

  /** Stop accepting input and clean up resources */
  stop(): Promise<void>;

  /** Register the handler that receives Envelopes from this adapter */
  onEnvelope(handler: EnvelopeHandler): void;
}
