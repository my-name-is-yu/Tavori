import { describe, it, expect, vi, beforeEach } from "vitest";
import { WsChannelAdapter } from "../ws-channel-adapter.js";
import type { WsLike, WsSocketLike } from "../ws-channel-adapter.js";

// ---- Mock helpers ----

function createMockSocket(): WsSocketLike & {
  simulateMessage(data: unknown): void;
  simulateClose(): void;
  simulateError(err: Error): void;
} {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};

  const socket = {
    on(event: string, cb: (...args: any[]) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    },
    send: vi.fn(),
    close: vi.fn(),
    simulateMessage(data: unknown) {
      listeners["message"]?.forEach((cb) => cb(data));
    },
    simulateClose() {
      listeners["close"]?.forEach((cb) => cb());
    },
    simulateError(err: Error) {
      listeners["error"]?.forEach((cb) => cb(err));
    },
  };

  return socket;
}

function createMockWss(): WsLike & {
  simulateConnection(socket: WsSocketLike): void;
  simulateClose(): void;
} {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};

  return {
    on(event: string, cb: (...args: any[]) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    },
    close(cb?: () => void) {
      cb?.();
    },
    simulateConnection(socket: WsSocketLike) {
      listeners["connection"]?.forEach((cb) => cb(socket));
    },
    simulateClose() {
      listeners["close"]?.forEach((cb) => cb());
    },
  };
}

// ---- Tests ----

