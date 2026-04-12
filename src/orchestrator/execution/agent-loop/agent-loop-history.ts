import type { AgentLoopMessage } from "./agent-loop-model.js";

export interface AgentLoopHistory {
  messages: AgentLoopMessage[];
  compacted: boolean;
}

export function createAgentLoopHistory(messages: AgentLoopMessage[] = []): AgentLoopHistory {
  return { messages: [...messages], compacted: false };
}

export function appendAgentLoopHistory(history: AgentLoopHistory, messages: AgentLoopMessage[]): AgentLoopHistory {
  return { ...history, messages: [...history.messages, ...messages] };
}
