import path from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentLoopSession, type AgentLoopSession } from "./agent-loop-session.js";
import type { AgentLoopEventSink } from "./agent-loop-events.js";
import { JsonlAgentLoopTraceStore } from "./agent-loop-trace-store.js";
import { JsonAgentLoopSessionStateStore } from "./agent-loop-session-state.js";

export interface PersistentAgentLoopSessionFactoryOptions {
  traceBaseDir: string;
  kind: "task" | "chat";
}

export interface PersistentAgentLoopSessionInput {
  eventSink?: AgentLoopEventSink;
  parentSessionId?: string;
  resumeStatePath?: string;
  sessionId?: string;
  traceId?: string;
}

export function createPersistentAgentLoopSessionFactory(
  options: PersistentAgentLoopSessionFactoryOptions,
): (input?: PersistentAgentLoopSessionInput) => AgentLoopSession {
  return (input = {}) => {
    const sessionId = input.sessionId ?? randomUUID();
    const traceId = input.traceId ?? randomUUID();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tracePath = path.join(
      options.traceBaseDir,
      "traces",
      "agentloop",
      options.kind,
      `${timestamp}-${sessionId}.jsonl`,
    );
    const statePath = input.resumeStatePath
      ?? tracePath.replace(/\.jsonl$/, ".state.json");
    const traceStore = new JsonlAgentLoopTraceStore(tracePath);
    const stateStore = new JsonAgentLoopSessionStateStore(statePath);

    return createAgentLoopSession({
      sessionId,
      traceId,
      parentSessionId: input.parentSessionId,
      eventSink: input.eventSink,
      traceStore,
      stateStore,
    });
  };
}
