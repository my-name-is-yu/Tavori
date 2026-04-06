import { describe, it, expect, vi } from "vitest";
import { IngressGateway } from "../ingress-gateway.js";
import type { ChannelAdapter, EnvelopeHandler, ReplyChannel } from "../channel-adapter.js";
import type { Envelope } from "../../types/envelope.js";
import { createEnvelope } from "../../types/envelope.js";

function createMockAdapter(name: string): ChannelAdapter & {
  emitEnvelope: (e: Envelope, reply?: ReplyChannel) => void;
} {
  let handler: EnvelopeHandler | null = null;
  return {
    name,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onEnvelope(h: EnvelopeHandler) { handler = h; },
    emitEnvelope(e: Envelope, reply?: ReplyChannel) { handler?.(e, reply); },
  };
}

describe("IngressGateway", () => {
  it("registers adapters", () => {
    const gw = new IngressGateway();
    const adapter = createMockAdapter("test");
    gw.registerAdapter(adapter);
    expect(gw.adapterNames).toEqual(["test"]);
  });

  it("throws on duplicate adapter name", () => {
    const gw = new IngressGateway();
    gw.registerAdapter(createMockAdapter("http"));
    expect(() => gw.registerAdapter(createMockAdapter("http"))).toThrow("already registered");
  });

  it("starts all adapters", async () => {
    const gw = new IngressGateway();
    const a1 = createMockAdapter("a");
    const a2 = createMockAdapter("b");
    gw.registerAdapter(a1);
    gw.registerAdapter(a2);
    await gw.start();
    expect(a1.start).toHaveBeenCalled();
    expect(a2.start).toHaveBeenCalled();
  });

  it("stops all adapters", async () => {
    const gw = new IngressGateway();
    const a1 = createMockAdapter("a");
    gw.registerAdapter(a1);
    await gw.stop();
    expect(a1.stop).toHaveBeenCalled();
  });

  it("routes envelopes to handler", () => {
    const gw = new IngressGateway();
    const adapter = createMockAdapter("test");
    const handler = vi.fn();
    gw.registerAdapter(adapter);
    gw.onEnvelope(handler);

    const envelope = createEnvelope({
      type: "event",
      name: "test_event",
      source: "test",
      payload: { foo: "bar" },
    });
    adapter.emitEnvelope(envelope);
    expect(handler).toHaveBeenCalledWith(envelope, undefined);
  });

  it("drops envelopes when no handler registered", () => {
    const gw = new IngressGateway();
    const adapter = createMockAdapter("test");
    gw.registerAdapter(adapter);
    const envelope = createEnvelope({
      type: "event",
      name: "test_event",
      source: "test",
      payload: {},
    });
    expect(() => adapter.emitEnvelope(envelope)).not.toThrow();
  });

  it("handles handler errors gracefully", () => {
    const gw = new IngressGateway();
    const adapter = createMockAdapter("test");
    gw.registerAdapter(adapter);
    gw.onEnvelope(() => { throw new Error("handler error"); });

    const envelope = createEnvelope({
      type: "event",
      name: "test_event",
      source: "test",
      payload: {},
    });
    expect(() => adapter.emitEnvelope(envelope)).not.toThrow();
  });

  it("getAdapter returns registered adapter", () => {
    const gw = new IngressGateway();
    const adapter = createMockAdapter("http");
    gw.registerAdapter(adapter);
    expect(gw.getAdapter("http")).toBe(adapter);
    expect(gw.getAdapter("unknown")).toBeUndefined();
  });

  it("forwards reply argument to handler", () => {
    const gw = new IngressGateway();
    const adapter = createMockAdapter("test");
    const handler = vi.fn();
    gw.registerAdapter(adapter);
    gw.onEnvelope(handler);

    const envelope = createEnvelope({
      type: "command",
      name: "ping",
      source: "test",
      payload: {},
    });
    const reply: ReplyChannel = { send: vi.fn(), close: vi.fn() };
    adapter.emitEnvelope(envelope, reply);

    expect(handler).toHaveBeenCalledWith(envelope, reply);
  });
});
