import type { ChannelAdapter, EnvelopeHandler } from "./channel-adapter.js";
import type { EventServer } from "../event-server.js";
import { createEnvelope } from "../types/envelope.js";
import type { Envelope } from "../types/envelope.js";

/**
 * HttpChannelAdapter wraps the existing EventServer and converts
 * incoming HTTP events into Envelopes for the Gateway.
 *
 * In Phase A, this is the only ChannelAdapter.
 * The EventServer retains all its existing functionality (SSE, approval, goals API).
 * The adapter intercepts POST /events to route through the Envelope path.
 */
export class HttpChannelAdapter implements ChannelAdapter {
  readonly name = "http";
  private handler: EnvelopeHandler | null = null;
  private eventServer: EventServer;

  constructor(eventServer: EventServer) {
    this.eventServer = eventServer;
    this.eventServer.setEnvelopeHook((eventData: Record<string, unknown>) => {
      return this.emitEnvelope(eventData);
    });
  }

  onEnvelope(handler: EnvelopeHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    await this.eventServer.start();
    this.eventServer.startFileWatcher();
  }

  async stop(): Promise<void> {
    this.eventServer.stopFileWatcher();
    await this.eventServer.stop();
  }

  /** Access the underlying EventServer for approval, broadcast, port, etc. */
  getEventServer(): EventServer {
    return this.eventServer;
  }

  private emitEnvelope(eventData: Record<string, unknown>): void | Promise<void> {
    if (!this.handler) {
      console.warn("HttpChannelAdapter: no handler registered, dropping event");
      return;
    }
    const envelope: Envelope = createEnvelope({
      type: "event",
      name: String(eventData["type"] ?? "external_event"),
      source: "http",
      goal_id: eventData["goal_id"] as string | undefined,
      priority: "normal",
      payload: eventData,
    });
    return this.handler(envelope);
  }
}
