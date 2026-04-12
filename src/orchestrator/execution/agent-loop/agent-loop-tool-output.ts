import type { ToolResult } from "../../../tools/types.js";

export type AgentLoopToolDisposition =
  | "respond_to_model"
  | "fatal"
  | "approval_denied"
  | "cancelled";

export interface AgentLoopToolOutput {
  callId: string;
  toolName: string;
  success: boolean;
  content: string;
  durationMs: number;
  disposition?: AgentLoopToolDisposition;
  contextModifier?: string;
  rawResult?: ToolResult;
  command?: string;
  cwd?: string;
  artifacts?: string[];
  truncated?: {
    originalChars: number;
    overflowPath?: string;
  };
  fatal?: boolean;
}
