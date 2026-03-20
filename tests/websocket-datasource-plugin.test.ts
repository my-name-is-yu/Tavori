// ─── WebSocketDataSourceAdapter tests ───
//
// Uses vi.mock to replace the "ws" package so the test runs without a real
// WebSocket server and without installing ws in the plugin directory.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoist mock definitions ───

const { mockWsInstance, MockWebSocket } = vi.hoisted(() => {
  // Minimal EventEmitter-style mock for ws
  type Listener = (...args: unknown[]) => void;

  class MockWebSocketInstance {
    readyState: number;
    static OPEN = 1;
    static CLOSED = 3;
    private listeners: Map<string, Listener[]> = new Map();

    constructor() {
      this.readyState = MockWebSocketInstance.OPEN;
    }

    on(event: string, listener: Listener) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event)!.push(listener);
      // Emit "open" asynchronously on first subscription to simulate connect
      if (event === "open") {
        Promise.resolve().then(() => this.emit("open"));
      }
    }

    emit(event: string, ...args: unknown[]) {
      (this.listeners.get(event) ?? []).forEach((l) => l(...args));
    }

    close() {
      this.readyState = MockWebSocketInstance.CLOSED;
      this.emit("close");
    }
  }

  const mockWsInstance = new MockWebSocketInstance();
  const MockWebSocket = vi.fn().mockImplementation(() => mockWsInstance);
  (MockWebSocket as unknown as Record<string, number>).OPEN = MockWebSocketInstance.OPEN;
  (MockWebSocket as unknown as Record<string, number>).CLOSED = MockWebSocketInstance.CLOSED;

  return { mockWsInstance, MockWebSocket };
});

vi.mock("ws", () => ({
  default: MockWebSocket,
}));

// ─── Import after mock ───

import { WebSocketDataSourceAdapter } from "../examples/plugins/websocket-datasource/src/index.js";
import type { DataSourceConfig } from "../src/types/data-source.js";

// ─── Helpers ───

function makeConfig(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: "test-ws",
    name: "Test WebSocket",
    type: "websocket",
    connection: { url: "ws://localhost:9999" },
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ───

describe("WebSocketDataSourceAdapter", () => {
  let adapter: WebSocketDataSourceAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset readyState and listeners for each test
    mockWsInstance.readyState = 1; // OPEN
    (mockWsInstance as unknown as { listeners: Map<string, unknown> }).listeners = new Map();
    adapter = new WebSocketDataSourceAdapter(makeConfig());
  });

  it("connect() opens a WebSocket connection", async () => {
    await adapter.connect();
    expect(MockWebSocket).toHaveBeenCalledWith("ws://localhost:9999", expect.any(Object));
  });

  it("healthCheck returns true when connected", async () => {
    await adapter.connect();
    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(true);
  });

  it("healthCheck returns false before connect", async () => {
    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(false);
  });

  it("query returns cached value after receiving message", async () => {
    await adapter.connect();

    const msg = JSON.stringify({
      dimension_name: "cpu_usage",
      value: 72,
      confidence: 0.95,
    });
    mockWsInstance.emit("message", { toString: () => msg });

    const result = await adapter.query({
      dimension_name: "cpu_usage",
      timeout_ms: 5000,
    });

    expect(result.source_id).toBe("test-ws");
    expect(result.value).toBe(72);
    expect(result.metadata?.confidence).toBe(0.95);
    expect(typeof result.timestamp).toBe("string");
  });

  it("query throws when dimension not in cache", async () => {
    await adapter.connect();
    await expect(
      adapter.query({ dimension_name: "missing", timeout_ms: 5000 })
    ).rejects.toThrow('no data for dimension "missing"');
  });

  it("disconnect closes the socket and clears cache", async () => {
    await adapter.connect();

    const msg = JSON.stringify({ dimension_name: "metric", value: 1 });
    mockWsInstance.emit("message", { toString: () => msg });

    await adapter.disconnect();

    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(false);

    // Cache cleared — querying should now throw
    await expect(
      adapter.query({ dimension_name: "metric", timeout_ms: 5000 })
    ).rejects.toThrow('no data for dimension "metric"');
  });

  it("ignores non-JSON messages", async () => {
    await adapter.connect();

    mockWsInstance.emit("message", { toString: () => "not json at all" });

    // Cache should remain empty for any dimension
    await expect(
      adapter.query({ dimension_name: "something", timeout_ms: 5000 })
    ).rejects.toThrow("no data");
  });

  it("ignores messages missing dimension_name field", async () => {
    await adapter.connect();

    const msg = JSON.stringify({ value: 42 }); // no dimension_name
    mockWsInstance.emit("message", { toString: () => msg });

    await expect(
      adapter.query({ dimension_name: "anything", timeout_ms: 5000 })
    ).rejects.toThrow("no data");
  });

  it("schedules reconnect after close when shouldReconnect=true", async () => {
    vi.useFakeTimers();
    await adapter.connect();

    // Simulate unexpected server close
    mockWsInstance.readyState = 3; // CLOSED
    mockWsInstance.emit("close");

    // A reconnect timer should be set
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    vi.useRealTimers();
  });

  it("does not reconnect after explicit disconnect()", async () => {
    vi.useFakeTimers();
    await adapter.connect();
    await adapter.disconnect();

    // No pending timers because shouldReconnect=false
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
  });

  it("throws when connect() called without connection.url", async () => {
    const noUrlAdapter = new WebSocketDataSourceAdapter(
      makeConfig({ connection: {} })
    );
    await expect(noUrlAdapter.connect()).rejects.toThrow(
      "connection.url is required"
    );
  });
});
