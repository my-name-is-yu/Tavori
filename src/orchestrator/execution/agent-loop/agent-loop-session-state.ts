import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentLoopStopReason } from "./agent-loop-budget.js";
import type { AgentLoopMessage } from "./agent-loop-model.js";

export interface AgentLoopSessionState {
  sessionId: string;
  traceId: string;
  turnId: string;
  goalId: string;
  taskId?: string;
  cwd: string;
  modelRef: string;
  messages: AgentLoopMessage[];
  modelTurns: number;
  toolCalls: number;
  compactions: number;
  completionValidationAttempts: number;
  calledTools: string[];
  lastToolLoopSignature: string | null;
  repeatedToolLoopCount: number;
  finalText: string;
  status: "running" | "completed" | "failed";
  stopReason?: AgentLoopStopReason;
  updatedAt: string;
}

export interface AgentLoopSessionStateStore {
  load(): Promise<AgentLoopSessionState | null>;
  save(state: AgentLoopSessionState): Promise<void>;
}

export class InMemoryAgentLoopSessionStateStore implements AgentLoopSessionStateStore {
  private state: AgentLoopSessionState | null = null;

  async load(): Promise<AgentLoopSessionState | null> {
    return this.state ? { ...this.state, messages: [...this.state.messages], calledTools: [...this.state.calledTools] } : null;
  }

  async save(state: AgentLoopSessionState): Promise<void> {
    this.state = {
      ...state,
      messages: [...state.messages],
      calledTools: [...state.calledTools],
    };
  }
}

export class JsonAgentLoopSessionStateStore implements AgentLoopSessionStateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<AgentLoopSessionState | null> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      return JSON.parse(raw) as AgentLoopSessionState;
    } catch {
      return null;
    }
  }

  async save(state: AgentLoopSessionState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2), "utf-8");
  }
}
