import type { ChatEvent } from "./chat-events.js";

export interface StreamChatMessage {
  id: string;
  role: "user" | "pulseed";
  text: string;
  timestamp: Date;
  messageType?: "info" | "error" | "warning" | "success";
}

function upsertMessage(
  messages: StreamChatMessage[],
  nextMessage: StreamChatMessage,
  maxMessages: number
): StreamChatMessage[] {
  const next = [...messages];
  const index = next.findIndex((message) => message.id === nextMessage.id);
  if (index >= 0) {
    next[index] = nextMessage;
    return next;
  }
  return [...next, nextMessage].slice(-maxMessages);
}

function toolMessageType(success: boolean): StreamChatMessage["messageType"] {
  return success ? "info" : "error";
}

export function applyChatEventToMessages(
  messages: StreamChatMessage[],
  event: ChatEvent,
  maxMessages: number
): StreamChatMessage[] {
  const timestamp = new Date(event.createdAt);

  if (event.type === "assistant_delta") {
    return upsertMessage(messages, {
      id: event.turnId,
      role: "pulseed",
      text: event.text,
      timestamp,
      messageType: "info",
    }, maxMessages);
  }

  if (event.type === "assistant_final") {
    return upsertMessage(messages, {
      id: event.turnId,
      role: "pulseed",
      text: event.text,
      timestamp,
      messageType: event.persisted ? "info" : "warning",
    }, maxMessages);
  }

  if (event.type === "lifecycle_error") {
    const messageId = event.partialText ? event.turnId : `error:${event.runId}`;
    const text = event.partialText
      ? `${event.partialText}\n\n[interrupted: ${event.error}]`
      : `Error: ${event.error}`;
    return upsertMessage(messages, {
      id: messageId,
      role: "pulseed",
      text,
      timestamp,
      messageType: "error",
    }, maxMessages);
  }

  if (event.type === "tool_start") {
    return upsertMessage(messages, {
      id: `tool:${event.toolCallId}`,
      role: "pulseed",
      text: `[tool:${event.toolName}] started`,
      timestamp,
      messageType: "info",
    }, maxMessages);
  }

  if (event.type === "tool_update") {
    return upsertMessage(messages, {
      id: `tool:${event.toolCallId}`,
      role: "pulseed",
      text: `[tool:${event.toolName}] ${event.status}: ${event.message}`,
      timestamp,
      messageType: event.status === "awaiting_approval" ? "warning" : "info",
    }, maxMessages);
  }

  if (event.type === "tool_end") {
    return upsertMessage(messages, {
      id: `tool:${event.toolCallId}`,
      role: "pulseed",
      text: `[tool:${event.toolName}] ${event.success ? "done" : "failed"}: ${event.summary}`,
      timestamp,
      messageType: toolMessageType(event.success),
    }, maxMessages);
  }

  return messages;
}
