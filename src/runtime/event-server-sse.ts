import * as http from "node:http";
import type { ApprovalBroker } from "./approval-broker.js";
import type { Logger } from "./logger.js";
import type { OutboxRecord, OutboxStore } from "./store/index.js";

export class EventServerSseManager {
  private readonly sseClients = new Set<http.ServerResponse>();
  private eventIdCounter = 0;
  private broadcastChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly logger?: Logger,
    private approvalBroker?: ApprovalBroker,
    private outboxStore?: OutboxStore
  ) {}

  setApprovalBroker(broker: ApprovalBroker): void {
    this.approvalBroker = broker;
  }

  setOutboxStore(store: OutboxStore): void {
    this.outboxStore = store;
  }

  closeAllClients(): void {
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.sseClients.clear();
  }

  async broadcast(eventType: string, data: unknown): Promise<void> {
    await this.enqueueBroadcast(async () => {
      let outboxRecord: OutboxRecord | null = null;
      if (this.outboxStore) {
        outboxRecord = await this.outboxStore.append(this.toOutboxInput(eventType, data));
      }

      const id = outboxRecord ? String(outboxRecord.seq) : undefined;
      for (const client of this.sseClients) {
        try {
          this.writeSseEvent(client, eventType, data, id);
        } catch {
          this.sseClients.delete(client);
        }
      }
    }).catch((err) => {
      this.logger?.error(`EventServer: broadcast failed for ${eventType}: ${String(err)}`);
    });
  }

  async handleStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    const afterSeq = this.resolveReplayCursor(
      requestUrl.searchParams.get("after"),
      req.headers["last-event-id"]
    );

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);

    await this.enqueueBroadcast(async () => {
      const pendingApprovals = this.approvalBroker?.getPendingApprovalEvents() ?? [];
      const pendingApprovalIds = new Set(pendingApprovals.map((pending) => pending.requestId));
      const replayedApprovals = await this.replayOutbox(res, afterSeq, pendingApprovalIds);
      for (const pending of pendingApprovals) {
        if (replayedApprovals.has(pending.requestId)) continue;
        this.writeSseEvent(res, "approval_required", pending);
      }
      this.sseClients.add(res);
    }).catch((err) => {
      this.logger?.error(`EventServer: stream replay failed: ${String(err)}`);
      try {
        res.end();
      } catch {
        // ignore
      }
    });

    req.on("close", () => {
      this.sseClients.delete(res);
    });
    const keepAlive = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        clearInterval(keepAlive);
        this.sseClients.delete(res);
      }
    }, 30_000);
    req.on("close", () => clearInterval(keepAlive));
  }

  private resolveReplayCursor(
    queryAfter: string | null,
    lastEventIdHeader: string | string[] | undefined
  ): number {
    const headerValue = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader;
    return Math.max(this.parseReplayCursorValue(queryAfter), this.parseReplayCursorValue(headerValue));
  }

  private parseReplayCursorValue(value: string | null | undefined): number {
    if (!value) return 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private async replayOutbox(
    res: http.ServerResponse,
    afterSeq: number,
    pendingApprovalIds: ReadonlySet<string>
  ): Promise<Set<string>> {
    const replayedApprovals = new Set<string>();
    if (!this.outboxStore) return replayedApprovals;

    const records = await this.outboxStore.list(afterSeq);
    for (const record of records) {
      if (record.event_type === "approval_required" && isRecord(record.payload)) {
        const requestId = record.payload["requestId"];
        if (typeof requestId === "string") {
          if (pendingApprovalIds.has(requestId)) {
            continue;
          }
          replayedApprovals.add(requestId);
        }
      }
      this.writeSseEvent(res, record.event_type, record.payload, String(record.seq));
    }
    return replayedApprovals;
  }

  private toOutboxInput(eventType: string, data: unknown): Omit<OutboxRecord, "seq"> {
    const record: Omit<OutboxRecord, "seq"> = {
      event_type: eventType,
      created_at: Date.now(),
      payload: data,
    };

    if (isRecord(data)) {
      const goalId = data["goalId"] ?? data["goal_id"];
      const correlationId =
        data["correlationId"] ?? data["correlation_id"] ?? data["requestId"] ?? data["request_id"];
      if (typeof goalId === "string") record.goal_id = goalId;
      if (typeof correlationId === "string") record.correlation_id = correlationId;
    }

    return record;
  }

  private enqueueBroadcast<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.broadcastChain.then(operation, operation);
    this.broadcastChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private writeSseEvent(
    res: http.ServerResponse,
    eventType: string,
    data: unknown,
    id?: string
  ): void {
    const eventId = id ?? String(++this.eventIdCounter);
    res.write(`id: ${eventId}\nevent: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
