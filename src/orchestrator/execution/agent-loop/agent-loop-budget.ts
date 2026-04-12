export interface AgentLoopBudget {
  maxModelTurns: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  maxConsecutiveToolErrors: number;
  maxRepeatedToolCalls: number;
  maxSchemaRepairAttempts: number;
  maxCompletionValidationAttempts: number;
  autoCompactTokenLimit?: number;
  maxCompactions: number;
  compactionMaxMessages: number;
}

export const defaultAgentLoopBudget: AgentLoopBudget = {
  maxModelTurns: 12,
  maxToolCalls: 40,
  maxWallClockMs: 10 * 60 * 1000,
  maxConsecutiveToolErrors: 3,
  maxRepeatedToolCalls: 4,
  maxSchemaRepairAttempts: 2,
  maxCompletionValidationAttempts: 2,
  maxCompactions: 3,
  compactionMaxMessages: 8,
};

export type AgentLoopStopReason =
  | "completed"
  | "timeout"
  | "max_model_turns"
  | "max_tool_calls"
  | "consecutive_tool_errors"
  | "stalled_tool_loop"
  | "schema_error"
  | "model_without_tool_calling"
  | "cancelled"
  | "protocol_incomplete"
  | "completion_gate_failed"
  | "fatal_error";
