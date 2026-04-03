// ─── ChatRunner ───
//
// Central coordinator for 1-shot chat execution (Tier 1).
// Bypasses TaskLifecycle — calls adapter.execute() directly.

import { execFile } from "node:child_process";
import type { StateManager } from "../state/state-manager.js";
import type { IAdapter, AgentTask } from "../execution/adapter-layer.js";
import type { ILLMClient } from "../llm/llm-client.js";
import { ChatHistory } from "./chat-history.js";
import { buildChatContext, resolveGitRoot } from "../observation/context-provider.js";
import type { EscalationHandler } from "./escalation.js";
import { buildSystemPrompt } from "./grounding.js";
import { verifyChatAction } from "./chat-verifier.js";
import { getSelfKnowledgeToolDefinitions, handleSelfKnowledgeToolCall } from "./self-knowledge-tools.js";
import type { SelfKnowledgeDeps } from "./self-knowledge-tools.js";
import { getMutationToolDefinitions, handleMutationToolCall } from "./self-knowledge-mutation-tools.js";
import type { MutationToolDeps, ApprovalLevel } from "./self-knowledge-mutation-tools.js";
import type { TrustManager } from "../traits/trust-manager.js";
import type { PluginLoader } from "../runtime/plugin-loader.js";
import type { LLMMessage, LLMResponse } from "../llm/llm-client.js";

// ─── Types ───

export interface ChatRunnerDeps {
  stateManager: StateManager;
  adapter: IAdapter;
  /** Optional: reserved for future escalation support (Phase 1c). */
  llmClient?: ILLMClient;
  /** Optional: escalation handler for /track command (Phase 1c). */
  escalationHandler?: EscalationHandler;
  /** Optional: trust manager for self-knowledge tools and mutations. */
  trustManager?: TrustManager | { getBalance(domain: string): Promise<{ balance: number }> };
  /** Optional: plugin loader for self-knowledge tools and mutations. */
  pluginLoader?: PluginLoader | { loadAll(): Promise<Array<{ name: string; type?: string; enabled?: boolean }>> };
  /** Optional: approval handler for mutation tools. */
  approvalFn?: (description: string) => Promise<boolean>;
  /** Optional: per-tool approval level overrides. */
  approvalConfig?: Record<string, ApprovalLevel>;
}

export interface ChatRunResult {
  success: boolean;
  output: string;
  elapsed_ms: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_VERIFY_RETRIES = 2;
const MAX_TOOL_LOOPS = 5;

// ─── Command help text ───

const COMMAND_HELP = `Available commands:
  /help    Show this help message
  /clear   Clear conversation history
  /exit    Exit chat mode
  /track   Promote session to Tier 2 goal pursuit (not yet implemented)`;

// ─── Helpers ───

function checkGitChanges(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["diff", "HEAD", "--stat"], { cwd, timeout: 5_000 }, (err, stdout, stderr) => {
      resolve(err ? null : (stdout + stderr).trim());
    });
  });
}

// ─── ChatRunner ───

export class ChatRunner {
  private readonly deps: ChatRunnerDeps;
  private history: ChatHistory | null = null;
  private sessionCwd: string | null = null;
  /** True when startSession() has been called — enables session persistence across execute() calls. */
  private sessionActive = false;
  /** Cached system prompt — built once per session, reused across turns. */
  private cachedSystemPrompt: string | null = null;

  constructor(deps: ChatRunnerDeps) {
    this.deps = deps;
  }

  /**
   * Initialize a persistent session for interactive (multi-turn) mode.
   * Must be called before the first execute() to share history across turns.
   * If not called, execute() auto-creates a new session per call (Phase 1a behavior).
   */
  startSession(cwd: string): void {
    const gitRoot = resolveGitRoot(cwd);
    const sessionId = crypto.randomUUID();
    this.history = new ChatHistory(this.deps.stateManager, sessionId, gitRoot);
    this.sessionCwd = gitRoot;
    this.sessionActive = true;
  }

