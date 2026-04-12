import type { AgentLoopStopReason } from "./agent-loop-budget.js";

export type AgentLoopCommandResultCategory = "verification" | "observation" | "other";

export interface AgentLoopCommandResult {
  toolName: string;
  command: string;
  cwd: string;
  success: boolean;
  category: AgentLoopCommandResultCategory;
  evidenceEligible: boolean;
  relevantToTask?: boolean;
  outputSummary: string;
  durationMs: number;
}

export interface AgentLoopWorkspaceInfo {
  requestedCwd: string;
  executionCwd: string;
  isolated: boolean;
  cleanupStatus?: "not_requested" | "cleaned_up" | "kept";
  cleanupReason?: string;
}

export interface AgentLoopResult<TOutput> {
  success: boolean;
  output: TOutput | null;
  finalText: string;
  stopReason: AgentLoopStopReason;
  elapsedMs: number;
  modelTurns: number;
  toolCalls: number;
  compactions: number;
  filesChanged?: boolean;
  changedFiles: string[];
  commandResults: AgentLoopCommandResult[];
  workspace?: AgentLoopWorkspaceInfo;
  traceId: string;
  sessionId: string;
  turnId: string;
}

export interface AgentLoopCompletionValidationResult {
  ok: boolean;
  reasons: string[];
}
