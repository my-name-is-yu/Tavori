import type { ChannelAdapter, EnvelopeHandler } from "./channel-adapter.js";
import type { Envelope } from "../types/envelope.js";
import type { Logger } from "../logger.js";

/**
 * IngressGateway collects Envelopes from all registered ChannelAdapters
 * and forwards them to a single handler (the Queue in Phase B, or direct
 * processing in Phase A).
 */
export class IngressGateway {
  private adapters: Map<string, ChannelAdapter> = new Map();
  private handler: EnvelopeHandler | null = null;
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /** Register an adapter. Throws if name is already registered. */
  registerAdapter(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`ChannelAdapter "${adapter.name}" already registered`);
    }
    this.adapters.set(adapter.name, adapter);
    adapter.onEnvelope((envelope: Envelope) => this.routeEnvelope(envelope));
    this.logger?.info(`Gateway: registered adapter "${adapter.name}"`);
  }

  /** Set the handler that receives all Envelopes from all adapters. */
  onEnvelope(handler: EnvelopeHandler): void {
    this.handler = handler;
  }

  /** Start all registered adapters. */
  async start(): Promise<void> {
    for (const [name, adapter] of this.adapters) {
      await adapter.start();
      this.logger?.info(`Gateway: started adapter "${name}"`);
    }
  }

  /** Stop all registered adapters. */
  async stop(): Promise<void> {
    for (const [name, adapter] of this.adapters) {
      await adapter.stop();
      this.logger?.info(`Gateway: stopped adapter "${name}"`);
    }
  }

  /** Get a registered adapter by name. */
  getAdapter(name: string): ChannelAdapter | undefined {
    return this.adapters.get(name);
  }

  /** List all registered adapter names. */
  get adapterNames(): string[] {
    return Array.from(this.adapters.keys());
  }

  private routeEnvelope(envelope: Envelope): void {
    if (!this.handler) {
      this.logger?.warn("Gateway: no handler registered, dropping envelope", {
        id: envelope.id,
        name: envelope.name,
      });
      return;
    }
    try {
      const result = this.handler(envelope);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          this.logger?.error("Gateway: handler error", {
            id: envelope.id,
            error: String(err),
          });
        });
      }
    } catch (err: unknown) {
      this.logger?.error("Gateway: handler error", {
        id: envelope.id,
        error: String(err),
      });
    }
  }
}
