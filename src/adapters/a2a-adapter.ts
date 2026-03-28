// ─── A2AAdapter ───
//
// IAdapter implementation for the Google A2A (Agent-to-Agent) Protocol v0.3.
// Wraps A2AClient for network I/O and maps between PulSeed's AgentTask/AgentResult
// and A2A's Message/Task types. Supports both polling and SSE streaming.

import { randomUUID } from "node:crypto";
import type {
  IAdapter,
  AgentTask,
  AgentResult,
} from "../execution/adapter-layer.js";
import { A2AClient } from "./a2a-client.js";
import type { A2AClientConfig } from "./a2a-client.js";
import type { A2AAgentCard, A2ATask, A2AMessage } from "../types/a2a.js";
import { A2A_TERMINAL_STATES } from "../types/a2a.js";

// ─── Config ───

export interface A2AAdapterConfig extends A2AClientConfig {
  /**
   * Adapter type string registered in AdapterRegistry.
   * Default: "a2a". Override to register multiple A2A agents
   * (e.g., "a2a_research_agent", "a2a_code_agent").
   */
  adapterType?: string;
  /**
   * Override capabilities instead of deriving from Agent Card skills.
   * If not set, capabilities are fetched from the Agent Card on first use.
   */
  capabilities?: string[];
  /**
   * Prefer SSE streaming over polling. Default: true.
   * Falls back to polling if the agent does not advertise streaming support.
   */
  preferStreaming?: boolean;
  /**
   * Context ID for multi-turn conversations. If set, all tasks sent through
   * this adapter share the same A2A conversation context.
   */
  contextId?: string;
}

// ─── Adapter ───

export class A2AAdapter implements IAdapter {
  readonly adapterType: string;

  private readonly client: A2AClient;
  private readonly preferStreaming: boolean;
  private readonly contextId?: string;
  private resolvedCapabilities: string[] | null;
  private agentCard: A2AAgentCard | null = null;

  constructor(config: A2AAdapterConfig) {
    this.adapterType = config.adapterType ?? "a2a";
    this.client = new A2AClient(config);
    this.preferStreaming = config.preferStreaming ?? true;
    this.contextId = config.contextId;
    this.resolvedCapabilities = config.capabilities ?? null;
  }

  get capabilities(): readonly string[] {
    return this.resolvedCapabilities ?? ["general_purpose"];
  }

  /**
   * Fetch Agent Card and derive capabilities from skills.
   * Called lazily on first execute() if capabilities were not provided in config.
   * Safe to call multiple times (cached).
   */
  async discoverCapabilities(): Promise<void> {
    if (this.agentCard) return;
    try {
      this.agentCard = await this.client.fetchAgentCard();
      if (!this.resolvedCapabilities && this.agentCard.skills?.length) {
        this.resolvedCapabilities = this.agentCard.skills.flatMap(
          (s) => s.tags ?? [s.id]
        );
      }
    } catch {
      // Agent Card not available — continue with default capabilities
    }
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const startedAt = Date.now();

    // Lazy capability discovery
    if (!this.agentCard) {
      await this.discoverCapabilities();
    }

    // Build A2A message from PulSeed's prompt
    const message: A2AMessage = {
      role: "user",
      parts: [{ kind: "text", text: task.prompt }],
      messageId: randomUUID(),
      ...(this.contextId ? { contextId: this.contextId } : {}),
    };

    // Timeout via AbortController
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      task.timeout_ms
    );

    try {
      let a2aTask: A2ATask;

      const supportsStreaming =
        this.preferStreaming &&
        this.agentCard?.capabilities?.streaming === true;

      if (supportsStreaming) {
        // ── SSE streaming path ──
        a2aTask = await this.client.sendMessageStream(
          message,
          undefined, // onStatus callback — not needed for basic adapter
          controller.signal
        );
      } else {
        // ── Polling path ──
        const initial = await this.client.sendMessage(message);

        if (A2A_TERMINAL_STATES.has(initial.status.state)) {
          a2aTask = initial;
        } else {
          a2aTask = await this.client.waitForCompletion(
            initial.id,
            controller.signal
          );
        }
      }

      clearTimeout(timeoutHandle);
      return this.mapTaskToResult(a2aTask, startedAt);
    } catch (err) {
      clearTimeout(timeoutHandle);
      const elapsed = Date.now() - startedAt;
      const errMessage = err instanceof Error ? err.message : String(err);

      // Distinguish timeout from other errors
      if (
        controller.signal.aborted ||
        errMessage.includes("did not complete within")
      ) {
        return {
          success: false,
          output: "",
          error: `Timed out after ${task.timeout_ms}ms`,
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "timeout",
        };
      }

      return {
        success: false,
        output: "",
        error: errMessage,
        exit_code: null,
        elapsed_ms: elapsed,
        stopped_reason: "error",
      };
    }
  }

  // ─── Private: map A2A Task to PulSeed AgentResult ───

  private mapTaskToResult(task: A2ATask, startedAt: number): AgentResult {
    const elapsed = Date.now() - startedAt;

    // Extract text output from artifacts
    const output = this.extractTextOutput(task);

    switch (task.status.state) {
      case "completed":
        return {
          success: true,
          output,
          error: null,
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "completed",
        };

      case "failed":
        return {
          success: false,
          output,
          error: task.status.message ?? "A2A task failed",
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "error",
        };

      case "canceled":
        return {
          success: false,
          output,
          error: "A2A task was canceled",
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "timeout", // closest mapping
        };

      case "rejected":
        return {
          success: false,
          output,
          error:
            task.status.message ??
            "A2A task was rejected by the remote agent",
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "error",
        };

      case "input-required":
      case "auth-required":
        return {
          success: false,
          output,
          error:
            `A2A task requires ${task.status.state}: ${task.status.message ?? "no details"}. ` +
            "PulSeed does not support interactive input through adapters.",
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "error",
        };

      default:
        // Should not reach here after waitForCompletion, but handle gracefully
        return {
          success: false,
          output,
          error: `A2A task in unexpected state: ${task.status.state}`,
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "error",
        };
    }
  }

  /**
   * Extract text content from A2A artifacts and history.
   * Concatenates all text parts from artifacts (preferred) or last agent message.
   */
  private extractTextOutput(task: A2ATask): string {
    // Prefer artifacts
    if (task.artifacts?.length) {
      const texts: string[] = [];
      for (const artifact of task.artifacts) {
        for (const part of artifact.parts) {
          if (part.kind === "text") {
            texts.push(part.text);
          }
        }
      }
      if (texts.length > 0) return texts.join("\n");
    }

    // Fallback: last agent message in history
    if (task.history?.length) {
      const agentMessages = task.history.filter((m) => m.role === "agent");
      const last = agentMessages[agentMessages.length - 1];
      if (last) {
        const texts: string[] = [];
        for (const part of last.parts) {
          if (part.kind === "text") {
            texts.push(part.text);
          }
        }
        if (texts.length > 0) return texts.join("\n");
      }
    }

    return "";
  }
}
