import type { StateManager } from "../../base/state/state-manager.js";
import type { TriggerMapper } from "../trigger-mapper.js";
import type { ApprovalBroker, ApprovalRequiredEvent } from "../approval-broker.js";
import type { OutboxStore } from "../store/index.js";

export interface EventServerConfig {
  host?: string;
  port?: number;
  eventsDir?: string;
  stateManager?: StateManager;
  triggerMapper?: TriggerMapper;
  approvalBroker?: ApprovalBroker;
  outboxStore?: OutboxStore;
  eventFileMaxAttempts?: number;
  eventFileRetryDelayMs?: number;
}

export interface EventServerSnapshot {
  daemon: Record<string, unknown> | null;
  goals: Array<{ id: string; title: string; status: string; loop_status: string }>;
  approvals: ApprovalRequiredEvent[];
  active_workers: Array<Record<string, unknown>>;
  last_outbox_seq: number;
}

export type ActiveWorkersProvider = () =>
  | Array<Record<string, unknown>>
  | Promise<Array<Record<string, unknown>>>;
