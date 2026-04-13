import { randomUUID } from "node:crypto";
import { RuntimeOperationStore } from "../store/runtime-operation-store.js";
import type {
  RuntimeControlActor,
  RuntimeControlOperation,
  RuntimeControlOperationKind,
  RuntimeControlOperationState,
  RuntimeControlReplyTarget,
} from "../store/runtime-operation-schemas.js";
import type { RuntimeControlIntent } from "./runtime-control-intent.js";

export interface RuntimeControlRequest {
  intent: RuntimeControlIntent;
  cwd: string;
  requestedBy?: RuntimeControlActor;
  replyTarget?: RuntimeControlReplyTarget;
  approvalFn?: (reason: string) => Promise<boolean>;
}

export interface RuntimeControlResult {
  success: boolean;
  message: string;
  operationId?: string;
  state?: RuntimeControlOperationState;
}

export interface RuntimeControlExecutorResult {
  ok: boolean;
  message?: string;
  state?: RuntimeControlOperationState;
}

export type RuntimeControlExecutor = (
  operation: RuntimeControlOperation,
  request: RuntimeControlRequest
) => Promise<RuntimeControlExecutorResult>;

export interface RuntimeControlServiceOptions {
  operationStore?: RuntimeOperationStore;
  runtimeRoot?: string;
  executor?: RuntimeControlExecutor;
  now?: () => Date;
}

export class RuntimeControlService {
  private readonly operationStore: RuntimeOperationStore;
  private readonly executor?: RuntimeControlExecutor;
  private readonly now: () => Date;

  constructor(options: RuntimeControlServiceOptions = {}) {
    this.operationStore = options.operationStore ?? new RuntimeOperationStore(options.runtimeRoot);
    this.executor = options.executor;
    this.now = options.now ?? (() => new Date());
  }

  async request(request: RuntimeControlRequest): Promise<RuntimeControlResult> {
    const requestedAt = this.nowIso();
    const operation: RuntimeControlOperation = {
      operation_id: randomUUID(),
      kind: request.intent.kind,
      state: "pending",
      requested_at: requestedAt,
      updated_at: requestedAt,
      requested_by: request.requestedBy ?? { surface: "chat" },
      reply_target: request.replyTarget ?? { surface: "chat" },
      reason: request.intent.reason,
      expected_health: expectedHealthFor(request.intent.kind),
    };

    await this.operationStore.save(operation);

    if (requiresApproval(operation.kind)) {
      if (!request.approvalFn) {
        const failed = await this.update(operation, "failed", {
          ok: false,
          message: "Runtime control requires approval, but no approval handler is configured.",
        });
        return {
          success: false,
          message: failed.result?.message ?? "Runtime control requires approval.",
          operationId: failed.operation_id,
          state: failed.state,
        };
      }

      let approved: boolean;
      try {
        approved = await request.approvalFn(approvalReason(operation.kind, operation.reason));
      } catch (err) {
        const failed = await this.update(operation, "failed", {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        });
        return {
          success: false,
          message: failed.result?.message ?? "Runtime control approval failed.",
          operationId: failed.operation_id,
          state: failed.state,
        };
      }

      if (!approved) {
        const cancelled = await this.update(operation, "cancelled", {
          ok: false,
          message: "Runtime control operation was not approved.",
        });
        return {
          success: false,
          message: cancelled.result?.message ?? "Runtime control operation was not approved.",
          operationId: cancelled.operation_id,
          state: cancelled.state,
        };
      }

      operation.state = "approved";
      operation.updated_at = this.nowIso();
      await this.operationStore.save(operation);
    }

    const acknowledged = await this.update(operation, "acknowledged", {
      ok: true,
      message: ackMessage(operation.kind),
    });

    if (!this.executor) {
      const failed = await this.update(acknowledged, "failed", {
        ok: false,
        message: "Runtime control executor is not configured; operation was recorded but not started.",
      });
      return {
        success: false,
        message: failed.result?.message ?? "Runtime control executor is not configured.",
        operationId: failed.operation_id,
        state: failed.state,
      };
    }

    let executed: RuntimeControlExecutorResult;
    try {
      executed = await this.executor(acknowledged, request);
    } catch (err) {
      const failed = await this.update(acknowledged, "failed", {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
      return {
        success: false,
        message: failed.result?.message ?? "Runtime control executor failed.",
        operationId: failed.operation_id,
        state: failed.state,
      };
    }

    const nextState = executed.state ?? (executed.ok ? "acknowledged" : "failed");
    const saved = await this.update(acknowledged, nextState, {
      ok: executed.ok,
      message: executed.message ?? ackMessage(operation.kind),
    });

    return {
      success: executed.ok,
      message: saved.result?.message ?? ackMessage(operation.kind),
      operationId: saved.operation_id,
      state: saved.state,
    };
  }

  private async update(
    operation: RuntimeControlOperation,
    state: RuntimeControlOperationState,
    result: { ok: boolean; message: string }
  ): Promise<RuntimeControlOperation> {
    const updated: RuntimeControlOperation = {
      ...operation,
      state,
      updated_at: this.nowIso(),
      result,
    };
    return this.operationStore.save(updated);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function requiresApproval(kind: RuntimeControlOperationKind): boolean {
  return kind === "restart_daemon" || kind === "restart_gateway" || kind === "self_update";
}

function expectedHealthFor(kind: RuntimeControlOperationKind): { daemon_ping: boolean; gateway_acceptance: boolean } {
  return {
    daemon_ping: kind !== "reload_config",
    gateway_acceptance: kind === "restart_gateway" || kind === "restart_daemon" || kind === "self_update",
  };
}

function approvalReason(kind: RuntimeControlOperationKind, reason: string): string {
  return `Runtime control ${kind}: ${reason}`;
}

function ackMessage(kind: RuntimeControlOperationKind): string {
  switch (kind) {
    case "restart_gateway":
      return "gateway の再起動を開始します。復帰後にこの会話へ結果を返します。";
    case "restart_daemon":
      return "PulSeed daemon の再起動を開始します。復帰後にこの会話へ結果を返します。";
    case "reload_config":
      return "runtime 設定の再読み込みを開始します。";
    case "self_update":
      return "PulSeed 自身の更新準備を開始します。実行前に内容を確認します。";
  }
}
