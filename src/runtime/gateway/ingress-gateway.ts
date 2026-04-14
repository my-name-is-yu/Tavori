import type { ChannelAdapter, EnvelopeHandler, ReplyChannel } from "./channel-adapter.js";
import type { Envelope } from "../types/envelope.js";
import type { Logger } from "../logger.js";
import {
  evaluateChannelAccess,
  resolveChannelRoute,
  type ChannelMessageContext,
  type ChannelAccessPolicy,
  type ChannelRoutingPolicy,
} from "./channel-policy.js";

export interface IngressGatewayPolicy {
  security?: ChannelAccessPolicy;
  routing?: ChannelRoutingPolicy;
}

export interface IngressGatewayOptions {
  logger?: Logger;
  policies?: Record<string, IngressGatewayPolicy>;
}

function isGatewayOptions(value: Logger | IngressGatewayOptions | undefined): value is IngressGatewayOptions {
  return typeof value === "object" && value !== null && ("policies" in value || "logger" in value);
}

/**
 * IngressGateway collects Envelopes from all registered ChannelAdapters
 * and forwards them to a single handler (the Queue in Phase B, or direct
 * processing in Phase A).
 */
export class IngressGateway {
  private adapters: Map<string, ChannelAdapter> = new Map();
  private handler: EnvelopeHandler | null = null;
  private logger?: Logger;
  private policies: Map<string, IngressGatewayPolicy> = new Map();

  constructor(loggerOrOptions?: Logger | IngressGatewayOptions) {
    if (isGatewayOptions(loggerOrOptions)) {
      this.logger = loggerOrOptions.logger;
      for (const [source, policy] of Object.entries(loggerOrOptions.policies ?? {})) {
        this.policies.set(source, policy);
      }
    } else {
      this.logger = loggerOrOptions;
    }
  }

  /** Register an adapter. Throws if name is already registered. */
  registerAdapter(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`ChannelAdapter "${adapter.name}" already registered`);
    }
    this.adapters.set(adapter.name, adapter);
    adapter.onEnvelope((envelope: Envelope, reply?: ReplyChannel) => this.routeEnvelope(envelope, reply));
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

  setPolicy(source: string, policy: IngressGatewayPolicy): void {
    this.policies.set(source, policy);
  }

  private routeEnvelope(envelope: Envelope, reply?: ReplyChannel): void | Promise<void> {
    const policy = this.policies.get(envelope.source);
    if (policy && !this.applyPolicy(envelope, policy)) {
      return;
    }

    if (!this.handler) {
      this.logger?.warn("Gateway: no handler registered, dropping envelope", {
        id: envelope.id,
        name: envelope.name,
      });
      return;
    }
    try {
      const result = this.handler(envelope, reply);
      if (result instanceof Promise) {
        return result.catch((err: unknown) => {
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

  private applyPolicy(envelope: Envelope, policy: IngressGatewayPolicy): boolean {
    const context = buildPolicyContext(envelope);
    const access = evaluateChannelAccess(policy.security, context);
    if (!access.allowed) {
      this.logger?.warn("Gateway: security policy rejected envelope", {
        id: envelope.id,
        source: envelope.source,
        reason: access.reason,
      });
      return false;
    }

    const route = resolveChannelRoute(policy.routing, context);
    if (!envelope.goal_id && route.goalId) {
      envelope.goal_id = route.goalId;
    }
    setEnvelopeMetadata(envelope, {
      ...route.metadata,
      ...(access.runtimeControlApproved ? { runtime_control_approved: true } : {}),
    });
    return true;
  }
}

function buildPolicyContext(envelope: Envelope): ChannelMessageContext {
  const payload = typeof envelope.payload === "object" && envelope.payload !== null
    ? envelope.payload as Record<string, unknown>
    : {};
  const senderId = stringifyOptional(
    envelope.auth?.principal ??
    payload["sender_id"] ??
    payload["user"] ??
    payload["from"]
  );
  const channelId = stringifyOptional(payload["channel_id"] ?? payload["channel"]);
  const conversationId = stringifyOptional(
    payload["conversation_id"] ??
    payload["conversationId"] ??
    channelId
  );

  return {
    platform: envelope.source,
    senderId,
    conversationId,
    channelId,
  };
}

function stringifyOptional(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const normalized = String(value);
  return normalized.length > 0 ? normalized : undefined;
}

function setEnvelopeMetadata(envelope: Envelope, metadata: Record<string, unknown>): void {
  (envelope as Envelope & { metadata?: Record<string, unknown> }).metadata = {
    ...((envelope as Envelope & { metadata?: Record<string, unknown> }).metadata ?? {}),
    ...metadata,
  };
}
