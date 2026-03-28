// ─── WebSocketDataSourceAdapter ───
//
// A PulSeed data source plugin that subscribes to a WebSocket stream.
// Uses a latest-value cache keyed by dimension_name. Auto-reconnects with
// exponential backoff (1s → 2s → 4s … max 30s).

import WebSocket from "ws";
import type {
  DataSourceConfig,
  DataSourceQuery,
  DataSourceResult,
} from "../../../../src/types/data-source.js";
import type { IDataSourceAdapter } from "../../../../src/observation/data-source-adapter.js";

// ─── Types ───

interface WsMessage {
  dimension_name: string;
  value: number | string | boolean;
  confidence?: number;
}

// ─── Constants ───

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;

// ─── Adapter ───

export class WebSocketDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType = "websocket" as const;
  readonly config: DataSourceConfig;

  private ws: WebSocket | null = null;
  private cache: Map<string, DataSourceResult> = new Map();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;

  constructor(config: DataSourceConfig) {
    this.config = config;
    this.sourceId = config.id;
  }

  // ─── Public API ───

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    await this._openConnection();
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    const cached = this.cache.get(params.dimension_name);
    if (!cached) {
      throw new Error(
        `WebSocketDataSourceAdapter [${this.sourceId}]: no data for dimension "${params.dimension_name}" — not yet received from stream`
      );
    }
    return cached;
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.cache.clear();
  }

  async healthCheck(): Promise<boolean> {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ─── Internal ───

  private async _openConnection(): Promise<void> {
    const url = this.config.connection.url;
    if (!url) {
      throw new Error(
        `WebSocketDataSourceAdapter [${this.sourceId}]: connection.url is required`
      );
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: this.config.connection.headers,
      });

      ws.on("open", () => {
        this.ws = ws;
        this.reconnectAttempt = 0;
        resolve();
      });

      ws.on("message", (data) => {
        this._handleMessage(data.toString());
      });

      ws.on("error", (err) => {
        // Only reject on first connection; subsequent errors handled by close
        if (this.ws === null) {
          reject(err);
        }
      });

      ws.on("close", () => {
        this.ws = null;
        if (this.shouldReconnect) {
          this._scheduleReconnect();
        }
      });
    });
  }

  private _handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // ignore non-JSON messages
    }

    const msg = parsed as WsMessage;
    if (typeof msg.dimension_name !== "string") return;

    this.cache.set(msg.dimension_name, {
      value: msg.value ?? null,
      raw: parsed,
      timestamp: new Date().toISOString(),
      source_id: this.sourceId,
      metadata: {
        confidence: typeof msg.confidence === "number" ? msg.confidence : 1.0,
      },
    });
  }

  private _scheduleReconnect(): void {
    const delay = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempt),
      BACKOFF_MAX_MS
    );
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this._openConnection().catch(() => {
          // will retry via close event
        });
      }
    }, delay);
  }
}
