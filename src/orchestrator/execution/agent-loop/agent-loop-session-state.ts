import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentLoopStopReason } from "./agent-loop-budget.js";
import type { AgentLoopMessage, AgentLoopMessagePhase, AgentLoopMessageRole, AgentLoopToolCall } from "./agent-loop-model.js";

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
      return normalizeAgentLoopSessionState(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async save(state: AgentLoopSessionState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2), "utf-8");
  }
}

export function normalizeAgentLoopSessionState(value: unknown): AgentLoopSessionState | null {
  if (!isRecord(value)) return null;

  const sessionId = stringField(value, "sessionId");
  const traceId = stringField(value, "traceId");
  const turnId = stringField(value, "turnId");
  const goalId = stringField(value, "goalId");
  const cwd = stringField(value, "cwd");
  const modelRef = stringField(value, "modelRef");
  if (!sessionId || !traceId || !turnId || !goalId || !cwd || !modelRef) return null;

  const rawMessages = Array.isArray(value["messages"]) ? value["messages"] : null;
  if (!rawMessages) return null;
  const messages = rawMessages.map(normalizeMessage).filter((message): message is AgentLoopMessage => message !== null);
  if (messages.length !== rawMessages.length) return null;

  return {
    sessionId,
    traceId,
    turnId,
    goalId,
    ...(typeof value["taskId"] === "string" ? { taskId: value["taskId"] } : {}),
    cwd,
    modelRef,
    messages,
    modelTurns: nonNegativeNumberField(value, "modelTurns"),
    toolCalls: nonNegativeNumberField(value, "toolCalls"),
    compactions: nonNegativeNumberField(value, "compactions"),
    completionValidationAttempts: nonNegativeNumberField(value, "completionValidationAttempts"),
    calledTools: stringArrayField(value, "calledTools"),
    lastToolLoopSignature: typeof value["lastToolLoopSignature"] === "string" ? value["lastToolLoopSignature"] : null,
    repeatedToolLoopCount: nonNegativeNumberField(value, "repeatedToolLoopCount"),
    finalText: typeof value["finalText"] === "string" ? value["finalText"] : "",
    status: statusField(value, "status"),
    ...(typeof value["stopReason"] === "string" ? { stopReason: value["stopReason"] as AgentLoopStopReason } : {}),
    updatedAt: typeof value["updatedAt"] === "string" ? value["updatedAt"] : new Date(0).toISOString(),
  };
}

function normalizeMessage(value: unknown): AgentLoopMessage | null {
  if (!isRecord(value)) return null;
  const role = roleField(value, "role");
  if (!role || typeof value["content"] !== "string") return null;
  const phase = phaseField(value, "phase");

  return {
    role,
    content: value["content"],
    ...(phase ? { phase } : {}),
    ...(typeof value["toolCallId"] === "string" ? { toolCallId: value["toolCallId"] } : {}),
    ...(typeof value["toolName"] === "string" ? { toolName: value["toolName"] } : {}),
    ...(Array.isArray(value["toolCalls"]) ? { toolCalls: value["toolCalls"].map(normalizeToolCall).filter((call): call is AgentLoopToolCall => call !== null) } : {}),
  };
}

function normalizeToolCall(value: unknown): AgentLoopToolCall | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id");
  const name = stringField(value, "name");
  if (!id || !name) return null;
  return { id, name, input: value["input"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: Record<string, unknown>, field: string): string | null {
  return typeof value[field] === "string" && value[field].trim().length > 0 ? value[field] : null;
}

function nonNegativeNumberField(value: Record<string, unknown>, field: string): number {
  const raw = value[field];
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

function stringArrayField(value: Record<string, unknown>, field: string): string[] {
  const raw = value[field];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

function roleField(value: Record<string, unknown>, field: string): AgentLoopMessageRole | null {
  const raw = value[field];
  return raw === "system" || raw === "user" || raw === "assistant" || raw === "tool" ? raw : null;
}

function phaseField(value: Record<string, unknown>, field: string): AgentLoopMessagePhase | null {
  const raw = value[field];
  return raw === "commentary" || raw === "final_answer" ? raw : null;
}

function statusField(value: Record<string, unknown>, field: string): AgentLoopSessionState["status"] {
  const raw = value[field];
  return raw === "completed" || raw === "failed" ? raw : "running";
}
