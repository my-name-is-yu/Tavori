import type { Logger } from "./logger.js";
import { ApprovalStore } from "./store/approval-store.js";
import type { ApprovalRecord } from "./store/runtime-schemas.js";

export interface ApprovalTaskRequest {
  id: string;
  description: string;
  action: string;
}

export interface ApprovalRequiredEvent {
  requestId: string;
  goalId?: string;
  task: ApprovalTaskRequest;
  expiresAt: number;
  restored?: boolean;
}

export interface ApprovalBrokerOptions {
  store: ApprovalStore;
  logger?: Logger;
  broadcast?: (eventType: string, data: unknown) => void;
  now?: () => number;
  createId?: () => string;
  defaultTimeoutMs?: number;
}

interface PendingApprovalSession {
  record: ApprovalRecord;
  resolve?: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalBroker {
  private readonly store: ApprovalStore;
  private readonly logger?: Logger;
  private readonly broadcast?: (eventType: string, data: unknown) => void;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly defaultTimeoutMs: number;
  private readonly pending = new Map<string, PendingApprovalSession>();
  private started = false;

  constructor(options: ApprovalBrokerOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.broadcast = options.broadcast;
    this.now = options.now ?? (() => Date.now());
    this.createId =
      options.createId ??
      (() => `approval-${this.now()}-${Math.random().toString(36).slice(2, 8)}`);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5 * 60 * 1000;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    const records = await this.store.listPending();
    for (const record of records) {
      if (record.expires_at <= this.now()) {
        await this.finalizeApproval(record.approval_id, {
          state: "expired",
          approved: false,
          reason: "timeout",
          responseChannel: "system",
        });
        continue;
      }
      this.trackPending(record);
    }
  }

  async stop(): Promise<void> {
    for (const session of this.pending.values()) {
      clearTimeout(session.timer);
    }
    this.pending.clear();
    this.started = false;
  }

  async requestApproval(
    goalId: string,
    task: ApprovalTaskRequest,
    timeoutMs = this.defaultTimeoutMs
  ): Promise<boolean> {
    await this.start();

    const createdAt = this.now();
    const approvalId = this.createId();
    const record: ApprovalRecord = {
      approval_id: approvalId,
      goal_id: goalId,
      request_envelope_id: approvalId,
      correlation_id: approvalId,
      state: "pending",
      created_at: createdAt,
      expires_at: createdAt + timeoutMs,
      payload: { task },
    };

    await this.store.savePending(record);

    return new Promise<boolean>((resolve) => {
      this.trackPending(record, resolve);
      this.emitApprovalRequired(record, false);
    });
  }

  async resolveApproval(
    approvalId: string,
    approved: boolean,
    responseChannel = "http"
  ): Promise<boolean> {
    const resolved = await this.finalizeApproval(approvalId, {
      state: approved ? "approved" : "denied",
      approved,
      responseChannel,
    });
    return resolved !== null;
  }

  getPendingApprovalEvents(): ApprovalRequiredEvent[] {
    return [...this.pending.values()]
      .map(({ record }) => this.toApprovalRequiredEvent(record, true))
      .sort((a, b) => a.expiresAt - b.expiresAt);
  }

  private trackPending(record: ApprovalRecord, resolve?: (approved: boolean) => void): void {
    const existing = this.pending.get(record.approval_id);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const msUntilExpiry = Math.max(record.expires_at - this.now(), 0);
    const timer = setTimeout(() => {
      void this.finalizeApproval(record.approval_id, {
        state: "expired",
        approved: false,
        reason: "timeout",
        responseChannel: "system",
      }).catch((err) => {
        this.logger?.error("ApprovalBroker: failed to expire approval", {
          approvalId: record.approval_id,
          error: String(err),
        });
      });
    }, msUntilExpiry);

    this.pending.set(record.approval_id, { record, resolve, timer });
  }

  private async finalizeApproval(
    approvalId: string,
    resolution: {
      state: "approved" | "denied" | "expired" | "cancelled";
      approved: boolean;
      reason?: string;
      responseChannel?: string;
    }
  ): Promise<ApprovalRecord | null> {
    const session = this.pending.get(approvalId);
    if (session) {
      clearTimeout(session.timer);
      this.pending.delete(approvalId);
    }

    const resolved = await this.store.resolvePending(approvalId, {
      state: resolution.state,
      resolved_at: this.now(),
      response_channel: resolution.responseChannel,
    });
    if (resolved === null) {
      return null;
    }

    session?.resolve?.(resolution.approved);
    this.broadcast?.("approval_resolved", {
      requestId: approvalId,
      approved: resolution.approved,
      reason: resolution.reason,
      responseChannel: resolution.responseChannel,
    });
    return resolved;
  }

  private emitApprovalRequired(record: ApprovalRecord, restored: boolean): void {
    this.broadcast?.("approval_required", this.toApprovalRequiredEvent(record, restored));
  }

  private toApprovalRequiredEvent(record: ApprovalRecord, restored: boolean): ApprovalRequiredEvent {
    const payload = record.payload as { task?: ApprovalTaskRequest };
    return {
      requestId: record.approval_id,
      goalId: record.goal_id,
      task: payload.task ?? { id: "", description: "", action: "" },
      expiresAt: record.expires_at,
      restored,
    };
  }
}
