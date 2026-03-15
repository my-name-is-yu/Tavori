// ─── ClaudeAPIAdapter ───
//
// IAdapter implementation that wraps ILLMClient.sendMessage().
// Intended for tasks where a single LLM call is sufficient.
// Timeout is handled via Promise.race().

import type { IAdapter, AgentTask, AgentResult } from "../adapter-layer.js";
import type { ILLMClient } from "../llm-client.js";

export class ClaudeAPIAdapter implements IAdapter {
  readonly adapterType = "claude_api";
  readonly capabilities = ["text_generation", "analysis", "planning"] as const;

  private readonly llmClient: ILLMClient;

  constructor(llmClient: ILLMClient) {
    this.llmClient = llmClient;
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const startedAt = Date.now();

    // Build a timeout promise that resolves to a timeout AgentResult.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise: Promise<AgentResult> = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve({
          success: false,
          output: "",
          error: `Timed out after ${task.timeout_ms}ms`,
          exit_code: null,
          elapsed_ms: Date.now() - startedAt,
          stopped_reason: "timeout",
        });
      }, task.timeout_ms);
    });

    // The actual LLM call.
    const llmPromise: Promise<AgentResult> = (async () => {
      try {
        const response = await this.llmClient.sendMessage([
          { role: "user", content: task.prompt },
        ]);
        return {
          success: true,
          output: response.content,
          error: null,
          exit_code: null,
          elapsed_ms: Date.now() - startedAt,
          stopped_reason: "completed" as const,
        };
      } catch (err) {
        return {
          success: false,
          output: "",
          error: err instanceof Error ? err.message : String(err),
          exit_code: null,
          elapsed_ms: Date.now() - startedAt,
          stopped_reason: "error" as const,
        };
      }
    })();

    const result = await Promise.race([llmPromise, timeoutPromise]);

    // Clear the timeout once a result is determined.
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }

    return result;
  }
}