describe("WsChannelAdapter", () => {
  let wss: ReturnType<typeof createMockWss>;
  let adapter: WsChannelAdapter;

  beforeEach(() => {
    wss = createMockWss();
    adapter = new WsChannelAdapter(wss);
  });

  it("has name 'websocket'", () => {
    expect(adapter.name).toBe("websocket");
  });

  describe("lifecycle", () => {
    it("start() sets up connection listener", async () => {
      const spy = vi.spyOn(wss, "on");
      await adapter.start();
      expect(spy).toHaveBeenCalledWith("connection", expect.any(Function));
    });

    it("stop() calls wss.close()", async () => {
      const spy = vi.spyOn(wss, "close");
      await adapter.stop();
      expect(spy).toHaveBeenCalledOnce();
    });

    it("stop() resolves after close callback fires", async () => {
      await expect(adapter.stop()).resolves.toBeUndefined();
    });
  });

  describe("message parsing and envelope creation", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("converts valid JSON message to envelope", () => {
      const handler = vi.fn();
      adapter.onEnvelope(handler);

      const socket = createMockSocket();
      wss.simulateConnection(socket);

      socket.simulateMessage(
        JSON.stringify({
          type: "command",
          name: "run_goal",
          goal_id: "goal-123",
          priority: "high",
          payload: { action: "start" },
        })
      );

      expect(handler).toHaveBeenCalledOnce();
      const [envelope] = handler.mock.calls[0];
      expect(envelope.id).toBeDefined();
      expect(envelope.type).toBe("command");
      expect(envelope.name).toBe("run_goal");
      expect(envelope.source).toBe("websocket");
      expect(envelope.goal_id).toBe("goal-123");
      expect(envelope.priority).toBe("high");
      expect(envelope.payload).toEqual({ action: "start" });
    });

    it("uses defaults when optional fields are missing", () => {
      const handler = vi.fn();
      adapter.onEnvelope(handler);

      const socket = createMockSocket();
      wss.simulateConnection(socket);

      socket.simulateMessage(JSON.stringify({ name: "ping", payload: {} }));

      const [envelope] = handler.mock.calls[0];
      expect(envelope.type).toBe("event");
      expect(envelope.priority).toBe("normal");
      expect(envelope.goal_id).toBeUndefined();
    });

    it("falls back to entire parsed object as payload if payload field missing", () => {
      const handler = vi.fn();
      adapter.onEnvelope(handler);

      const socket = createMockSocket();
      wss.simulateConnection(socket);

      socket.simulateMessage(JSON.stringify({ type: "event", name: "tick", foo: "bar" }));

      const [envelope] = handler.mock.calls[0];
      expect(envelope.payload).toMatchObject({ type: "event", name: "tick", foo: "bar" });
    });

    it("uses 'ws_message' as default name", () => {
      const handler = vi.fn();
      adapter.onEnvelope(handler);

      const socket = createMockSocket();
      wss.simulateConnection(socket);

      socket.simulateMessage(JSON.stringify({ type: "event" }));

      const [envelope] = handler.mock.calls[0];
      expect(envelope.name).toBe("ws_message");
    });
  });

  describe("invalid JSON handling", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("ignores messages that are not valid JSON", () => {
      const handler = vi.fn();
      adapter.onEnvelope(handler);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const socket = createMockSocket();
      wss.simulateConnection(socket);
      socket.simulateMessage("not json {{");

      expect(handler).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("WsChannelAdapter")
      );
      warnSpy.mockRestore();
    });

    it("ignores undefined/null data gracefully", () => {
      const handler = vi.fn();
      adapter.onEnvelope(handler);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const socket = createMockSocket();
      wss.simulateConnection(socket);
      socket.simulateMessage(undefined);

      expect(handler).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("invalid type/priority validation", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("falls back to 'event' type when client sends invalid type", () => {
      const handler = vi.fn();
      adapter.onEnvelope(handler);

      const socket = createMockSocket();
      wss.simulateConnection(socket);
      socket.simulateMessage(JSON.stringify({ type: "invalid", name: "test", payload: {} }));

      const [envelope] = handler.mock.calls[0];
      expect(envelope.type).toBe("event");
    });

    it("falls back to 'normal' priority when client sends invalid priority", () => {
      const handler = vi.fn();
      adapter.onEnvelope(handler);

      const socket = createMockSocket();
      wss.simulateConnection(socket);
      socket.simulateMessage(JSON.stringify({ type: "command", name: "test", priority: "urgent", payload: {} }));

      const [envelope] = handler.mock.calls[0];
      expect(envelope.priority).toBe("normal");
    });

    it("accepts valid type and priority values without fallback", () => {
      const handler = vi.fn();
      adapter.onEnvelope(handler);

      const socket = createMockSocket();
      wss.simulateConnection(socket);
      socket.simulateMessage(JSON.stringify({ type: "command", name: "test", priority: "critical", payload: {} }));

      const [envelope] = handler.mock.calls[0];
      expect(envelope.type).toBe("command");
      expect(envelope.priority).toBe("critical");
    });
  });

  describe("ReplyChannel", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("reply.send() serializes response to JSON and sends via socket", () => {
      let capturedReply: any;
      adapter.onEnvelope((_env, reply) => {
        capturedReply = reply;
      });

      const socket = createMockSocket();
      wss.simulateConnection(socket);
      socket.simulateMessage(JSON.stringify({ type: "command", name: "ping", payload: {} }));

      expect(capturedReply).toBeDefined();
      capturedReply.send({ status: "ok" });

      expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ status: "ok" }));
    });

    it("reply is passed as second argument to handler", () => {
      const handler = vi.fn();
      adapter.onEnvelope(handler);

      const socket = createMockSocket();
      wss.simulateConnection(socket);
      socket.simulateMessage(JSON.stringify({ type: "event", name: "test", payload: {} }));

      expect(handler.mock.calls[0][1]).toBeDefined();
    });

    it("reply.close() calls socket.close()", () => {
      let capturedReply: any;
      adapter.onEnvelope((_env, reply) => {
        capturedReply = reply;
      });

      const socket = createMockSocket();
      wss.simulateConnection(socket);
      socket.simulateMessage(JSON.stringify({ type: "event", name: "test", payload: {} }));

      expect(capturedReply).toBeDefined();
      capturedReply.close();
      expect(socket.close).toHaveBeenCalledOnce();
    });
  });

  describe("handler not set", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("drops messages received before onEnvelope is called", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const socket = createMockSocket();
      wss.simulateConnection(socket);
      socket.simulateMessage(JSON.stringify({ type: "event", name: "early", payload: {} }));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("WsChannelAdapter")
      );
      warnSpy.mockRestore();
    });
  });

  describe("multiple connections", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("handles messages from multiple concurrent sockets", () => {
      const handler = vi.fn();
      adapter.onEnvelope(handler);

      const socketA = createMockSocket();
      const socketB = createMockSocket();
      wss.simulateConnection(socketA);
      wss.simulateConnection(socketB);

      socketA.simulateMessage(JSON.stringify({ name: "from-a", payload: { src: "a" } }));
      socketB.simulateMessage(JSON.stringify({ name: "from-b", payload: { src: "b" } }));

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[0][0].name).toBe("from-a");
      expect(handler.mock.calls[1][0].name).toBe("from-b");
    });

    it("socket error does not affect other sockets", () => {
      const handler = vi.fn();
      adapter.onEnvelope(handler);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const socketA = createMockSocket();
      const socketB = createMockSocket();
      wss.simulateConnection(socketA);
      wss.simulateConnection(socketB);

      socketA.simulateError(new Error("connection reset"));
      socketB.simulateMessage(JSON.stringify({ name: "still-alive", payload: {} }));

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].name).toBe("still-alive");
      warnSpy.mockRestore();
    });
  });

  describe("socket error handling", () => {
    beforeEach(async () => {
      await adapter.start();
    });

    it("logs warning on socket error", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const socket = createMockSocket();
      wss.simulateConnection(socket);
      socket.simulateError(new Error("socket error"));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("WsChannelAdapter"),
        expect.stringContaining("socket error")
      );
      warnSpy.mockRestore();
    });
  });
});
