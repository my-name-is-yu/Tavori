// ─── A2AClient ───
//
// HTTP/SSE client for A2A (Agent-to-Agent) Protocol v0.3 JSON-RPC calls.
// Uses Node.js built-in fetch (Node 18+) to avoid external HTTP dependencies.

import { randomUUID } from "node:crypto";
import type {
  A2AAgentCard,
  A2ATask,
  A2ATaskState,
  A2AMessage,
  A2AJsonRpcResponse,
} from "../types/a2a.js";
import {
  A2AAgentCardSchema,
  A2ATaskSchema,
  A2AJsonRpcResponseSchema,
  A2A_TERMINAL_STATES,
} from "../types/a2a.js";

// ─── Config ───

export interface A2AClientConfig {
  /** Base URL of the A2A agent (e.g. "https://agent.example.com") */
  baseUrl: string;
  /** Auth token (Bearer). Optional — depends on agent's securitySchemes. */
  authToken?: string;
  /** Polling interval when SSE is not supported. Default: 2000ms */
  pollIntervalMs?: number;
  /** Maximum total wait time for task completion. Default: 300_000ms (5 min) */
  maxWaitMs?: number;
}

// ─── Client ───

export class A2AClient {
  private readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;

  constructor(config: A2AClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.authToken = config.authToken;
    this.pollIntervalMs = config.pollIntervalMs ?? 2_000;
    this.maxWaitMs = config.maxWaitMs ?? 300_000;
  }

  // ─── Agent Card Discovery ───

  async fetchAgentCard(): Promise<A2AAgentCard> {
    const url = `${this.baseUrl}/.well-known/agent.json`;
    const res = await this.httpGet(url);
    return A2AAgentCardSchema.parse(res);
  }

  // ─── message/send (blocking) ───

  async sendMessage(message: A2AMessage): Promise<A2ATask> {
    const body = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message/send",
      params: { message },
    };
    const res = await this.jsonRpc(body);
    return A2ATaskSchema.parse(res);
  }

  // ─── tasks/get ───

  async getTask(taskId: string): Promise<A2ATask> {
    const body = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tasks/get",
      params: { id: taskId },
    };
    const res = await this.jsonRpc(body);
    return A2ATaskSchema.parse(res);
  }

  // ─── tasks/cancel ───

  async cancelTask(taskId: string): Promise<void> {
    const body = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tasks/cancel",
      params: { id: taskId },
    };
    await this.jsonRpc(body);
  }

  // ─── Polling loop ───

  async waitForCompletion(
    taskId: string,
    signal?: AbortSignal
  ): Promise<A2ATask> {
    const deadline = Date.now() + this.maxWaitMs;

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new Error("A2A task wait aborted");
      }

      const task = await this.getTask(taskId);
      if (A2A_TERMINAL_STATES.has(task.status.state)) {
        return task;
      }

      await sleep(this.pollIntervalMs);
    }

    // Attempt cancel on timeout
    try {
      await this.cancelTask(taskId);
    } catch {
      /* best-effort */
    }
    throw new Error(
      `A2A task ${taskId} did not complete within ${this.maxWaitMs}ms`
    );
  }

  // ─── SSE streaming (message/stream) ───

  async sendMessageStream(
    message: A2AMessage,
    onStatus?: (state: A2ATaskState, msg?: string) => void,
    signal?: AbortSignal
  ): Promise<A2ATask> {
    const body = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message/stream",
      params: { message },
    };

    const res = await fetch(`${this.baseUrl}`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      throw new Error(
        `A2A stream request failed: ${res.status} ${res.statusText}`
      );
    }

    if (!res.body) {
      throw new Error("A2A stream response has no body");
    }

    // Parse SSE events from the response stream
    let latestTask: A2ATask | null = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            const kind = parsed.kind as string | undefined;

            if (kind === "task" || (!kind && parsed.id && parsed.status)) {
              latestTask = A2ATaskSchema.parse(parsed);
            } else if (kind === "status-update" && parsed.status) {
              const status = parsed.status as {
                state?: string;
                message?: string;
              };
              if (status.state) {
                onStatus?.(status.state as A2ATaskState, status.message);
              }
            }
            // artifact-update events are accumulated in the task object
          } catch {
            // Skip malformed SSE data lines
          }
        }
      }
    }

    if (!latestTask) {
      throw new Error("A2A stream ended without returning a task");
    }
    return latestTask;
  }

  // ─── Private ───

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }
    return headers;
  }

  private async httpGet(url: string): Promise<unknown> {
    const res = await fetch(url, { headers: this.buildHeaders() });
    if (!res.ok) {
      throw new Error(
        `A2A GET ${url} failed: ${res.status} ${res.statusText}`
      );
    }
    return res.json();
  }

  private async jsonRpc(body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(
        `A2A JSON-RPC failed: ${res.status} ${res.statusText}`
      );
    }

    const json = A2AJsonRpcResponseSchema.parse(await res.json());
    if (json.error) {
      throw new Error(
        `A2A JSON-RPC error ${json.error.code}: ${json.error.message}`
      );
    }
    return json.result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
