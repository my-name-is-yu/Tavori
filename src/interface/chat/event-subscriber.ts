import { EventEmitter } from "node:events";
import { readDaemonAuthToken } from "../../runtime/daemon/client.js";

export interface TendNotification {
  type: "progress" | "stall" | "complete" | "error" | "approval";
  goalId: string;
  message: string;
  iteration?: number;
  maxIterations?: number;
  gap?: number;
  previousGap?: number;
  requestId?: string;
  reportType?: string;
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

interface RawNotificationReport {
  report_type?: string;
  title?: string;
  content?: string;
  goal_id?: string | null;
}

export class EventSubscriber extends EventEmitter {
  private abortController: AbortController | null = null;
  private previousGap: number | undefined = undefined;
  private lastOutboxSeq = 0;
  private snapshotBootstrapped = false;

  constructor(
    private baseUrl: string,
    private goalId: string,
    private verbosity: NotificationVerbosity = "normal",
    private authToken: string | null = readDaemonAuthToken()
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
      if (!this.snapshotBootstrapped) {
        await this.bootstrapSnapshot();
      }

      const res = await fetch(`${this.baseUrl}/stream?after=${this.lastOutboxSeq}`, {
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          ...this.authHeaders(),
        },
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
    let id = "";
    let eventType = "message";
    let data = "";

    for (const line of raw.split("\n")) {
      if (line.startsWith("id: ")) {
        id = line.slice(4).trim();
      } else if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        data += (data ? "\n" : "") + line.slice(6);
      }
    }

    if (!data) return;
    const seq = Number.parseInt(id, 10);
    if (Number.isFinite(seq) && seq > this.lastOutboxSeq) {
      this.lastOutboxSeq = seq;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (!this.matchesGoal(parsed)) {
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

    if (eventType === "notification_report") {
      const report = data as RawNotificationReport;
      if (report.report_type === "approval_request") {
        return null;
      }
      const title = report.title ?? report.report_type ?? "Notification";
      const prefix = report.report_type === "weekly_report"
        ? "🗓"
        : report.report_type === "daily_summary"
          ? "📰"
          : report.report_type === "urgent_alert"
            ? "⚠️"
            : "🔔";
      return {
        type: "progress",
        goalId: this.goalId,
        reportType: report.report_type,
        message: `${prefix} [tend] ${shortId}: ${title}`,
      };
    }

    if (eventType === "approval_required") {
      const ev = data as {
        requestId?: string;
        goalId?: string;
        task?: { description?: string; action?: string };
      };
      const description = ev.task?.description ?? ev.task?.action ?? "A task requires approval";
      return {
        type: "approval",
        goalId: this.goalId,
        requestId: ev.requestId,
        message: `🛂 [tend] ${shortId}: Approval required — ${description}`,
      };
    }

    if (eventType === "approval_resolved") {
      const ev = data as { approved?: boolean };
      const decision = ev.approved ? "approved" : "rejected";
      return {
        type: "progress",
        goalId: this.goalId,
        message: `🧾 [tend] ${shortId}: Approval ${decision}`,
      };
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

  private matchesGoal(data: unknown): boolean {
    if (typeof data !== "object" || data === null) return true;
    const goalId = (data as Record<string, unknown>)["goalId"] ?? (data as Record<string, unknown>)["goal_id"];
    return typeof goalId === "string" ? goalId === this.goalId : true;
  }

  private async bootstrapSnapshot(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/snapshot`, {
        headers: { Accept: "application/json", ...this.authHeaders() },
        signal: this.abortController!.signal,
      });
      if (!res.ok) {
        throw new Error(`snapshot failed: HTTP ${res.status}`);
      }
      const snapshot = await res.json() as {
        approvals?: unknown[];
        last_outbox_seq?: number;
      };
      this.snapshotBootstrapped = true;
      this.lastOutboxSeq = Math.max(this.lastOutboxSeq, snapshot.last_outbox_seq ?? 0);
      for (const approval of snapshot.approvals ?? []) {
        if (!this.matchesGoal(approval)) continue;
        const notification = this.formatNotification("approval_required", approval);
        if (notification) {
          this.emit("notification", notification);
        }
      }
    } catch {
      // Snapshot bootstrap is best-effort.
    }
  }

  private authHeaders(): Record<string, string> {
    return this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {};
  }
}