  private async handleCommand(input: string): Promise<ChatRunResult | null> {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return null;

    const cmd = trimmed.toLowerCase().split(/\s+/)[0];
    const start = Date.now();

    if (cmd === "/help") {
      return { success: true, output: COMMAND_HELP, elapsed_ms: Date.now() - start };
    }
    if (cmd === "/clear") {
      this.history?.clear();
      return { success: true, output: "Conversation history cleared.", elapsed_ms: Date.now() - start };
    }
    if (cmd === "/exit") {
      return { success: true, output: "Exiting chat mode.", elapsed_ms: Date.now() - start };
    }
    if (cmd === "/track") {
      return this.handleTrack(start);
    }

    return {
      success: false,
      output: `Unknown command: ${input.trim()}. Type /help for available commands.`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleTrack(start: number): Promise<ChatRunResult> {
    if (!this.deps.escalationHandler) {
      return {
        success: false,
        output: "Escalation not available — missing LLM configuration",
        elapsed_ms: Date.now() - start,
      };
    }
    if (!this.history || this.history.getMessages().length === 0) {
      return {
        success: false,
        output: "No conversation to escalate. Chat first, then /track.",
        elapsed_ms: Date.now() - start,
      };
    }
    try {
      const result = await this.deps.escalationHandler.escalateToGoal(this.history);
      return {
        success: true,
        output: `Goal created: ${result.title} (ID: ${result.goalId})\nRun: pulseed run --goal ${result.goalId} --yes`,
        elapsed_ms: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Escalation failed: ${message}`,
        elapsed_ms: Date.now() - start,
      };
    }
  }

  /**
   * Execute a single chat turn.
   *
   * Flow:
   *  1. Intercept slash commands before adapter dispatch
   *  2. Resolve git root → create ChatHistory
   *  3. Build chat context and assemble prompt
   *  4. Persist user message BEFORE calling adapter (crash-safe)
   *  5. Execute via adapter
   *  6. Verify changes (git diff + tests); retry up to MAX_VERIFY_RETRIES if tests fail
   *  7. Persist assistant response (fire-and-forget)
   */
  async execute(input: string, cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ChatRunResult> {
    // Intercept commands before any adapter call
    const commandResult = await this.handleCommand(input);
    if (commandResult !== null) {
      return commandResult;
    }

    // Reuse session (interactive mode) or create a fresh one per call (1-shot mode)
    if (!this.sessionActive) {
      const gitRoot = resolveGitRoot(cwd);
      const sessionId = crypto.randomUUID();
      this.history = new ChatHistory(this.deps.stateManager, sessionId, gitRoot);
    }
    const gitRoot = this.sessionCwd ?? resolveGitRoot(cwd);

    // history is always assigned by this point (either by startSession or the block above)
    const history = this.history!;

    // Persist-before-execute: user message written to disk first
    await history.appendUserMessage(input);

    // Build grounding system prompt on first turn, cache for session
    if (this.cachedSystemPrompt === null) {
      try {
        this.cachedSystemPrompt = await buildSystemPrompt({ stateManager: this.deps.stateManager });
      } catch {
        this.cachedSystemPrompt = "";
      }
    }

    // Build conversation history from prior turns (last 10)
    const messages = history.getMessages();
    const priorTurns = messages.slice(0, -1).slice(-10);
    let historyBlock = "";
    if (priorTurns.length > 0) {
      const lines = priorTurns.map((m: { role: string; content: string }) =>
        `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
      ).join("\n");
      historyBlock = `Previous conversation:\n${lines}\n\nCurrent message:\n`;
    }

    const context = await buildChatContext(input, gitRoot);
    const basePrompt = context ? `${context}\n\n${input}` : input;
    const prompt = historyBlock ? `${historyBlock}${basePrompt}` : basePrompt;

    const start = Date.now();

    // Use llmClient with self-knowledge tools when available (function calling path)
    if (this.deps.llmClient) {
      const toolResult = await this.executeWithTools(prompt, this.cachedSystemPrompt ?? undefined);
      const elapsed_ms = Date.now() - start;
      await history.appendAssistantMessage(toolResult);
      return { success: true, output: toolResult, elapsed_ms };
    }

    const task: AgentTask = {
      prompt,
      timeout_ms: timeoutMs,
      adapter_type: this.deps.adapter.adapterType,
      cwd,
      ...(this.cachedSystemPrompt ? { system_prompt: this.cachedSystemPrompt } : {}),
    };
    let result = await this.deps.adapter.execute(task);
    const elapsed_ms = Date.now() - start;

    // Verification loop: check if git has uncommitted changes; if so, run tests
    const gitChanges = await checkGitChanges(gitRoot);
    if (gitChanges !== null && gitChanges !== "") {
      let retries = 0;
      let verification = await verifyChatAction(gitRoot);

      while (!verification.passed && retries < MAX_VERIFY_RETRIES) {
        retries++;
        const retryPrompt = `The previous changes caused test failures. Please fix them.\n\nTest output:\n${verification.testOutput ?? verification.errors.join("\n")}`;
        const retryTask: AgentTask = { ...task, prompt: retryPrompt };
        result = await this.deps.adapter.execute(retryTask);
        verification = await verifyChatAction(gitRoot);
      }

      if (!verification.passed) {
        // Fire-and-forget: persist assistant response
        history.appendAssistantMessage(result.output);
        return {
          success: false,
          output: `Changes applied but tests are still failing after ${MAX_VERIFY_RETRIES} retries. Please intervene manually.\n\nTest output:\n${verification.testOutput ?? verification.errors.join("\n")}`,
          elapsed_ms: Date.now() - start,
        };
      }
    }

    // Fire-and-forget: persist assistant response after completion
    history.appendAssistantMessage(result.output);

    return {
      success: result.success,
      output: result.output,
      elapsed_ms,
    };
  }

  /**
   * Execute a chat turn using llmClient with self-knowledge tools (function calling).
   * Loops up to MAX_TOOL_LOOPS times to resolve tool calls, then returns final text.
   */
  private async executeWithTools(prompt: string, systemPrompt?: string): Promise<string> {
    const llmClient = this.deps.llmClient!;
    const tools = [...getSelfKnowledgeToolDefinitions(), ...getMutationToolDefinitions()];
    const skDeps = this.buildSelfKnowledgeDeps();
    const mutDeps = this.buildMutationToolDeps();
    const messages: LLMMessage[] = [{ role: "user", content: prompt }];
    const mutationToolNames = new Set([
      "set_goal", "update_goal", "archive_goal", "delete_goal",
      "toggle_plugin", "update_config", "reset_trust",
    ]);

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      let response: LLMResponse;
      try {
        response = await llmClient.sendMessage(messages, {
          tools,
          ...(systemPrompt ? { system: systemPrompt } : {}),
        });
      } catch {
        return "Sorry, I encountered an error processing your request.";
      }

      // No tool calls — return the text content
      if (!response.tool_calls || response.tool_calls.length === 0) {
        return response.content || "(no response)";
      }

      // Append assistant message, then process tool calls
      messages.push({ role: "assistant", content: response.content || "" });

      for (const tc of response.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          // ignore parse errors, use empty args
        }
        const toolResult = mutationToolNames.has(tc.function.name)
          ? await handleMutationToolCall(tc.function.name, args, mutDeps)
          : await handleSelfKnowledgeToolCall(tc.function.name, args, skDeps);
        messages.push({ role: "user", content: `Tool result for ${tc.function.name}:\n${toolResult}` });
      }
    }

    // Max loops reached — return last assistant content or fallback
    const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
    return lastAssistant?.content || "I was unable to complete the request within the allowed tool call limit.";
  }

  /** Build SelfKnowledgeDeps from ChatRunnerDeps. */
  private buildSelfKnowledgeDeps(): SelfKnowledgeDeps {
    return {
      stateManager: this.deps.stateManager,
      trustManager: this.deps.trustManager,
      pluginLoader: this.deps.pluginLoader as SelfKnowledgeDeps["pluginLoader"],
      homeDir: process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
    };
  }

  /** Build MutationToolDeps from ChatRunnerDeps. */
  private buildMutationToolDeps(): MutationToolDeps {
    const tm = this.deps.trustManager;
    const pl = this.deps.pluginLoader;
    return {
      stateManager: this.deps.stateManager,
      trustManager: tm && "setOverride" in tm ? (tm as TrustManager) : undefined,
      pluginLoader: pl && "getPluginState" in pl && "updatePluginState" in pl
        ? (pl as PluginLoader)
        : undefined,
      approvalFn: this.deps.approvalFn,
      approvalConfig: this.deps.approvalConfig,
    };
  }
}
