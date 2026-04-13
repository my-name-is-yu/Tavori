import {
  JournalBackedQueue,
  type JournalBackedQueueClaim,
} from "./queue/journal-backed-queue.js";
import type { Envelope } from "./types/envelope.js";
import type { Logger } from "./logger.js";
import { RuntimeControlOperationKindSchema } from "./store/index.js";
import type { RuntimeControlOperationKind } from "./store/index.js";

export interface CommandDispatcherDeps {
  journalQueue: JournalBackedQueue;
  logger?: Logger;
  onGoalStart?: (goalId: string, envelope: Envelope) => Promise<void> | void;
  onGoalStop?: (goalId: string, envelope: Envelope) => Promise<void> | void;
  onChatMessage?: (
    goalId: string,
    message: string,
    envelope: Envelope
  ) => Promise<void> | void;
  onApprovalResponse?: (
    goalId: string | undefined,
    requestId: string,
    approved: boolean,
    envelope: Envelope
  ) => Promise<void> | void;
  onRuntimeControl?: (
    operationId: string,
    kind: RuntimeControlOperationKind,
    envelope: Envelope
  ) => Promise<void> | void;
}

export interface CommandDispatcherConfig {
  pollIntervalMs: number;
  claimLeaseMs: number;
}

const DEFAULT_CONFIG: CommandDispatcherConfig = {
  pollIntervalMs: 100,
  claimLeaseMs: 30_000,
};

export class CommandDispatcher {
  private readonly deps: CommandDispatcherDeps;
  private readonly config: CommandDispatcherConfig;
  private readonly workerId: string;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private polling = false;
  private inFlight = new Set<Promise<void>>();

  constructor(deps: CommandDispatcherDeps, config?: Partial<CommandDispatcherConfig>) {
    this.deps = deps;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.workerId = `command-dispatcher:${process.pid}`;
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    await this.pollOnce();
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.config.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await Promise.allSettled(this.inFlight);
  }

  private async pollOnce(): Promise<void> {
    if (!this.running || this.polling) return;
    this.polling = true;
    try {
      while (this.running) {
        const claimed = this.deps.journalQueue.claim(
          this.workerId,
          this.config.claimLeaseMs,
          (envelope) => envelope.type === "command"
        );
        if (!claimed) break;
        const task = this.dispatch(claimed);
        this.inFlight.add(task);
        await task.finally(() => {
          this.inFlight.delete(task);
        });
      }
    } finally {
      this.polling = false;
    }
  }

  private async dispatch(claimed: JournalBackedQueueClaim): Promise<void> {
    try {
      await this.handleEnvelope(claimed.envelope);
      this.ackClaim(claimed);
    } catch (err) {
      this.deps.logger?.warn("Command dispatch failed", {
        command: claimed.envelope.name,
        goalId: claimed.envelope.goal_id,
        error: err instanceof Error ? err.message : String(err),
      });
      this.nackClaim(claimed, err instanceof Error ? err.message : String(err));
    }
  }

  private async handleEnvelope(envelope: Envelope): Promise<void> {
    switch (envelope.name) {
      case "goal_start": {
        const goalId = envelope.goal_id ?? this.readStringField(envelope.payload, "goalId");
        if (!goalId) {
          throw new Error("goal_start command is missing goalId");
        }
        await this.deps.onGoalStart?.(goalId, envelope);
        return;
      }
      case "goal_stop": {
        const goalId = envelope.goal_id ?? this.readStringField(envelope.payload, "goalId");
        if (!goalId) {
          throw new Error("goal_stop command is missing goalId");
        }
        await this.deps.onGoalStop?.(goalId, envelope);
        return;
      }
      case "chat_message": {
        const goalId = envelope.goal_id ?? this.readStringField(envelope.payload, "goalId");
        const message = this.readStringField(envelope.payload, "message");
        if (!goalId || !message) {
          throw new Error("chat_message command is missing goalId or message");
        }
        await this.deps.onChatMessage?.(goalId, message, envelope);
        return;
      }
      case "approval_response": {
        const requestId = this.readStringField(envelope.payload, "requestId");
        const approved = this.readBooleanField(envelope.payload, "approved");
        if (!requestId || approved === undefined) {
          throw new Error("approval_response command is missing requestId or approved");
        }
        await this.deps.onApprovalResponse?.(envelope.goal_id, requestId, approved, envelope);
        return;
      }
      case "runtime_control": {
        const operationId = this.readStringField(envelope.payload, "operationId");
        const kindRaw = this.readStringField(envelope.payload, "kind");
        const kind = RuntimeControlOperationKindSchema.parse(kindRaw);
        if (!operationId) {
          throw new Error("runtime_control command is missing operationId");
        }
        await this.deps.onRuntimeControl?.(operationId, kind, envelope);
        return;
      }
      default:
        this.deps.logger?.warn("Ignoring unsupported command envelope", {
          command: envelope.name,
          goalId: envelope.goal_id,
        });
    }
  }

  private ackClaim(claimed: JournalBackedQueueClaim): void {
    const acked = this.deps.journalQueue.ack(claimed.claimToken);
    if (!acked) {
      this.deps.logger?.warn("Failed to ack durable command claim", {
        command: claimed.envelope.name,
        claimToken: claimed.claimToken,
      });
    }
  }

  private nackClaim(claimed: JournalBackedQueueClaim, reason: string): void {
    const settled = this.deps.journalQueue.nack(claimed.claimToken, reason, true);
    if (!settled) {
      this.deps.logger?.warn("Failed to nack durable command claim", {
        command: claimed.envelope.name,
        claimToken: claimed.claimToken,
        reason,
      });
    }
  }

  private readStringField(payload: unknown, key: string): string | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const value = (payload as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  }

  private readBooleanField(payload: unknown, key: string): boolean | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const value = (payload as Record<string, unknown>)[key];
    return typeof value === "boolean" ? value : undefined;
  }
}
