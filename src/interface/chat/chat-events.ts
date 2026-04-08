export interface ChatEventBase {
  runId: string;
  turnId: string;
  createdAt: string;
}

export interface LifecycleStartEvent extends ChatEventBase {
  type: "lifecycle_start";
  input: string;
}

export interface AssistantDeltaEvent extends ChatEventBase {
  type: "assistant_delta";
  delta: string;
  text: string;
}

export interface AssistantFinalEvent extends ChatEventBase {
  type: "assistant_final";
  text: string;
  persisted: boolean;
}

export interface ToolStartEvent extends ChatEventBase {
  type: "tool_start";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolUpdateEvent extends ChatEventBase {
  type: "tool_update";
  toolCallId: string;
  toolName: string;
  status: "awaiting_approval" | "running" | "result";
  message: string;
}

export interface ToolEndEvent extends ChatEventBase {
  type: "tool_end";
  toolCallId: string;
  toolName: string;
  success: boolean;
  summary: string;
  durationMs: number;
}

export interface LifecycleEndEvent extends ChatEventBase {
  type: "lifecycle_end";
  status: "completed" | "error";
  elapsedMs: number;
  persisted: boolean;
}

export interface LifecycleErrorEvent extends ChatEventBase {
  type: "lifecycle_error";
  error: string;
  partialText: string;
  persisted: false;
}

export type ChatEvent =
  | LifecycleStartEvent
  | AssistantDeltaEvent
  | AssistantFinalEvent
  | ToolStartEvent
  | ToolUpdateEvent
  | ToolEndEvent
  | LifecycleEndEvent
  | LifecycleErrorEvent;

export type ChatEventHandler = (event: ChatEvent) => Promise<void> | void;

export interface ChatEventContext {
  runId: string;
  turnId: string;
}
