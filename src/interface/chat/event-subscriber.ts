import { EventEmitter } from "node:events";

export interface TendNotification {
  type: "progress" | "stall" | "complete" | "error";
  goalId: string;
  message: string;
  iteration?: number;
  maxIterations?: number;
  gap?: number;
  previousGap?: number;
}

export type NotificationVerbosity = "verbose" | "normal" | "quiet";

interface RawProgressEvent {
  iteration?: number;
  maxIterations?: number;
  phase?: string;
  gap?: number;
  taskDescription?: string;
  skipReason?: string;
}

export class EventSubscriber extends EventEmitter {
  private abortController: AbortController | null = null;
  private previousGap: number | undefined = undefined;

  constructor(
    private baseUrl: string,
    private goalId: string,
    private verbosity: NotificationVerbosity = "normal"
  ) {
    super();
  }

  /** Start listening to SSE stream from daemon EventServer */
  async subscribe(): Promise<void> {
    this.abortController?.abort();
    this.abortController = new AbortController();
    await this.connect(false);
  }

  private async connect(isRetry: boolean): Promise<void> {
    if (this.abortController?.signal.aborted) return;

    try {
      const res = await fetch(`${this.baseUrl}/stream`, {
        headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
        signal: this.abortController!.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed: HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          this.parseSSEMessage(part);
        }
      }

      // Stream ended — attempt reconnect once if not aborted
      if (!this.abortController?.signal.aborted && !isRetry) {
        await this.connect(true);
      }
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      const notification: TendNotification = {
        type: "error",
        goalId: this.goalId,
        message: `⚠️ [tend] ${this.goalId}: Connection error — ${String(err)}`,
      };
      this.emit("notification", notification);
      // Retry once on error
      if (!isRetry && !this.abortController?.signal.aborted) {
        await new Promise((r) => setTimeout(r, 2000));
        await this.connect(true);
      }
    }
  }

  /** Stop listening */
  unsubscribe(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private parseSSEMessage(raw: string): void {
    let eventType = "message";
    let data = "";

    for (const line of raw.split("\n")) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        data += (data ? "
" : "") + line.slice(6);
      }
    }

    if (!data) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    const notification = this.formatNotification(eventType, parsed);
    if (notification) {
      this.emit("notification", notification);
    }
  }

  /** Format a raw SSE event into a TendNotification (returns null if verbosity filters it out) */
  private formatNotification(eventType: string, data: unknown): TendNotification | null {
    const shortId = this.goalId.length > 12 ? this.goalId.slice(0, 12) : this.goalId;

    if (eventType === "progress") {
      const ev = data as RawProgressEvent;
      const iter = ev.iteration;
      const max = ev.maxIterations;
      const gap = ev.gap;
      const phase = ev.phase ?? "";

      // Complete phase
      if (phase === "complete" || phase.toLowerCase().includes("complete")) {
        const msg = `✅ [tend] ${shortId}: Complete! gap: ${gap?.toFixed(2) ?? "?"}, ${iter ?? "?"} iterations`;
        const n: TendNotification = { type: "complete", goalId: this.goalId, message: msg, iteration: iter, maxIterations: max, gap };
        this.previousGap = undefined;
        return n;
      }

      // Stall / skip
      if (phase === "Skipped" || phase === "Skipped (no state change)" || phase.toLowerCase().includes("stall")) {
        const reason = ev.skipReason ?? phase;
        const msg = `⚠️ [tend] ${shortId}: Stalled — "${reason}"`;
        return { type: "stall", goalId: this.goalId, message: msg, iteration: iter, maxIterations: max, gap };
      }

      // Iteration summary — gap update on Observing/Verifying
      if (gap !== undefined && (phase === "Observing..." || phase === "Verifying result...")) {
        if (this.verbosity === "normal" || this.verbosity === "verbose") {
          const prev = this.previousGap;
          const prevStr = prev !== undefined ? `${prev.toFixed(2)}→` : "";
          const msg = `🌱 [tend] ${shortId}: [${iter ?? "?"}/${max ?? "?"}] gap: ${prevStr}${gap.toFixed(2)}`;
          this.previousGap = gap;
          return { type: "progress", goalId: this.goalId, message: msg, iteration: iter, maxIterations: max, gap, previousGap: prev };
        }
        this.previousGap = gap;
        return null;
      }

      // Executing phase
      if (phase === "Executing task...") {
        if (this.verbosity === "verbose") {
          const task = ev.taskDescription ?? "...";
          const msg = `🌱 [tend] ${shortId}: [${iter ?? "?"}/${max ?? "?"}] Executing: "${task}"`;
          return { type: "progress", goalId: this.goalId, message: msg, iteration: iter, maxIterations: max };
        }
        return null;
      }

      // All other phases — verbose only
      if (this.verbosity === "verbose") {
        const msg = `🌱 [tend] ${shortId}: [${iter ?? "?"}/${max ?? "?"}] ${phase}`;
        return { type: "progress", goalId: this.goalId, message: msg, iteration: iter, maxIterations: max, gap };
      }

      return null;
    }

    // CoreLoop completion broadcast
    if (eventType === "loop_complete" || eventType === "goal_complete") {
      const ev = data as Record<string, unknown>;
      const gap = typeof ev["gap"] === "number" ? ev["gap"] : undefined;
      const iterations = typeof ev["iterations"] === "number" ? ev["iterations"] : undefined;
      const msg = `✅ [tend] ${shortId}: Complete! gap: ${gap?.toFixed(2) ?? "?"}, ${iterations ?? "?"} iterations`;
      this.previousGap = undefined;
      return { type: "complete", goalId: this.goalId, message: msg, gap };
    }

    return null;
  }
}
