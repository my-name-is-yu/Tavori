import type { AgentTask, AgentResult, IAdapter } from "../../orchestrator/execution/adapter-layer.js";

export class NativeAgentLoopAdapter implements IAdapter {
  readonly adapterType = "agent_loop";
  readonly capabilities = [
    "general_purpose",
    "tool_calling",
    "native_agentloop",
  ] as const;

  async execute(_task: AgentTask): Promise<AgentResult> {
    return {
      success: false,
      output: "",
      error: "NativeAgentLoopAdapter is a selection marker. TaskLifecycle must execute via TaskAgentLoopRunner.",
      exit_code: null,
      elapsed_ms: 0,
      stopped_reason: "error",
    };
  }
}
