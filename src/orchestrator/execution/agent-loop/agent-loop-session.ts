import { randomUUID } from "node:crypto";
import type { AgentLoopEventSink } from "./agent-loop-events.js";
import { NoopAgentLoopEventSink } from "./agent-loop-events.js";
import type { AgentLoopTraceStore } from "./agent-loop-trace-store.js";
import { InMemoryAgentLoopTraceStore } from "./agent-loop-trace-store.js";
import type { AgentLoopSessionStateStore } from "./agent-loop-session-state.js";
import { InMemoryAgentLoopSessionStateStore } from "./agent-loop-session-state.js";

export interface AgentLoopSession {
  sessionId: string;
  parentSessionId?: string;
  traceId: string;
  createdAt: string;
  eventSink: AgentLoopEventSink;
  traceStore: AgentLoopTraceStore;
  stateStore: AgentLoopSessionStateStore;
}

export function createAgentLoopSession(input: {
  sessionId?: string;
  parentSessionId?: string;
  traceId?: string;
  eventSink?: AgentLoopEventSink;
  traceStore?: AgentLoopTraceStore;
  stateStore?: AgentLoopSessionStateStore;
} = {}): AgentLoopSession {
  return {
    sessionId: input.sessionId ?? randomUUID(),
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    traceId: input.traceId ?? randomUUID(),
    createdAt: new Date().toISOString(),
    eventSink: input.eventSink ?? new NoopAgentLoopEventSink(),
    traceStore: input.traceStore ?? new InMemoryAgentLoopTraceStore(),
    stateStore: input.stateStore ?? new InMemoryAgentLoopSessionStateStore(),
  };
}
