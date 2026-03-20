// ─── SseDataSourceAdapter tests ───
//
// Uses vi.mock to replace the "eventsource" package so the test runs without a
// real SSE server and without installing eventsource in the plugin directory.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoist mock definitions ───

const { MockEventSource, getLatestInstance } = vi.hoisted(() => {
  type AnyListener = (event: unknown) => void;

  class MockEventSourceInstance {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;

    readyState: number = MockEventSourceInstance.OPEN;
    onerror: AnyListener | null = null;

    // Use a setter so that assigning onopen immediately fires it (simulates
    // a synchronously-resolved connection for testing convenience).
    private _onopen: AnyListener | null = null;
    set onopen(fn: AnyListener | null) {
      this._onopen = fn;
      if (fn) {
        // Fire asynchronously to match real EventSource behavior
        Promise.resolve().then(() => fn({}));
      }
    }
    get onopen(): AnyListener | null {
      return this._onopen;
    }

    // onmessage fires via simulateMessage
    onmessage: AnyListener | null = null;

    private namedListeners: Map<string, AnyListener[]> = new Map();

    addEventListener(type: string, listener: AnyListener) {
      if (!this.namedListeners.has(type)) this.namedListeners.set(type, []);
      this.namedListeners.get(type)!.push(listener);
    }

    removeEventListener(type: string, listener: AnyListener) {
      const listeners = this.namedListeners.get(type) ?? [];
      this.namedListeners.set(type, listeners.filter((l) => l !== listener));
    }

    simulateMessage(data: string) {
      if (this.onmessage) this.onmessage({ data, type: "message" });
    }

    simulateNamedEvent(eventType: string, data: string) {
      (this.namedListeners.get(eventType) ?? []).forEach((l) =>
        l({ data, type: eventType })
      );
    }

    close() {
      this.readyState = MockEventSourceInstance.CLOSED;
    }
  }

  let latestInstance: MockEventSourceInstance | null = null;

  const MockEventSource = vi.fn().mockImplementation(() => {
    const instance = new MockEventSourceInstance();
    latestInstance = instance;
    return instance;
  });

  (MockEventSource as unknown as Record<string, number>).OPEN = MockEventSourceInstance.OPEN;
  (MockEventSource as unknown as Record<string, number>).CLOSED = MockEventSourceInstance.CLOSED;
  (MockEventSource as unknown as Record<string, number>).CONNECTING = MockEventSourceInstance.CONNECTING;

  function getLatestInstance(): MockEventSourceInstance {
    if (!latestInstance) throw new Error("No MockEventSourceInstance created yet");
    return latestInstance;
  }

  return { MockEventSource, getLatestInstance };
});

vi.mock("eventsource", () => ({
  default: MockEventSource,
}));

// ─── Import after mock ───

import { SseDataSourceAdapter } from "../examples/plugins/sse-datasource/src/index.js";
import type { DataSourceConfig } from "../src/types/data-source.js";

// ─── Helpers ───

function makeConfig(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: "test-sse",
    name: "Test SSE",
    type: "sse",
    connection: { url: "http://localhost:8080/events" },
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ───

describe("SseDataSourceAdapter", () => {
  let adapter: SseDataSourceAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new SseDataSourceAdapter(makeConfig());
  });

  it("connect() creates an EventSource with the configured URL", async () => {
    await adapter.connect();
    expect(MockEventSource).toHaveBeenCalledWith(
      "http://localhost:8080/events",
      expect.any(Object)
    );
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

  it("query returns cached value after receiving message event", async () => {
    await adapter.connect();
    const es = getLatestInstance();

    const data = JSON.stringify({ value: 55 });
    es.simulateMessage(data);

    const result = await adapter.query({
      dimension_name: "message",
      timeout_ms: 5000,
    });

    expect(result.source_id).toBe("test-sse");
    expect(result.value).toBe(55);
    expect(typeof result.timestamp).toBe("string");
  });

  it("query stores plain text value when data is not JSON", async () => {
    await adapter.connect();
    const es = getLatestInstance();

    es.simulateMessage("hello world");

    const result = await adapter.query({
      dimension_name: "message",
      timeout_ms: 5000,
    });

    expect(result.value).toBe("hello world");
    expect(result.raw).toBe("hello world");
  });

  it("named event type is mapped to dimension_name via dimension_mapping", async () => {
    const cfg = makeConfig({ dimension_mapping: { cpu: "cpu_usage" } });
    adapter = new SseDataSourceAdapter(cfg);
    await adapter.connect();
    const es = getLatestInstance();

    const data = JSON.stringify({ value: 80 });
    es.simulateNamedEvent("cpu", data);

    const result = await adapter.query({
      dimension_name: "cpu_usage",
      timeout_ms: 5000,
    });

    expect(result.value).toBe(80);
  });

  it("query throws when dimension not in cache", async () => {
    await adapter.connect();
    await expect(
      adapter.query({ dimension_name: "unknown", timeout_ms: 5000 })
    ).rejects.toThrow('no data for dimension "unknown"');
  });

  it("disconnect closes the EventSource and clears cache", async () => {
    await adapter.connect();
    const es = getLatestInstance();

    es.simulateMessage(JSON.stringify({ value: 10 }));
    await adapter.disconnect();

    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(false);

    await expect(
      adapter.query({ dimension_name: "message", timeout_ms: 5000 })
    ).rejects.toThrow("no data");
  });

  it("throws when connect() called without connection.url", async () => {
    const noUrlAdapter = new SseDataSourceAdapter(
      makeConfig({ connection: {} })
    );
    await expect(noUrlAdapter.connect()).rejects.toThrow(
      "connection.url is required"
    );
  });
});
