export type AgentLoopEvent =
  | AgentLoopStartedEvent
  | AgentLoopResumedEvent
  | AgentLoopTurnContextEvent
  | AgentLoopModelRequestEvent
  | AgentLoopAssistantMessageEvent
  | AgentLoopApprovalRequestEvent
  | AgentLoopToolCallStartedEvent
  | AgentLoopToolCallFinishedEvent
  | AgentLoopPlanUpdateEvent
  | AgentLoopApprovalEvent
  | AgentLoopContextCompactionEvent
  | AgentLoopFinalEvent
  | AgentLoopStoppedEvent;

export interface AgentLoopBaseEvent {
  type: string;
  eventId: string;
  sessionId: string;
  traceId: string;
  turnId: string;
  goalId: string;
  taskId?: string;
  createdAt: string;
}

export interface AgentLoopStartedEvent extends AgentLoopBaseEvent {
  type: "started";
}

export interface AgentLoopResumedEvent extends AgentLoopBaseEvent {
  type: "resumed";
  fromUpdatedAt: string;
  restoredMessages: number;
}

export interface AgentLoopTurnContextEvent extends AgentLoopBaseEvent {
  type: "turn_context";
  cwd: string;
  model: string;
  visibleTools: string[];
}

export interface AgentLoopModelRequestEvent extends AgentLoopBaseEvent {
  type: "model_request";
  model: string;
  toolCount: number;
}

export interface AgentLoopAssistantMessageEvent extends AgentLoopBaseEvent {
  type: "assistant_message";
  phase: "commentary" | "final_candidate";
  contentPreview: string;
  toolCallCount: number;
}

export interface AgentLoopApprovalRequestEvent extends AgentLoopBaseEvent {
  type: "approval_request";
  callId: string;
  toolName: string;
  reason: string;
  permissionLevel: string;
  isDestructive: boolean;
}

export interface AgentLoopToolCallStartedEvent extends AgentLoopBaseEvent {
  type: "tool_call_started";
  callId: string;
  toolName: string;
  inputPreview: string;
}

export interface AgentLoopToolCallFinishedEvent extends AgentLoopBaseEvent {
  type: "tool_call_finished";
  callId: string;
  toolName: string;
  success: boolean;
  disposition?: "respond_to_model" | "fatal" | "approval_denied" | "cancelled";
  outputPreview: string;
  durationMs: number;
  artifacts?: string[];
  truncated?: {
    originalChars: number;
    overflowPath?: string;
  };
}

export interface AgentLoopPlanUpdateEvent extends AgentLoopBaseEvent {
  type: "plan_update";
  summary: string;
}

export interface AgentLoopApprovalEvent extends AgentLoopBaseEvent {
  type: "approval";
  toolName: string;
  status: "denied";
  reason: string;
}

export interface AgentLoopContextCompactionEvent extends AgentLoopBaseEvent {
  type: "context_compaction";
  phase: "pre_turn" | "mid_turn" | "standalone_turn";
  reason: "context_limit" | "model_downshift" | "manual";
  inputMessages: number;
  outputMessages: number;
  summaryPreview: string;
}

export interface AgentLoopFinalEvent extends AgentLoopBaseEvent {
  type: "final";
  success: boolean;
  outputPreview: string;
}

export interface AgentLoopStoppedEvent extends AgentLoopBaseEvent {
  type: "stopped";
  reason: string;
}

export interface AgentLoopEventSink {
  emit(event: AgentLoopEvent): void | Promise<void>;
}

export class NoopAgentLoopEventSink implements AgentLoopEventSink {
  emit(_event: AgentLoopEvent): void {
    // no-op
  }
}
