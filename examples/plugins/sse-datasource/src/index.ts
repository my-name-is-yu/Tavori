// ─── SseDataSourceAdapter ───
//
// A PulSeed data source plugin that subscribes to a Server-Sent Events stream.
// SSE event type is used as the dimension_name key for the latest-value cache.
// Reconnection is handled natively by the EventSource spec / eventsource package.

import EventSource from "eventsource";
import type {
  DataSourceConfig,
  DataSourceQuery,
  DataSourceResult,
} from "../../../../src/types/data-source.js";
import type { IDataSourceAdapter } from "../../../../src/observation/data-source-adapter.js";

// ─── Adapter ───

export class SseDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType = "sse" as const;
  readonly config: DataSourceConfig;

  private es: EventSource | null = null;
  private cache: Map<string, DataSourceResult> = new Map();
  private connected = false;

  constructor(config: DataSourceConfig) {
    this.config = config;
    this.sourceId = config.id;
  }

  // ─── Public API ───

  async connect(): Promise<void> {
    const url = this.config.connection.url;
    if (!url) {
      throw new Error(
        `SseDataSourceAdapter [${this.sourceId}]: connection.url is required`
      );
    }

    return new Promise((resolve, reject) => {
      const initDict: { headers?: Record<string, string> } = {};
      if (this.config.connection.headers) {
        initDict.headers = this.config.connection.headers;
      }

      const es = new EventSource(url, initDict);

      es.onopen = () => {
        this.es = es;
        this.connected = true;
        resolve();
      };

      es.onerror = (err) => {
        if (!this.connected) {
          reject(new Error(
            `SseDataSourceAdapter [${this.sourceId}]: failed to connect to ${url}`
          ));
        }
        // After initial connect, onerror is handled by EventSource reconnect logic
        void err;
      };

      // Listen to all named events by subscribing to the generic "message" event.
      // For named events, callers can override via dimension_mapping in config.
      es.onmessage = (event: MessageEvent) => {
        this._handleEvent("message", event.data as string);
      };

      // Also capture named events via a proxy on addEventListener —
      // we register known event types from dimension_mapping if provided.
      const mapping = this.config.dimension_mapping ?? {};
      for (const eventType of Object.keys(mapping)) {
        es.addEventListener(eventType, (event: MessageEvent) => {
          this._handleEvent(eventType, event.data as string);
        });
      }
    });
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    const cached = this.cache.get(params.dimension_name);
    if (!cached) {
      throw new Error(
        `SseDataSourceAdapter [${this.sourceId}]: no data for dimension "${params.dimension_name}" — not yet received from stream`
      );
    }
    return cached;
  }

  async disconnect(): Promise<void> {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this.connected = false;
    this.cache.clear();
  }

  async healthCheck(): Promise<boolean> {
    return this.es !== null && this.es.readyState === EventSource.OPEN;
  }

  // ─── Internal ───

  private _handleEvent(eventType: string, rawData: string): void {
    let parsed: unknown;
    let value: number | string | boolean | null;

    try {
      parsed = JSON.parse(rawData);
      const obj = parsed as Record<string, unknown>;
      const v = obj["value"];
      if (
        typeof v === "number" ||
        typeof v === "string" ||
        typeof v === "boolean"
      ) {
        value = v;
      } else {
        value = rawData;
      }
    } catch {
      // plain text data
      parsed = rawData;
      value = rawData;
    }

    // Resolve dimension_name: check dimension_mapping first, then use event type
    const mapping = this.config.dimension_mapping ?? {};
    const dimensionName = mapping[eventType] ?? eventType;

    this.cache.set(dimensionName, {
      value,
      raw: parsed,
      timestamp: new Date().toISOString(),
      source_id: this.sourceId,
    });
  }
}
